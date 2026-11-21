import type { ParsedConversation, ParsedMessage } from './types.js';

/**
 * DeepSeek Harness（DSH）会话日志导入器。
 *
 * 输入是 `~/.dsh/sessions/<workspace>/session-<id>/session.v4.jsonl.zstd` 解压后的 JSONL：
 * 首行是 session 头，其余是事件记录。这里只抽取**真实对话**：
 *
 *   - `user/message` 且 `data.source.kind === 'user'`（真人输入）
 *   - `assistant/message` 的 text 片段（忽略 reasoning 与 tool-call）
 *
 * 注入类消息（runtime-context / skill-catalog / time-context / system / developer）
 * 不进归档：它们不是用户说过的话，会污染蒸馏与检索。
 */

interface DshPart {
  type?: string;
  text?: string;
}

interface DshRecord {
  type?: string;
  seq?: number;
  time?: number;
  version?: number;
  id?: string;
  createdAt?: number;
  cwd?: string;
  data?: {
    title?: string;
    source?: { kind?: string };
    content?: DshPart[];
    message?: { role?: string; content?: DshPart[] };
    turn?: number;
  };
}

function textOf(parts: DshPart[] | undefined): string {
  if (!Array.isArray(parts)) return '';
  return parts
    .filter((p) => p !== null && typeof p === 'object' && p.type === 'text' && typeof p.text === 'string')
    .map((p) => p.text as string)
    .join('\n')
    .trim();
}

function parseRecords(content: string): DshRecord[] {
  const out: DshRecord[] = [];
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      out.push(JSON.parse(trimmed) as DshRecord);
    } catch {
      // 半行/损坏行跳过
    }
  }
  return out;
}

/** 判断一份 JSONL 是否是 DSH 会话日志（首行为 version/type=session 的头记录） */
export function isDshSession(content: string): boolean {
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const rec = JSON.parse(trimmed) as DshRecord;
      return rec.type === 'session' && typeof rec.version === 'number' && typeof rec.id === 'string';
    } catch {
      return false;
    }
  }
  return false;
}

export function parseDshSession(content: string, fallbackName: string): ParsedConversation[] {
  const records = parseRecords(content);
  const header = records.find((r) => r.type === 'session');
  if (!header || !header.id) return [];

  const messages: ParsedMessage[] = [];
  let lastTime = header.createdAt ?? 0;
  for (const rec of records) {
    const ts = typeof rec.time === 'number' ? rec.time : undefined;
    if (ts !== undefined) lastTime = Math.max(lastTime, ts);

    if (rec.type === 'user/message') {
      // 只收真人输入：注入消息的 source.kind 为 runtime-context / skill-catalog / time-context
      if (rec.data?.source?.kind !== 'user') continue;
      const text = textOf(rec.data?.content);
      if (!text) continue;
      messages.push({ role: 'user', content: text, timestamp: ts, seq: messages.length });
      continue;
    }

    if (rec.type === 'assistant/message') {
      const text = textOf(rec.data?.message?.content);
      if (!text) continue;
      messages.push({ role: 'assistant', content: text, timestamp: ts, seq: messages.length });
    }
  }
  if (messages.length === 0) return [];

  // 标题取最后一个 title 事件（provider 生成的优于 fallback）
  let title: string | undefined;
  for (const rec of records) {
    if (rec.type === 'session/title' && typeof rec.data?.title === 'string' && rec.data.title.trim()) {
      title = rec.data.title.trim();
    }
  }

  return [
    {
      source: 'dsh',
      externalId: header.id,
      title: title ?? `${fallbackName}（DSH 会话）`,
      createdAt: header.createdAt,
      updatedAt: lastTime || undefined,
      messages,
    },
  ];
}
