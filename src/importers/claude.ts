import type { ParsedConversation, ParsedMessage } from './types.js';

function toMs(v: unknown): number | undefined {
  if (typeof v === 'number') return v > 1e12 ? v : v * 1000;
  if (typeof v === 'string') {
    const t = Date.parse(v);
    return Number.isNaN(t) ? undefined : t;
  }
  return undefined;
}

function extractText(v: unknown): string {
  if (typeof v === 'string') return v;
  if (Array.isArray(v)) {
    return v
      .filter((b): b is { text: string } => typeof b === 'object' && b !== null && typeof (b as any).text === 'string')
      .map((b) => b.text)
      .join('\n');
  }
  return '';
}

function senderToRole(v: unknown): ParsedMessage['role'] | null {
  if (v === 'human' || v === 'user') return 'user';
  if (v === 'assistant') return 'assistant';
  return null;
}

export function parseClaudeConversations(data: unknown): ParsedConversation[] {
  if (!Array.isArray(data)) throw new Error('Claude 导出格式错误：顶层应为会话数组');
  const out: ParsedConversation[] = [];
  for (const conv of data as Record<string, unknown>[]) {
    const rawMsgs =
      (Array.isArray(conv.chat_messages) && conv.chat_messages) ||
      (Array.isArray(conv.messages) && conv.messages) ||
      null;
    const externalId = typeof conv.uuid === 'string' ? conv.uuid : typeof conv.id === 'string' ? conv.id : null;
    if (!rawMsgs || !externalId) continue;
    const messages: ParsedMessage[] = [];
    for (const m of rawMsgs as Record<string, unknown>[]) {
      const role = senderToRole(m.sender ?? m.role);
      if (!role) continue;
      const text = extractText(m.text ?? m.content);
      if (text.trim().length === 0) continue;
      messages.push({
        role,
        content: text,
        model: typeof m.model === 'string' ? m.model : undefined,
        timestamp: toMs(m.created_at ?? m.timestamp),
        seq: messages.length,
      });
    }
    if (messages.length === 0) continue;
    out.push({
      source: 'claude',
      externalId,
      title: typeof conv.name === 'string' ? conv.name : typeof conv.title === 'string' ? conv.title : undefined,
      createdAt: toMs(conv.created_at) ?? messages[0].timestamp,
      updatedAt: toMs(conv.updated_at) ?? undefined,
      messages,
    });
  }
  return out;
}
