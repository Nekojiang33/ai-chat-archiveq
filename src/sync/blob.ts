import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import type { Db } from '../db/connection.js';
import { upsertConversation } from '../importers/core.js';
import type { ParsedConversation, ParsedMessage } from '../importers/types.js';

const MAGIC = Buffer.from('ACAB');

interface BlobPayload {
  v: 1;
  conversations: {
    source: string;
    externalId: string;
    title: string | null;
    model: string | null;
    createdAt: number | null;
    updatedAt: number | null;
    messages: {
      externalId: string | null;
      role: string;
      content: string;
      model: string | null;
      timestamp: number | null;
      seq: number;
    }[];
  }[];
}

export interface PackResult {
  conversations: number;
  messages: number;
  bytes: number;
}

export function packArchive(db: Db, outPath: string, password: string): PackResult {
  const convs = db
    .prepare(`SELECT id, source, external_id, title, model, created_at, updated_at FROM conversations`)
    .all() as {
    id: string;
    source: string;
    external_id: string;
    title: string | null;
    model: string | null;
    created_at: number | null;
    updated_at: number | null;
  }[];
  const msgByConv = new Map<string, BlobPayload['conversations'][number]['messages']>();
  let totalMessages = 0;
  for (const m of db
    .prepare(`SELECT conversation_id, external_id, role, content, model, timestamp, seq FROM messages`)
    .all() as {
    conversation_id: string;
    external_id: string | null;
    role: string;
    content: string;
    model: string | null;
    timestamp: number | null;
    seq: number;
  }[]) {
    const list = msgByConv.get(m.conversation_id) ?? [];
    list.push({
      externalId: m.external_id,
      role: m.role,
      content: m.content,
      model: m.model,
      timestamp: m.timestamp,
      seq: m.seq,
    });
    msgByConv.set(m.conversation_id, list);
    totalMessages++;
  }

  const payload: BlobPayload = {
    v: 1,
    conversations: convs.map((c) => ({
      source: c.source,
      externalId: c.external_id,
      title: c.title,
      model: c.model,
      createdAt: c.created_at,
      updatedAt: c.updated_at,
      messages: (msgByConv.get(c.id) ?? []).sort((a, b) => a.seq - b.seq),
    })),
  };

  const gz = zlib.gzipSync(Buffer.from(JSON.stringify(payload), 'utf8'), { level: 9 });
  const salt = crypto.randomBytes(16);
  const iv = crypto.randomBytes(12);
  const key = crypto.scryptSync(password, salt, 32);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([cipher.update(gz), cipher.final()]);
  const tag = cipher.getAuthTag();
  const out = Buffer.concat([MAGIC, Buffer.from([1]), salt, iv, tag, ct]);

  const abs = path.resolve(outPath);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, out);
  return { conversations: convs.length, messages: totalMessages, bytes: out.length };
}

export interface UnpackResult {
  conversations: number;
  newMessages: number;
}

export function unpackInto(db: Db, blobPath: string, password: string): UnpackResult {
  const raw = fs.readFileSync(blobPath);
  if (raw.length < 49 || !raw.subarray(0, 4).equals(MAGIC)) throw new Error('不是有效的归档 blob 文件（魔数不符）');
  const version = raw[4];
  if (version !== 1) throw new Error(`不支持的 blob 版本: ${version}`);
  const salt = raw.subarray(5, 21);
  const iv = raw.subarray(21, 33);
  const tag = raw.subarray(33, 49);
  const ct = raw.subarray(49);
  const key = crypto.scryptSync(password, salt, 32);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  let gz: Buffer;
  try {
    gz = Buffer.concat([decipher.update(ct), decipher.final()]);
  } catch {
    throw new Error('解密失败：密码错误或文件损坏');
  }
  const payload = JSON.parse(zlib.gunzipSync(gz).toString('utf8')) as BlobPayload;

  let conversations = 0;
  let newMessages = 0;
  for (const c of payload.conversations) {
    const conv: ParsedConversation = {
      source: c.source,
      externalId: c.externalId,
      title: c.title ?? undefined,
      model: c.model ?? undefined,
      createdAt: c.createdAt ?? undefined,
      updatedAt: c.updatedAt ?? undefined,
      messages: c.messages.map((m) => ({
        externalId: m.externalId ?? undefined,
        role: m.role as ParsedMessage['role'],
        content: m.content,
        model: m.model ?? undefined,
        timestamp: m.timestamp ?? undefined,
        seq: m.seq,
      })),
    };
    const r = upsertConversation(db, conv);
    conversations++;
    newMessages += r.insertedMessages;
  }
  return { conversations, newMessages };
}
