import type { ParsedConversation, ParsedMessage } from './types.js';

interface ChatGptNode {
  id: string;
  message?: {
    id?: string | null;
    author?: { role?: string };
    create_time?: number | null;
    model?: string | null;
    content?: { content_type?: string; parts?: unknown[] };
  } | null;
  parent?: string | null;
  children?: string[];
}

function extractText(content: { content_type?: string; parts?: unknown[] } | undefined): string {
  if (!content) return '';
  if (content.content_type === 'text' && Array.isArray(content.parts)) {
    return content.parts.filter((p): p is string => typeof p === 'string').join('');
  }
  return '';
}

export function parseChatGptConversations(data: unknown): ParsedConversation[] {
  if (!Array.isArray(data)) throw new Error('ChatGPT 导出格式错误：顶层应为会话数组');
  const out: ParsedConversation[] = [];
  for (const conv of data as Record<string, unknown>[]) {
    const mapping = conv.mapping as Record<string, ChatGptNode> | undefined;
    if (!mapping || typeof conv.id !== 'string') continue;
    const messages: ParsedMessage[] = [];
    const visited = new Set<string>();
    const walk = (nodeId: string): void => {
      if (visited.has(nodeId)) return;
      visited.add(nodeId);
      const node = mapping[nodeId];
      if (!node) return;
      const msg = node.message;
      if (msg && (msg.author?.role === 'user' || msg.author?.role === 'assistant')) {
        const text = extractText(msg.content);
        if (text.trim().length > 0) {
          messages.push({
            externalId: msg.id || node.id,
            role: msg.author!.role as 'user' | 'assistant',
            content: text,
            model: msg.model || undefined,
            timestamp: msg.create_time ? msg.create_time * 1000 : undefined,
            seq: messages.length,
          });
        }
      }
      for (const child of node.children || []) walk(child);
    };
    for (const node of Object.values(mapping)) {
      if (!node.parent) walk(node.id);
    }
    if (messages.length === 0) continue;
    const model = messages.find((m) => m.model)?.model;
    out.push({
      source: 'chatgpt',
      externalId: conv.id as string,
      title: typeof conv.title === 'string' ? conv.title : undefined,
      model,
      createdAt: typeof conv.create_time === 'number' ? conv.create_time * 1000 : messages[0].timestamp,
      updatedAt: typeof conv.update_time === 'number' ? conv.update_time * 1000 : undefined,
      messages,
    });
  }
  return out;
}
