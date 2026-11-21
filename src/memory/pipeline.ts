import type { Db } from '../db/connection.js';
import type { Embedder } from '../search/embed.js';
import { ensureMessageEmbeddings } from '../search/hybrid.js';
import { stableId } from '../importers/core.js';
import { createLlm, type LlmClient } from './llm.js';
import { invalidateSearchCaches } from '../search/cache.js';
import type { LlmConfig } from '../config.js';

const EXTRACT_SYSTEM = `你是对话记忆蒸馏引擎。从用户与 AI 助手的对话中抽取值得长期记住的信息，只输出 JSON。

输出格式：
{
  "facts": [
    {
      "entity": "实体名（人名/项目名/工具名/概念名，保留对话原文写法）",
      "entity_type": "person | project | tool | concept | preference",
      "content": "一句明确的事实陈述（第三人称，可脱离原对话独立理解，含时间信息如有）",
      "confidence": 0.9
    }
  ],
  "summary": "本次对话的简要摘要（80字内）"
}

规则：
- 只抽取用户相关信息、用户做出的决定、确认过的偏好与明确的事实结论
- 实体的 entity 只写名称本身：不要用文件路径、URL、命令行或代码片段
- 忽略寒暄、临时性上下文、助手的推测性回答
- 没有值得抽取的内容时输出 {"facts": [], "summary": "..."}
- 只输出 JSON 本身`;

/** 单个会话最多入库多少条事实，防止小模型输出失控 */
const MAX_FACTS_PER_CONVERSATION = 20;

export interface DistillOptions {
  limit?: number;
  onProgress?: (msg: string) => void;
  /** 非致命问题（向量化失败等）的回调 */
  onWarn?: (msg: string) => void;
  /** 每个会话送入模型的最大字符数（默认 12000） */
  maxChars?: number;
  /** 忽略蒸馏水位，强制重蒸（换模型/改提示词后重建蒸馏层用） */
  force?: boolean;
}

export interface DistillResult {
  conversations: number;
  entities: number;
  facts: number;
  memories: number;
  embeddedMessages: number;
  errors: string[];
}

interface ExtractedFact {
  entity?: string;
  entity_type?: string;
  content?: string;
  confidence?: number;
}

interface ConversationRow {
  id: string;
  source: string;
  external_id: string;
  title: string | null;
  created_at: number | null;
}

const VALID_TYPES = new Set(['person', 'project', 'tool', 'concept', 'preference']);

/** 小模型常把文件路径/URL 当成实体名，这类名称对检索无意义，入库前丢弃 */
function isNoiseEntityName(name: string): boolean {
  if (name.length > 40) return true;
  if (/^[A-Za-z]:[\\/]/.test(name)) return true; // C:\... / C:/...
  if (name.startsWith('/') || name.startsWith('\\\\')) return true;
  if (/^https?:\/\//i.test(name)) return true;
  return name.includes('\\') || name.includes('\n');
}

const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e));

export function distillableCount(db: Db): number {
  return (
    db
      .prepare(`SELECT COUNT(*) n FROM conversations WHERE distilled_at IS NULL OR distilled_at < updated_at`)
      .get() as { n: number }
  ).n;
}

/** 兼容小模型可能返回的几种形状：{facts,summary} / {memories:[]} / 直接数组 */
function normalizeExtraction(raw: unknown): { facts: ExtractedFact[]; summary: string } {
  if (Array.isArray(raw)) return { facts: raw as ExtractedFact[], summary: '' };
  const obj = (raw && typeof raw === 'object' ? raw : {}) as {
    facts?: unknown;
    memories?: unknown;
    data?: unknown;
    summary?: unknown;
  };
  const rawFacts = obj.facts ?? obj.memories ?? obj.data;
  const list = Array.isArray(rawFacts) ? (rawFacts as ExtractedFact[]) : [];
  const summary = typeof obj.summary === 'string' ? obj.summary.trim() : '';
  return { facts: list.filter((f) => f !== null && typeof f === 'object'), summary };
}

function buildTranscript(
  msgs: { role: string; content: string }[],
  conv: { source: string; title: string | null },
  maxChars: number
): string {
  const header = `会话来源: ${conv.source}${conv.title ? `\n会话标题: ${conv.title}` : ''}`;
  const body = msgs.map((m) => `${m.role === 'user' ? '用户' : '助手'}: ${m.content}`).join('\n\n');
  const room = Math.max(1000, maxChars - header.length - 2);
  if (body.length <= room) return `${header}\n\n${body}`;
  // 长对话不能只保留开头：用户真正想问的往往在末尾。头部 55% + 尾部 45%。
  const headLen = Math.floor(room * 0.55);
  const tailLen = room - headLen;
  const omitted = body.length - headLen - tailLen;
  return `${header}\n\n${body.slice(0, headLen)}\n\n…（中间省略 ${omitted} 字）…\n\n${body.slice(body.length - tailLen)}`;
}

export async function runDistill(
  db: Db,
  embedder: Embedder,
  llmCfg: LlmConfig,
  opts: DistillOptions = {}
): Promise<DistillResult> {
  const llm: LlmClient | null = createLlm(llmCfg);
  const result: DistillResult = { conversations: 0, entities: 0, facts: 0, memories: 0, embeddedMessages: 0, errors: [] };
  const log = opts.onProgress ?? (() => {});
  const warn = opts.onWarn ?? (() => {});
  if (!llm) {
    result.errors.push('未配置蒸馏 LLM：设置 ACA_LLM_MODEL（及可选 ACA_LLM_BASE_URL，默认 Ollama http://127.0.0.1:11434/v1）');
    return result;
  }

  const convs = db
    .prepare(
      opts.force
        ? `SELECT id, source, external_id, title, created_at FROM conversations
           ORDER BY COALESCE(updated_at, imported_at) DESC
           LIMIT ?`
        : `SELECT id, source, external_id, title, created_at FROM conversations
           WHERE distilled_at IS NULL OR distilled_at < updated_at
           ORDER BY COALESCE(updated_at, imported_at) DESC
           LIMIT ?`
    )
    .all(opts.limit ?? 50) as ConversationRow[];

  const upsertEntity = db.prepare(
    `INSERT INTO entities (id, name, type, mention_count, created_at, updated_at)
     VALUES (?, ?, ?, 1, ?, ?)
     ON CONFLICT(name, type) DO UPDATE SET mention_count = mention_count + 1, updated_at = excluded.updated_at
     RETURNING id`
  );
  const insertFact = db.prepare(
    `INSERT OR IGNORE INTO facts (id, entity_id, content, valid_from, confidence, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`
  );
  const insertMemory = db.prepare(
    `INSERT OR IGNORE INTO memories (id, layer, content, source_conversation_id, importance, created_at)
     VALUES (?, 'episodic', ?, ?, 0.5, ?)`
  );
  const insertMemoryVec = db.prepare(`INSERT OR REPLACE INTO memory_vec (memory_id, embedding) VALUES (?, ?)`);
  const markDistilled = db.prepare(`UPDATE conversations SET distilled_at = ? WHERE id = ?`);

  for (const conv of convs) {
    const tag = `${conv.source}/${conv.external_id.slice(0, 12)}`;
    try {
      // 向量化失败不应阻断蒸馏（关键词检索仍然可用）
      try {
        result.embeddedMessages += await ensureMessageEmbeddings(db, embedder, conv.id);
      } catch (e) {
        warn(`消息向量化失败（${tag}），继续蒸馏：${errText(e)}`);
      }

      const msgs = db
        .prepare(`SELECT role, content FROM messages WHERE conversation_id = ? ORDER BY seq`)
        .all(conv.id) as { role: string; content: string }[];
      const now = Date.now();
      if (msgs.length === 0) {
        markDistilled.run(now, conv.id);
        continue;
      }

      const transcript = buildTranscript(msgs, conv, opts.maxChars ?? 8000);
      const raw = await llm.chatJson(EXTRACT_SYSTEM, transcript);
      const parsed = normalizeExtraction(raw);
      const validFrom = conv.created_at ?? now;
      let insertedFacts = 0;
      let skippedFacts = 0;

      const tx = db.transaction(() => {
        for (const f of parsed.facts.slice(0, MAX_FACTS_PER_CONVERSATION)) {
          const entity = typeof f.entity === 'string' ? f.entity.trim() : '';
          const content = typeof f.content === 'string' ? f.content.trim() : '';
          if (!entity || !content || isNoiseEntityName(entity)) {
            skippedFacts++;
            continue;
          }
          const type = VALID_TYPES.has(f.entity_type ?? '') ? (f.entity_type as string) : 'concept';
          const entityId = (upsertEntity.get(stableId('entity', entity, type), entity, type, now, now) as { id: string }).id;
          result.entities++;
          const confidence = Math.min(1, Math.max(0, Number(f.confidence) || 0.8));
          const factId = stableId('fact', entityId, content);
          const r = insertFact.run(factId, entityId, content, validFrom, confidence, now);
          if (r.changes > 0) insertedFacts++;
        }
        if (parsed.summary) {
          const memId = stableId('episodic', conv.id);
          const r = insertMemory.run(memId, parsed.summary, conv.id, now);
          if (r.changes > 0) result.memories++;
        }
        markDistilled.run(now, conv.id);
      });
      tx();
      result.facts += insertedFacts;
      if (insertedFacts > 0 || parsed.summary) invalidateSearchCaches();

      // 情景记忆向量化（失败只告警：记忆本身已入库，可由 keyword 路径召回）
      if (parsed.summary) {
        try {
          const [vec] = await embedder.embed([parsed.summary]);
          insertMemoryVec.run(stableId('episodic', conv.id), JSON.stringify(vec));
        } catch (e) {
          warn(`情景记忆向量化失败（${tag}）：${errText(e)}`);
        }
      }

      result.conversations++;
      log(
        `已蒸馏 ${tag}：${parsed.facts.length} 条事实（新入库 ${insertedFacts}${skippedFacts > 0 ? `，跳过 ${skippedFacts}` : ''}）`
      );
    } catch (e) {
      result.errors.push(`${tag}: ${errText(e)}`);
    }
  }
  return result;
}
