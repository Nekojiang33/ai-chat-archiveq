import fs from 'node:fs';
import path from 'node:path';
import type { ParsedConversation, ParsedMessage } from './types.js';

function extractContent(c: unknown): string {
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) {
    return c
      .filter((b): b is { text: string } => typeof b === 'object' && b !== null && (b as any).type === 'text')
      .map((b) => b.text)
      .join('\n');
  }
  return '';
}

function toMs(v: unknown): number | undefined {
  if (typeof v !== 'string') return undefined;
  const t = Date.parse(v);
  return Number.isNaN(t) ? undefined : t;
}

export function parseClaudeCodeJsonl(content: string, fallbackName: string): ParsedConversation[] {
  const bySession = new Map<string, ParsedMessage[]>();
  const timestamps = new Map<string, number[]>();
  const models = new Map<string, string[]>();
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let rec: Record<string, unknown>;
    try {
      rec = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (rec.isSidechain === true || rec.isMeta === true) continue;
    if (rec.type !== 'user' && rec.type !== 'assistant') continue;
    const sessionId = typeof rec.sessionId === 'string' ? rec.sessionId : '';
    if (!sessionId) continue;
    const msg = rec.message as Record<string, unknown> | undefined;
    if (!msg) continue;
    const role = msg.role === 'user' || msg.role === 'assistant' ? msg.role : null;
    if (!role) continue;
    const text = extractContent(msg.content);
    if (text.trim().length === 0) continue;
    const list = bySession.get(sessionId) ?? [];
    list.push({
      externalId: typeof rec.uuid === 'string' ? rec.uuid : undefined,
      role,
      content: text,
      model: typeof msg.model === 'string' ? msg.model : undefined,
      timestamp: toMs(rec.timestamp),
      seq: list.length,
    });
    bySession.set(sessionId, list);
    if (typeof rec.timestamp === 'string') {
      const ts = toMs(rec.timestamp);
      if (ts !== undefined) timestamps.set(sessionId, [...(timestamps.get(sessionId) ?? []), ts]);
    }
    if (typeof msg.model === 'string') {
      models.set(sessionId, [...(models.get(sessionId) ?? []), msg.model]);
    }
  }
  const out: ParsedConversation[] = [];
  for (const [sessionId, messages] of bySession) {
    if (messages.length === 0) continue;
    const ts = timestamps.get(sessionId) ?? [];
    out.push({
      source: 'claude-code',
      externalId: sessionId,
      title: `${fallbackName}/${sessionId.slice(0, 8)}`,
      model: models.get(sessionId)?.[0],
      createdAt: ts.length > 0 ? Math.min(...ts) : undefined,
      updatedAt: ts.length > 0 ? Math.max(...ts) : undefined,
      messages,
    });
  }
  return out;
}

export function collectClaudeCodeFiles(rootPath: string): string[] {
  const stat = fs.statSync(rootPath);
  if (stat.isFile()) return [rootPath];
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile() && /\.(jsonl|zstd|zst)$/i.test(entry.name)) out.push(full);
    }
  };
  walk(rootPath);
  return out;
}
