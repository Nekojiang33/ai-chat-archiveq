import type { Db } from '../db/connection.js';
import { ftsMatchExpr, pinyinMatchExpr, tokenizeArray } from '../db/tokenizer.js';
import type { Embedder } from './embed.js';
import { dbKey, getCachedQueryVector, getCachedResult, setCachedQueryVector, setCachedResult } from './cache.js';

export interface SearchOpts {
  source?: string;
  since?: string;
  until?: string;
  limit?: number;
  /** 某一路检索降级时的告警回调（例如嵌入端点不可用） */
  onWarn?: (msg: string) => void;
}

export interface SearchHit {
  messageId: string;
  conversationId: string;
  source: string;
  title: string | null;
  role: string;
  content: string;
  timestamp: number | null;
  score: number;
  via: string[];
}

interface MessageRow {
  id: string;
  conversation_id: string;
  source: string;
  title: string | null;
  role: string;
  content: string;
  timestamp: number | null;
}

// ---------------------------------------------------------------- 语句缓存
// better-sqlite3 的 prepare 有固定成本；工具被反复调用时复用语句对象更稳。
interface AnyStatement {
  all(...params: unknown[]): unknown[];
  get(...params: unknown[]): unknown;
  run(...params: unknown[]): { changes: number; lastInsertRowid: number | bigint };
}

const stmtCaches = new WeakMap<Db, Map<string, AnyStatement>>();

function stmt(db: Db, sql: string): AnyStatement {
  let cache = stmtCaches.get(db);
  if (!cache) {
    cache = new Map();
    stmtCaches.set(db, cache);
  }
  let prepared = cache.get(sql);
  if (!prepared) {
    prepared = db.prepare(sql) as unknown as AnyStatement;
    cache.set(sql, prepared);
  }
  return prepared;
}

function parseTime(v: string | undefined): number | null {
  if (!v) return null;
  const t = Date.parse(v);
  return Number.isNaN(t) ? null : t;
}

/** 查询向量走缓存：真实 Ollama 下一次 embed 是网络往返，重复查询可直接命中 */
async function queryVector(db: Db, embedder: Embedder, query: string): Promise<number[] | undefined> {
  const key = `${dbKey(db)}|${embedder.provider}|${embedder.model}|${embedder.dim}|${query}`;
  const cached = getCachedQueryVector(key);
  if (cached) return cached;
  const [vec] = await embedder.embed([query]);
  if (vec) setCachedQueryVector(key, vec);
  return vec;
}

/**
 * 为缺失向量的消息补齐 embeddings。
 *
 * 分块处理（默认 256 条/块）：避免一次性把整库文本和全部向量堆在内存里，
 * 也让进度可见；每块单独事务，失败只影响当前块。
 */
export async function ensureMessageEmbeddings(
  db: Db,
  embedder: Embedder,
  convId?: string,
  onProgress?: (done: number, total: number) => void
): Promise<number> {
  const rows = (
    convId
      ? stmt(
          db,
          `SELECT m.id, m.content FROM messages m
           LEFT JOIN message_vec v ON v.message_id = m.id
           WHERE v.message_id IS NULL AND m.conversation_id = ?`
        ).all(convId)
      : stmt(
          db,
          `SELECT m.id, m.content FROM messages m
           LEFT JOIN message_vec v ON v.message_id = m.id
           WHERE v.message_id IS NULL`
        ).all()
  ) as { id: string; content: string }[];
  if (rows.length === 0) return 0;

  const chunkSize = Math.max(1, Number(process.env.ACA_EMBED_CHUNK || 256));
  const ins = stmt(db, 'INSERT OR REPLACE INTO message_vec (message_id, embedding) VALUES (?, ?)');
  let done = 0;
  for (let i = 0; i < rows.length; i += chunkSize) {
    const slice = rows.slice(i, i + chunkSize);
    const vecs = await embedder.embed(slice.map((r) => r.content.slice(0, 4000)));
    db.transaction(() => {
      for (let j = 0; j < slice.length; j++) ins.run(slice[j].id, JSON.stringify(vecs[j]));
    })();
    done += slice.length;
    onProgress?.(done, rows.length);
  }
  return done;
}

export async function searchMessages(db: Db, embedder: Embedder, query: string, opts: SearchOpts = {}): Promise<SearchHit[]> {
  const limit = opts.limit ?? 10;
  const cacheKey = `${dbKey(db)}|s|${query}|${opts.source ?? ''}|${opts.since ?? ''}|${opts.until ?? ''}|${limit}`;
  const cached = getCachedResult<SearchHit[]>(cacheKey);
  if (cached) return cached;

  const lists: { name: string; ids: string[] }[] = [];

  const ftsExpr = ftsMatchExpr(query);
  if (ftsExpr) {
    const rows = stmt(db, `SELECT message_id FROM messages_fts WHERE messages_fts MATCH ? ORDER BY bm25(messages_fts) LIMIT 40`).all(
      ftsExpr
    ) as { message_id: string }[];
    if (rows.length > 0) lists.push({ name: 'fts', ids: rows.map((r) => r.message_id) });
  }

  // 拼音路：拉丁查询（如 fenci）需要反查中文，因此这里不按「查询是否含中文」跳过
  const pyExpr = pinyinMatchExpr(query);
  if (pyExpr) {
    const rows = stmt(db, `SELECT message_id FROM messages_fts WHERE pinyin MATCH ? ORDER BY bm25(messages_fts) LIMIT 40`).all(
      pyExpr
    ) as { message_id: string }[];
    if (rows.length > 0) lists.push({ name: 'pinyin', ids: rows.map((r) => r.message_id) });
  }

  try {
    const qv = await queryVector(db, embedder, query);
    if (qv) {
      // KNN 成本与 k 近似线性：按返回条数自适应，而不是固定 40
      const k = Math.min(200, Math.max(20, limit * 4));
      const rows = stmt(db, `SELECT message_id FROM message_vec WHERE embedding MATCH ? ORDER BY distance LIMIT ${k}`).all(
        JSON.stringify(qv)
      ) as { message_id: string }[];
      if (rows.length > 0) lists.push({ name: 'vec', ids: rows.map((r) => r.message_id) });
    }
  } catch (e) {
    // 嵌入端点不可用时仍保留关键词/拼音路，但必须显式告警，避免静默降级
    opts.onWarn?.(`语义向量检索不可用，已降级为关键词+拼音：${e instanceof Error ? e.message : String(e)}`);
  }

  if (lists.length === 0) {
    setCachedResult(cacheKey, []);
    return [];
  }

  const scores = new Map<string, number>();
  const via = new Map<string, Set<string>>();
  for (const { name, ids } of lists) {
    ids.forEach((id, i) => {
      scores.set(id, (scores.get(id) ?? 0) + 1 / (60 + i + 1));
      const v = via.get(id) ?? new Set<string>();
      v.add(name);
      via.set(id, v);
    });
  }

  const ids = [...scores.keys()];
  const placeholders = ids.map(() => '?').join(',');
  const rows = stmt(
    db,
    `SELECT m.id, m.conversation_id, m.role, m.content, m.timestamp, c.source, c.title
     FROM messages m JOIN conversations c ON c.id = m.conversation_id
     WHERE m.id IN (${placeholders})`
  ).all(...ids) as MessageRow[];

  const since = parseTime(opts.since);
  const until = parseTime(opts.until);
  const filtered = rows.filter((r) => {
    if (opts.source && r.source !== opts.source) return false;
    if (since !== null && (r.timestamp === null || r.timestamp < since)) return false;
    if (until !== null && (r.timestamp === null || r.timestamp > until)) return false;
    return true;
  });

  const hits = filtered
    .map((r) => ({
      messageId: r.id,
      conversationId: r.conversation_id,
      source: r.source,
      title: r.title,
      role: r.role,
      content: r.content.length > 600 ? r.content.slice(0, 600) + '…' : r.content,
      timestamp: r.timestamp,
      score: Math.round((scores.get(r.id) ?? 0) * 1e6) / 1e6,
      via: [...(via.get(r.id) ?? [])],
    }))
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);

  setCachedResult(cacheKey, hits);
  return hits;
}

export interface MemoryHit {
  memoryId: string;
  layer: string;
  content: string;
  importance: number;
  lastAccessed: number | null;
  score: number;
}

export interface FactHit {
  factId: string;
  entity: string;
  entityType: string;
  content: string;
  confidence: number;
}

export async function queryMemory(
  db: Db,
  embedder: Embedder,
  query: string,
  opts: { layer?: string; limit?: number; onWarn?: (msg: string) => void } = {}
): Promise<{ memories: MemoryHit[]; facts: FactHit[] }> {
  const limit = opts.limit ?? 8;
  const hits: MemoryHit[] = [];
  try {
    const qv = await queryVector(db, embedder, query);
    if (qv) {
      const vecRows = stmt(db, `SELECT memory_id, distance FROM memory_vec WHERE embedding MATCH ? ORDER BY distance LIMIT 20`).all(
        JSON.stringify(qv)
      ) as { memory_id: string; distance: number }[];
      const ids = vecRows.map((r) => r.memory_id);
      if (ids.length > 0) {
        const placeholders = ids.map(() => '?').join(',');
        const rows = stmt(db, `SELECT id, layer, content, importance, last_accessed FROM memories WHERE id IN (${placeholders})`).all(
          ...ids
        ) as { id: string; layer: string; content: string; importance: number; last_accessed: number | null }[];
        const distMap = new Map(vecRows.map((r) => [r.memory_id, r.distance]));
        for (const r of rows) {
          if (opts.layer && r.layer !== opts.layer) continue;
          hits.push({
            memoryId: r.id,
            layer: r.layer,
            content: r.content,
            importance: r.importance,
            lastAccessed: r.last_accessed,
            score: Math.round((1 / (1 + (distMap.get(r.id) ?? 1)) + r.importance * 0.1) * 1e4) / 1e4,
          });
        }
        const now = Date.now();
        const upd = stmt(db, 'UPDATE memories SET access_count = access_count + 1, last_accessed = ? WHERE id = ?');
        db.transaction(() => {
          for (const r of rows) upd.run(now, r.id);
        })();
      }
    }
  } catch (e) {
    opts.onWarn?.(`记忆向量检索不可用，已降级为事实关键词匹配：${e instanceof Error ? e.message : String(e)}`);
  }

  const toks = tokenizeArray(query).filter((t) => t.length >= 2);
  let facts: FactHit[] = [];
  if (toks.length > 0) {
    const conds = toks.map(() => "f.content LIKE '%' || ? || '%'").join(' OR ');
    const rows = stmt(
      db,
      `SELECT f.id, f.content, f.confidence, e.name, e.type
       FROM facts f LEFT JOIN entities e ON e.id = f.entity_id
       WHERE f.valid_to IS NULL AND (${conds})
       ORDER BY f.confidence DESC, f.created_at DESC LIMIT ${Number(limit)}`
    ).all(...toks) as { id: string; content: string; confidence: number; name: string | null; type: string | null }[];
    facts = rows.map((r) => ({
      factId: r.id,
      entity: r.name ?? '(未关联实体)',
      entityType: r.type ?? 'unknown',
      content: r.content,
      confidence: r.confidence,
    }));
  }

  return { memories: hits.sort((a, b) => b.score - a.score).slice(0, limit), facts };
}

export interface EntityContext {
  entity: { id: string; name: string; type: string; aliases: string[]; mentionCount: number };
  facts: { content: string; validFrom: number | null; confidence: number }[];
  conversations: { conversationId: string; source: string; title: string | null; occurredAt: number | null }[];
}

export function getEntityContext(db: Db, name: string): EntityContext | null {
  const entity = stmt(db, `SELECT id, name, type, aliases, mention_count FROM entities WHERE name = ? OR aliases LIKE ?`).get(
    name,
    `%${name}%`
  ) as { id: string; name: string; type: string; aliases: string | null; mention_count: number } | undefined;
  if (!entity) return null;

  const facts = stmt(
    db,
    `SELECT content, valid_from, confidence FROM facts WHERE entity_id = ? ORDER BY (valid_to IS NULL) DESC, created_at DESC`
  ).all(entity.id) as { content: string; valid_from: number | null; confidence: number }[];

  const ftsExpr = `"${name.replace(/"/g, '""')}"`;
  const msgRows = stmt(db, `SELECT message_id FROM messages_fts WHERE messages_fts MATCH ? ORDER BY bm25(messages_fts) LIMIT 5`).all(
    ftsExpr
  ) as { message_id: string }[];
  const conversations: EntityContext['conversations'] = [];
  if (msgRows.length > 0) {
    const ids = msgRows.map((r) => r.message_id);
    const placeholders = ids.map(() => '?').join(',');
    const rows = stmt(
      db,
      `SELECT DISTINCT m.conversation_id, m.timestamp, c.source, c.title
       FROM messages m JOIN conversations c ON c.id = m.conversation_id
       WHERE m.id IN (${placeholders})`
    ).all(...ids) as { conversation_id: string; timestamp: number | null; source: string; title: string | null }[];
    for (const r of rows) {
      conversations.push({ conversationId: r.conversation_id, source: r.source, title: r.title, occurredAt: r.timestamp });
    }
  }

  return {
    entity: {
      id: entity.id,
      name: entity.name,
      type: entity.type,
      aliases: entity.aliases ? (JSON.parse(entity.aliases) as string[]) : [],
      mentionCount: entity.mention_count,
    },
    facts: facts.map((f) => ({ content: f.content, validFrom: f.valid_from, confidence: f.confidence })),
    conversations,
  };
}
