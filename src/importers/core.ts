import crypto from 'node:crypto';
import type { Db } from '../db/connection.js';
import { tokenizeBoth } from '../db/tokenizer.js';
import { invalidateSearchCaches } from '../search/cache.js';
import type { ParsedConversation } from './types.js';

export function stableId(...parts: string[]): string {
  return crypto.createHash('sha256').update(parts.join('\u0000')).digest('hex').slice(0, 32);
}

export interface UpsertResult {
  conversationId: string;
  insertedMessages: number;
  isNewConversation: boolean;
}

export function upsertConversation(db: Db, conv: ParsedConversation): UpsertResult {
  const now = Date.now();
  const convId = stableId(conv.source, conv.externalId);
  const updatedAt = conv.updatedAt ?? conv.createdAt ?? now;

  const convInfo = db
    .prepare(
      `INSERT INTO conversations (id, source, external_id, title, model, created_at, imported_at, updated_at, message_count)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(source, external_id) DO UPDATE SET
         title = COALESCE(excluded.title, title),
         model = COALESCE(excluded.model, model),
         updated_at = MAX(updated_at, excluded.updated_at),
         message_count = excluded.message_count`
    )
    .run(convId, conv.source, conv.externalId, conv.title ?? null, conv.model ?? null, conv.createdAt ?? null, now, updatedAt, conv.messages.length);

  let inserted = 0;
  const insMsg = db.prepare(
    `INSERT OR IGNORE INTO messages (id, conversation_id, external_id, role, content, model, timestamp, seq, imported_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  const insFts = db.prepare('INSERT INTO messages_fts (message_id, content, pinyin) VALUES (?, ?, ?)');

  const tx = db.transaction(() => {
    for (const m of conv.messages) {
      const msgId = m.externalId
        ? stableId('msg', conv.source, conv.externalId, m.externalId)
        : stableId('msg', conv.source, conv.externalId, String(m.seq));
      const r = insMsg.run(msgId, convId, m.externalId ?? null, m.role, m.content, m.model ?? null, m.timestamp ?? null, m.seq, now);
      if (r.changes > 0) {
        // 一次切词同时得到 content 与 pinyin（原实现每列各切一次）
        const t = tokenizeBoth(m.content);
        insFts.run(msgId, t.content, t.pinyin);
        inserted++;
      }
    }
  });
  tx();

  // 归档内容变化：让检索结果缓存失效（查询向量缓存与内容无关，保留）
  if (inserted > 0 || convInfo.changes > 0) invalidateSearchCaches();

  return { conversationId: convId, insertedMessages: inserted, isNewConversation: convInfo.changes > 0 };
}
