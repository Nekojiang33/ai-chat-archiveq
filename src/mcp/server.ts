import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import type { ArchiveConfig } from '../config.js';
import { openDb, type Db } from '../db/connection.js';
import { migrate } from '../db/schema.js';
import { createEmbedder } from '../search/embed.js';
import { getEntityContext, queryMemory, searchMessages, type FactHit, type MemoryHit } from '../search/hybrid.js';
import { invalidateSearchCaches } from '../search/cache.js';
import { runDistill, distillableCount } from '../memory/pipeline.js';
import { stableId } from '../importers/core.js';

/**
 * MCP 工具面：4 个正交工具，替代原先 7 个互相重叠的工具。
 *
 *   recall    检索对话 + 蒸馏记忆/事实（原 search_conversations / query_memory）
 *   entity    实体上下文，省略 name 即列表（原 get_context / list_entities）
 *   remember  写入手动记忆（原 add_memory）
 *   maintain  状态与蒸馏（原 archive_status / distill）
 *
 * 收益：工具 schema 数量减少 ~43%，模型选择成本下降；同一次 recall 里
 * 就能拿到"对话原文 + 记忆 + 事实"，减少多轮工具往返。
 */
export function createMcpServer(cfg: ArchiveConfig): { server: McpServer; db: Db } {
  const db = openDb(cfg.dbPath, cfg.password);
  migrate(db, cfg.embed.dim);
  const embedder = createEmbedder(cfg.embed);

  const server = new McpServer({ name: 'ai-chat-archive', version: '0.3.0' });
  const json = (v: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(v, null, 2) }] });

  const count = (sql: string): number => (db.prepare(sql).get() as { n: number }).n;

  server.registerTool(
    'recall',
    {
      description:
        '一次取回与查询相关的归档对话片段、蒸馏记忆与事实（关键词 + 拼音 + 语义向量三路融合）。' +
        '回答"我之前说过什么/我的偏好是什么/上次怎么决定的"时优先用它。',
      inputSchema: {
        query: z.string().describe('自然语言问题或关键词，支持中文、拼音、英文'),
        source: z.string().optional().describe('来源过滤：chatgpt | claude | claude-code | dsh（DeepSeek Harness）'),
        since: z.string().optional().describe('起始时间，ISO 8601'),
        until: z.string().optional().describe('结束时间，ISO 8601'),
        limit: z.number().int().min(1).max(50).default(8).describe('每类结果条数'),
        includeMemory: z.boolean().default(true).describe('是否同时返回蒸馏出的记忆与事实'),
      },
    },
    async (args) => {
      const messages = await searchMessages(db, embedder, args.query, {
        source: args.source,
        since: args.since,
        until: args.until,
        limit: args.limit,
      });
      let memories: MemoryHit[] = [];
      let facts: FactHit[] = [];
      if (args.includeMemory) {
        const m = await queryMemory(db, embedder, args.query, { limit: args.limit });
        memories = m.memories;
        facts = m.facts;
      }
      return json({ messages, memories, facts });
    }
  );

  server.registerTool(
    'entity',
    {
      description:
        '查看某个实体的完整上下文（相关事实 + 出现过的对话）；省略 name 时按提及次数列出实体（人/项目/工具/概念/偏好）。',
      inputSchema: {
        name: z.string().optional().describe('实体名称或别名；省略则列出实体'),
        type: z.string().optional().describe('列表模式下的类型过滤：person | project | tool | concept | preference'),
        limit: z.number().int().min(1).max(200).default(30).describe('列表模式返回条数'),
      },
    },
    async ({ name, type, limit }) => {
      if (name) {
        const ctx = getEntityContext(db, name);
        return json(ctx ?? { error: `未找到实体: ${name}` });
      }
      const rows = type
        ? db
            .prepare(`SELECT name, type, mention_count FROM entities WHERE type = ? ORDER BY mention_count DESC LIMIT ?`)
            .all(type, limit)
        : db.prepare(`SELECT name, type, mention_count FROM entities ORDER BY mention_count DESC LIMIT ?`).all(limit);
      return json({ entities: rows });
    }
  );

  server.registerTool(
    'remember',
    {
      description: '手动写入一条长期记忆（非对话来源的知识/偏好），立即向量化并可被 recall 检索到。',
      inputSchema: {
        content: z.string().describe('记忆内容'),
        layer: z.string().default('semantic').describe('记忆层：semantic | episodic | working'),
        tags: z.array(z.string()).optional().describe('标签'),
        importance: z.number().min(0).max(1).default(0.5).describe('重要度 0–1'),
      },
    },
    async ({ content, layer, tags, importance }) => {
      const id = stableId('memory', content);
      db.prepare(
        `INSERT OR REPLACE INTO memories (id, layer, content, tags, importance, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`
      ).run(id, layer, content, tags ? JSON.stringify(tags) : null, importance, Date.now());
      const [vec] = await embedder.embed([content]);
      db.prepare('INSERT OR REPLACE INTO memory_vec (memory_id, embedding) VALUES (?, ?)').run(id, JSON.stringify(vec));
      invalidateSearchCaches();
      return json({ ok: true, id });
    }
  );

  server.registerTool(
    'maintain',
    {
      description:
        '维护归档：action=status 返回统计；action=distill 对未蒸馏的会话增量蒸馏（LLM 抽取实体/事实/摘要，耗时较长）。',
      inputSchema: {
        action: z.enum(['status', 'distill']).default('status').describe('要执行的操作'),
        limit: z.number().int().min(1).max(20).default(5).describe('distill 时的会话数上限'),
      },
    },
    async ({ action, limit }) => {
      if (action === 'distill') return json(await runDistill(db, embedder, cfg.llm, { limit }));
      return json({
        conversations: count('SELECT COUNT(*) n FROM conversations'),
        messages: count('SELECT COUNT(*) n FROM messages'),
        embeddedMessages: count('SELECT COUNT(*) n FROM message_vec'),
        entities: count('SELECT COUNT(*) n FROM entities'),
        facts: count('SELECT COUNT(*) n FROM facts'),
        memories: count('SELECT COUNT(*) n FROM memories'),
        pendingDistill: distillableCount(db),
      });
    }
  );

  return { server, db };
}

export async function startMcpServer(cfg: ArchiveConfig): Promise<void> {
  const { server } = createMcpServer(cfg);
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
