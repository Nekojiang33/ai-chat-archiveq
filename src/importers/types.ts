export interface ParsedMessage {
  externalId?: string;
  role: 'user' | 'assistant' | 'system' | 'tool';
  content: string;
  model?: string;
  timestamp?: number;
  seq: number;
}

export interface ParsedConversation {
  source: string;
  externalId: string;
  title?: string;
  model?: string;
  createdAt?: number;
  updatedAt?: number;
  messages: ParsedMessage[];
}
