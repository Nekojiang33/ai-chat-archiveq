import { Command } from 'commander';
import fs from 'node:fs';
import { loadConfig, requirePassword, type ArchiveConfig } from './config.js';
import { openDb } from './db/connection.js';
import { migrate, readEmbedDim } from './db/schema.js';
import { importPaths } from './importers/index.js';
import { createEmbedder } from './search/embed.js';
import { searchMessages, queryMemory, getEntityContext, ensureMessageEmbeddings } from './search/hybrid.js';
import { runDistill, distillableCount } from './memory/pipeline.js';
import { createLlm } from './memory/llm.js';
import { startMcpServer } from './mcp/server.js';
import { packArchive, unpackInto } from './sync/blob.js';

interface GlobalOpts {
  db?: string;
  password?: string;
}

function withGlobal(cmd: Command): Command {
  return cmd
    .option('--db <path>', '数据库路径（默认 ~/.ai-chat-archive/archive.db，或 ACA_DB）')
    .option('--password <pwd>', '数据库密码（或 ACA_PASSWORD）');
}

function openArchive(o: GlobalOpts): { cfg: ArchiveConfig; db: ReturnType<typeof openDb> } {
  const cfg = loadConfig({ dbPath: o.db, password: o.password });
  requirePassword(cfg);
  const db = openDb(cfg.dbPath, cfg.password);
  migrate(db, cfg.embed.dim);
  return { cfg, db };
}

const program = new Command();
program
  .name('chat-archive')
  .description('AI 对话本地归档：SQLite 加密存储 + MCP server + 记忆蒸馏 + 端到端加密同步')
  .version('0.2.0');

const fmtTs = (ts: number | null): string => (ts ? new Date(ts).toISOString().replace('T', ' ').slice(0, 16) : '-');
const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e));

withGlobal(program.command('init'))
  .description('初始化加密归档数据库（接入真实嵌入模型时自动探测向量维度）')
  .action(async (o: GlobalOpts) => {
    const cfg = loadConfig({ dbPath: o.db, password: o.password });
    requirePassword(cfg);
    const db = openDb(cfg.dbPath, cfg.password);
    const existing = readEmbedDim(db);
    let dim = existing ?? cfg.embed.dim;
    // 建库前用真实模型探测维度，避免「换嵌入模型后 sqlite-vec 维度不匹配」
    if (existing === null && cfg.embed.provider !== 'hash' && !process.env.ACA_EMBED_DIM) {
      try {
        dim = (await createEmbedder({ ...cfg.embed, dim: 1 }).probe()).dim;
        console.log(`已从嵌入端点探测向量维度: ${dim}（模型 ${cfg.embed.model}）`);
      } catch (e) {
        console.warn(`维度探测失败，回退 ACA_EMBED_DIM=${dim}: ${errText(e)}`);
      }
    }
    migrate(db, dim);
    console.log(`已初始化: ${cfg.dbPath}（向量维度 ${dim}）`);
  });

withGlobal(program.command('import'))
  .description('导入对话导出文件（.zip ChatGPT / .json Claude 或 ChatGPT / .jsonl Claude Code / .jsonl.zstd DeepSeek Harness 会话 / 目录）')
  .argument('<paths...>', '文件或目录路径')
  .action(async (paths: string[], o: GlobalOpts) => {
    const { db } = openArchive(o);
    const r = importPaths(db, paths);
    console.log(`导入完成: ${r.files} 个文件 / ${r.conversations} 个会话 / 新增 ${r.newMessages} 条消息`);
  });

withGlobal(program.command('index'))
  .description('为未向量化的消息补齐语义向量')
  .action(async (o: GlobalOpts) => {
    const { cfg, db } = openArchive(o);
    const embedder = createEmbedder(cfg.embed);
    try {
      const n = await ensureMessageEmbeddings(db, embedder);
      console.log(`已向量化 ${n} 条消息（嵌入: ${cfg.embed.provider}${cfg.embed.model ? ` / ${cfg.embed.model}` : ''}）`);
      if (cfg.embed.provider === 'hash') {
        console.log('提示: 当前为 hash 伪向量，语义检索不可用；设置 ACA_EMBED_PROVIDER=ollama 使用真实嵌入模型');
      }
    } catch (e) {
      console.error(`向量化失败: ${errText(e)}`);
      process.exitCode = 1;
    }
  });

withGlobal(program.command('distill'))
  .description('对未蒸馏的对话运行记忆蒸馏管线（LLM 抽取实体/事实/摘要）')
  .option('--limit <n>', '本次蒸馏会话数上限', '50')
  .option('--max-chars <n>', '每个会话送入模型的最大字符数（需小于 Ollama 上下文，默认 8000）', '8000')
  .option('--force', '忽略蒸馏水位，强制重蒸（换模型/改提示词后用）')
  .action(async (opts: GlobalOpts & { limit: string; maxChars: string; force?: boolean }) => {
    const { cfg, db } = openArchive(opts);
    const embedder = createEmbedder(cfg.embed);
    const r = await runDistill(db, embedder, cfg.llm, {
      limit: Number(opts.limit),
      maxChars: Number(opts.maxChars),
      force: opts.force === true,
      onProgress: (m) => console.log(m),
      onWarn: (m) => console.warn(`⚠️  ${m}`),
    });
    console.log(
      `蒸馏完成: ${r.conversations} 会话 / ${r.entities} 实体 / ${r.facts} 事实 / ${r.memories} 情景记忆 / 新向量化 ${r.embeddedMessages} 条消息`
    );
    if (r.errors.length > 0) {
      // 未配置 LLM 属于「功能未启用」，不是运行失败；真正蒸馏出错才置非零退出码
      const configOnly = !cfg.llm.model;
      console.error(configOnly ? '提示:' : '错误:');
      for (const e of r.errors) console.error('  ' + e);
      if (!configOnly) process.exitCode = 1;
    }
  });

withGlobal(program.command('search'))
  .description('混合检索归档消息（关键词 + 拼音 + 向量）')
  .argument('<query>', '检索词')
  .option('--source <s>', '来源过滤：chatgpt | claude | claude-code')
  .option('--since <iso>', '起始时间')
  .option('--until <iso>', '结束时间')
  .option('--limit <n>', '返回条数', '10')
  .action(async (query: string, opts: GlobalOpts & { source?: string; since?: string; until?: string; limit: string }) => {
    const { cfg, db } = openArchive(opts);
    const embedder = createEmbedder(cfg.embed);
    const hits = await searchMessages(db, embedder, query, {
      source: opts.source,
      since: opts.since,
      until: opts.until,
      limit: Number(opts.limit),
      onWarn: (m) => console.warn(`⚠️  ${m}`),
    });
    if (hits.length === 0) {
      console.log('无结果');
      return;
    }
    hits.forEach((h, i) => {
      console.log(`[${i + 1}] score=${h.score} via=${h.via.join('+')} | ${h.source} | ${h.title ?? '(无标题)'} | ${fmtTs(h.timestamp)}`);
      console.log(`    ${h.role}: ${h.content.replace(/\n/g, ' ').slice(0, 200)}`);
    });
  });

withGlobal(program.command('memory'))
  .description('查询蒸馏出的长期记忆与事实')
  .argument('<query>', '查询内容')
  .option('--layer <l>', '记忆层过滤：episodic | semantic')
  .option('--limit <n>', '返回条数', '8')
  .action(async (query: string, opts: GlobalOpts & { layer?: string; limit: string }) => {
    const { cfg, db } = openArchive(opts);
    const embedder = createEmbedder(cfg.embed);
    const r = await queryMemory(db, embedder, query, {
      layer: opts.layer,
      limit: Number(opts.limit),
      onWarn: (m) => console.warn(`⚠️  ${m}`),
    });
    if (r.memories.length === 0 && r.facts.length === 0) {
      console.log('无结果（先运行 distill）');
      return;
    }
    for (const m of r.memories) {
      console.log(`[记忆/${m.layer}] score=${m.score} importance=${m.importance}`);
      console.log(`    ${m.content}`);
    }
    for (const f of r.facts) {
      console.log(`[事实/${f.entityType}] ${f.entity} (置信 ${f.confidence})`);
      console.log(`    ${f.content}`);
    }
  });

withGlobal(program.command('context'))
  .description('查看实体的完整上下文（事实 + 相关对话）')
  .argument('<name>', '实体名称或别名')
  .action((name: string, o: GlobalOpts) => {
    const { db } = openArchive(o);
    const ctx = getEntityContext(db, name);
    if (!ctx) {
      console.log(`未找到实体: ${name}`);
      return;
    }
    console.log(`实体: ${ctx.entity.name} (${ctx.entity.type})，提及 ${ctx.entity.mentionCount} 次`);
    if (ctx.entity.aliases.length > 0) console.log(`别名: ${ctx.entity.aliases.join(', ')}`);
    for (const f of ctx.facts) console.log(`  - [${fmtTs(f.validFrom)}] ${f.content} (置信 ${f.confidence})`);
    if (ctx.conversations.length > 0) {
      console.log('出现于:');
      for (const c of ctx.conversations) console.log(`  - ${c.source} | ${c.title ?? ''} | ${fmtTs(c.occurredAt)}`);
    }
  });

withGlobal(program.command('entities'))
  .description('列出蒸馏出的实体')
  .option('--type <t>', '类型过滤：person | project | tool | concept | preference')
  .option('--limit <n>', '返回条数', '30')
  .action((opts: GlobalOpts & { type?: string; limit: string }) => {
    const { db } = openArchive(opts);
    const rows = opts.type
      ? db.prepare(`SELECT name, type, mention_count FROM entities WHERE type = ? ORDER BY mention_count DESC LIMIT ?`).all(opts.type, Number(opts.limit))
      : db.prepare(`SELECT name, type, mention_count FROM entities ORDER BY mention_count DESC LIMIT ?`).all(Number(opts.limit));
    for (const r of rows as { name: string; type: string; mention_count: number }[]) {
      console.log(`${r.type.padEnd(10)} ${String(r.mention_count).padStart(3)}x  ${r.name}`);
    }
  });

withGlobal(program.command('status'))
  .description('归档库统计')
  .action((o: GlobalOpts) => {
    const { cfg, db } = openArchive(o);
    const one = (sql: string): number => (db.prepare(sql).get() as { n: number }).n;
    const sizeMb = fs.existsSync(cfg.dbPath) ? (fs.statSync(cfg.dbPath).size / 1048576).toFixed(1) : '0';
    console.log(`数据库: ${cfg.dbPath} (${sizeMb} MB)`);
    console.log(
      `会话 ${one('SELECT COUNT(*) n FROM conversations')} | 消息 ${one('SELECT COUNT(*) n FROM messages')} | 已向量化 ${one('SELECT COUNT(*) n FROM message_vec')}`
    );
    console.log(
      `实体 ${one('SELECT COUNT(*) n FROM entities')} | 事实 ${one('SELECT COUNT(*) n FROM facts')} | 记忆 ${one('SELECT COUNT(*) n FROM memories')}`
    );
    console.log(`待蒸馏会话: ${distillableCount(db)}`);
    const recordedDim = readEmbedDim(db);
    console.log(
      `嵌入: ${cfg.embed.provider}${cfg.embed.provider !== 'hash' ? ` (${cfg.embed.model}, ${cfg.embed.dim}d)` : ''} | 库维度 ${recordedDim ?? '未知'} | LLM: ${cfg.llm.model ?? '未配置'}`
    );
    if (recordedDim !== null && recordedDim !== cfg.embed.dim) {
      console.warn(`⚠️  当前配置维度 ${cfg.embed.dim} 与库内维度 ${recordedDim} 不一致，请设置 ACA_EMBED_DIM=${recordedDim}`);
    }
  });

withGlobal(program.command('doctor'))
  .description('自检：数据库/加密/向量维度 + Ollama（或 OpenAI 兼容）端点与模型可用性')
  .action(async (o: GlobalOpts) => {
    let healthy = true;
    const line = (pass: boolean, label: string, detail: string): void => {
      if (!pass) healthy = false;
      console.log(`${pass ? '✅' : '❌'} ${label}${detail ? ` — ${detail}` : ''}`);
    };
    const skip = (label: string, detail: string): void => console.log(`➖ ${label}${detail ? ` — ${detail}` : ''}`);

    console.log(`Node.js ${process.version} (${process.platform}/${process.arch})`);
    const cfg = loadConfig({ dbPath: o.db, password: o.password });

    // 1) 数据库
    if (!cfg.password) {
      line(false, '数据库密码', '未配置（--password 或 ACA_PASSWORD）');
    } else {
      let db: ReturnType<typeof openDb> | null = null;
      try {
        db = openDb(cfg.dbPath, cfg.password);
        migrate(db, cfg.embed.dim);
        const one = (sql: string): number => (db!.prepare(sql).get() as { n: number }).n;
        const dim = readEmbedDim(db) ?? cfg.embed.dim;
        line(
          true,
          '数据库',
          `${cfg.dbPath}（${one('SELECT COUNT(*) n FROM conversations')} 会话 / ${one('SELECT COUNT(*) n FROM messages')} 消息 / ${dim} 维）`
        );
        line(
          true,
          '索引覆盖',
          `向量 ${one('SELECT COUNT(*) n FROM message_vec')} 条，FTS ${one('SELECT COUNT(*) n FROM messages_fts')} 行`
        );
      } catch (e) {
        line(false, '数据库', errText(e));
      }
    }

    // 2) 蒸馏 LLM（真实往返一次 JSON）
    if (!cfg.llm.model) {
      skip('蒸馏 LLM', '未配置 ACA_LLM_MODEL（蒸馏功能禁用）');
    } else {
      const llm = createLlm(cfg.llm);
      if (!llm) {
        skip('蒸馏 LLM', '未配置');
      } else {
        const models = await llm.listModels();
        line(models.length > 0, 'LLM 端点', `${cfg.llm.baseUrl}${models.length > 0 ? `（${models.length} 个模型可用）` : ' 不可达或未返回模型列表'}`);
        if (models.length > 0) {
          const name = cfg.llm.model;
          const found = models.some((m) => m === name || m.startsWith(`${name}:`) || m.split(':')[0] === name.split(':')[0]);
          line(
            found,
            'LLM 模型',
            found ? name : `未找到 ${name}（可用：${models.slice(0, 8).join(', ')}${models.length > 8 ? ' …' : ''}）`
          );
        }
        const started = Date.now();
        try {
          const r = await llm.chatJson('你是自检助手。', '请只输出 JSON：{"ok": true}');
          line(true, 'LLM 推理', `${Date.now() - started}ms 往返 → ${JSON.stringify(r).slice(0, 80)}`);
        } catch (e) {
          line(false, 'LLM 推理', errText(e));
        }
      }
    }

    // 3) 嵌入端点
    if (cfg.embed.provider === 'hash') {
      skip('嵌入模型', '当前为 hash 伪向量（零依赖降级），语义检索不可用；设置 ACA_EMBED_PROVIDER=ollama 使用真实模型');
    } else {
      const embedder = createEmbedder(cfg.embed);
      const started = Date.now();
      try {
        const p = await embedder.probe();
        const match = p.dim === cfg.embed.dim;
        line(match, '嵌入端点', `${cfg.embed.baseUrl} / ${cfg.embed.model} → ${p.dim} 维（${Date.now() - started}ms）`);
        if (!match) line(false, '嵌入维度', `配置 ${cfg.embed.dim} 维与实际 ${p.dim} 维不一致，请设置 ACA_EMBED_DIM=${p.dim} 并重建数据库`);
      } catch (e) {
        line(false, '嵌入端点', errText(e));
      }
    }

    process.exitCode = healthy ? 0 : 1;
  });

withGlobal(program.command('mcp'))
  .description('以 stdio 模式启动 MCP server（供 Claude Desktop / Cursor / Cline 等调用）')
  .action(async (o: GlobalOpts) => {
    const cfg = loadConfig({ dbPath: o.db, password: o.password });
    if (!cfg.password) {
      console.error('MCP 模式需要密码：设置 ACA_PASSWORD 环境变量（stdio 通道被 MCP 协议占用，无法交互输入）');
      process.exit(1);
    }
    await startMcpServer(cfg);
  });

const syncCmd = program.command('sync').description('跨设备同步（端到端加密 blob，服务端零知识）');

withGlobal(syncCmd.command('pack'))
  .description('将全部原始对话打包为加密 blob 文件')
  .argument('<out>', '输出文件路径')
  .option('--blob-password <pwd>', 'blob 加密密码（默认沿用数据库密码；可与数据库密码不同）')
  .action((out: string, o: GlobalOpts & { blobPassword?: string }) => {
    const { cfg, db } = openArchive(o);
    const r = packArchive(db, out, o.blobPassword || cfg.password!);
    console.log(`已打包 ${r.conversations} 会话 / ${r.messages} 消息 -> ${out} (${(r.bytes / 1024).toFixed(1)} KB, AES-256-GCM)`);
  });

withGlobal(syncCmd.command('unpack'))
  .description('将加密 blob 合并导入当前库（幂等，可重复执行）')
  .argument('<blob>', 'blob 文件路径')
  .option('--blob-password <pwd>', 'blob 解密密码（默认沿用数据库密码；可与数据库密码不同）')
  .action((blob: string, o: GlobalOpts & { blobPassword?: string }) => {
    const { cfg, db } = openArchive(o);
    const r = unpackInto(db, blob, o.blobPassword || cfg.password!);
    console.log(`已合并 ${r.conversations} 会话 / 新增 ${r.newMessages} 条消息`);
  });

program.parseAsync().catch((e) => {
  console.error(errText(e));
  process.exit(1);
});
