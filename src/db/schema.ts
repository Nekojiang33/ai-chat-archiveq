import type { Db } from './connection.js';

const KEY_EMBED_DIM = 'embed_dim';

function hasSyncState(db: Db): boolean {
  const row = db
    .prepare(`SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = 'sync_state'`)
    .get() as { ok: number } | undefined;
  return row !== undefined;
}

function readMeta(db: Db, key: string): string | null {
  // 允许在建表前调用（init 需要先读维度再 migrate）
  if (!hasSyncState(db)) return null;
  const row = db.prepare('SELECT value FROM sync_state WHERE key = ?').get(key) as { value: string } | undefined;
  return row?.value ?? null;
}

function writeMeta(db: Db, key: string, value: string): void {
  db.prepare('INSERT OR REPLACE INTO sync_state (key, value) VALUES (?, ?)').run(key, value);
}

/** 读取建库时记录的向量维度（旧库无记录时返回 null） */
export function readEmbedDim(db: Db): number | null {
  const raw = readMeta(db, KEY_EMBED_DIM);
  if (raw === null) return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

/** 从既有 vec0 表定义中解析维度（用于 meta 缺失的旧库，如 v0.1 建库） */
function detectSchemaDim(db: Db): number | null {
  const row = db.prepare(`SELECT sql FROM sqlite_master WHERE name = 'message_vec'`).get() as { sql?: string } | undefined;
  if (!row?.sql) return null;
  const m = /float\[(\d+)\]/.exec(row.sql);
  return m ? Number(m[1]) : null;
}

/**
 * 建表/迁移。
 *
 * sqlite-vec 的 `vec0` 虚拟表维度在建表时固定，之后无法修改，
 * 因此把维度写入 sync_state 并在迁移时校验，避免「换 embedding 模型后报奇怪的插入错误」。
 */
export function migrate(db: Db, dim = 1024): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS sync_state (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);

  const recorded = readEmbedDim(db);
  // 兼容 v0.1 建库（无 embed_dim 元数据）：以既有 vec0 表定义的真实维度为准
  const effectiveDim = recorded ?? detectSchemaDim(db);
  if (effectiveDim !== null && effectiveDim !== dim) {
    throw new Error(
      `向量维度不一致：数据库按 ${effectiveDim} 维建立向量表，当前配置为 ${dim} 维。\n` +
        `sqlite-vec 建库维度不可变更：请设置 ACA_EMBED_DIM=${effectiveDim}，或导出原始对话后重建数据库。`
    );
  }

  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_version (version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL);

    CREATE TABLE IF NOT EXISTS conversations (
      id TEXT PRIMARY KEY,
      source TEXT NOT NULL,
      external_id TEXT NOT NULL,
      title TEXT,
      model TEXT,
      created_at INTEGER,
      imported_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      distilled_at INTEGER,
      message_count INTEGER NOT NULL DEFAULT 0,
      UNIQUE(source, external_id)
    );

    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL REFERENCES conversations(id),
      external_id TEXT,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      model TEXT,
      tokens INTEGER,
      timestamp INTEGER,
      seq INTEGER NOT NULL,
      imported_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_messages_conv ON messages(conversation_id, seq);
    CREATE INDEX IF NOT EXISTS idx_messages_ts ON messages(timestamp);

    CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
      message_id UNINDEXED,
      content,
      pinyin,
      tokenize='unicode61'
    );

    CREATE VIRTUAL TABLE IF NOT EXISTS message_vec USING vec0(
      message_id TEXT PRIMARY KEY,
      embedding float[${dim}]
    );

    CREATE TABLE IF NOT EXISTS entities (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      type TEXT NOT NULL,
      aliases TEXT,
      mention_count INTEGER NOT NULL DEFAULT 1,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      UNIQUE(name, type)
    );

    CREATE TABLE IF NOT EXISTS facts (
      id TEXT PRIMARY KEY,
      entity_id TEXT REFERENCES entities(id),
      content TEXT NOT NULL,
      valid_from INTEGER,
      valid_to INTEGER,
      confidence REAL NOT NULL DEFAULT 1.0,
      source_message_id TEXT,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_facts_entity ON facts(entity_id);

    CREATE TABLE IF NOT EXISTS memories (
      id TEXT PRIMARY KEY,
      layer TEXT NOT NULL,
      content TEXT NOT NULL,
      tags TEXT,
      entity_ids TEXT,
      source_conversation_id TEXT,
      importance REAL NOT NULL DEFAULT 0.5,
      access_count INTEGER NOT NULL DEFAULT 0,
      last_accessed INTEGER,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_memories_layer ON memories(layer);

    CREATE VIRTUAL TABLE IF NOT EXISTS memory_vec USING vec0(
      memory_id TEXT PRIMARY KEY,
      embedding float[${dim}]
    );
  `);

  if (recorded === null) writeMeta(db, KEY_EMBED_DIM, String(dim));
  db.prepare('INSERT OR IGNORE INTO schema_version (version, applied_at) VALUES (1, ?)').run(Date.now());
}

export function rebuildFts(db: Db, tokenize: (s: string) => string, tokenizePinyin: (s: string) => string): number {
  const rows = db.prepare('SELECT id, content FROM messages').all() as { id: string; content: string }[];
  const tx = db.transaction(() => {
    db.exec('DELETE FROM messages_fts');
    const ins = db.prepare('INSERT INTO messages_fts (message_id, content, pinyin) VALUES (?, ?, ?)');
    for (const r of rows) ins.run(r.id, tokenize(r.content), tokenizePinyin(r.content));
  });
  tx();
  return rows.length;
}
