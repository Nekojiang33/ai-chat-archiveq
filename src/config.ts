import path from 'node:path';
import os from 'node:os';
import { loadSettings, resolveWeights, type RetrievalWeights } from './config/store.js';

export type EmbedProvider = 'hash' | 'openai-compatible' | 'ollama';

/** Ollama 的 OpenAI 兼容端点默认地址（用 127.0.0.1 避免 localhost 解析到 ::1） */
const DEFAULT_OLLAMA_V1 = 'http://127.0.0.1:11434/v1';

export interface EmbedConfig {
  provider: EmbedProvider;
  baseUrl: string;
  model: string;
  apiKey?: string;
  dim: number;
  /** 单批请求文本数（默认 16） */
  batchSize?: number;
  /** 单次请求超时毫秒（默认 60000） */
  timeoutMs?: number;
  /** 网络/5xx 重试次数（默认 2） */
  retries?: number;
  /** Ollama 原生接口的 keep_alive（如 "30m"，避免模型卸载后冷启动） */
  keepAlive?: string;
}

export interface LlmConfig {
  baseUrl: string;
  model?: string;
  apiKey?: string;
  /** 单次请求超时毫秒（默认 180000；本地 CPU 推理可能很慢） */
  timeoutMs?: number;
  /** 网络/5xx 重试次数（默认 2） */
  retries?: number;
  /** 最大输出 token（不设置则交给服务端默认） */
  maxTokens?: number;
  /** 采样温度（默认 0，保证抽取结果稳定） */
  temperature?: number;
  /** 是否请求 JSON 模式（默认 true；端点不支持时自动回退） */
  jsonMode?: boolean;
}

export interface ArchiveConfig {
  dbPath: string;
  password?: string;
  llm: LlmConfig;
  embed: EmbedConfig;
  /** 检索加权（fts/pinyin/vec），来自 UI 设置或默认值 */
  weights: RetrievalWeights;
}

export interface ConfigOverrides {
  dbPath?: string;
  password?: string;
}

function numEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function boolEnv(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  return !['0', 'false', 'no', 'off'].includes(raw.trim().toLowerCase());
}

/** 归一化 baseUrl：去掉首尾空白与尾部斜杠 */
export function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.trim().replace(/\/+$/, '');
}

/** 由 OpenAI 兼容 baseUrl 推导 Ollama 原生 API 根（去掉 /v1 后缀） */
export function ollamaNativeBase(baseUrl: string): string {
  return normalizeBaseUrl(baseUrl).replace(/\/v1$/, '');
}

function parseProvider(raw: string | undefined): EmbedProvider {
  switch (raw) {
    case 'ollama':
    case 'ollama-native':
      return 'ollama';
    case 'openai-compatible':
    case 'openai':
      return 'openai-compatible';
    default:
      return 'hash';
  }
}

export function loadConfig(o: ConfigOverrides = {}): ArchiveConfig {
  const stored = loadSettings();
  const dbPath = o.dbPath || process.env.ACA_DB || path.join(os.homedir(), '.ai-chat-archive', 'archive.db');
  const password = o.password || process.env.ACA_PASSWORD;
  const llm: LlmConfig = {
    baseUrl: normalizeBaseUrl(process.env.ACA_LLM_BASE_URL || stored.llm?.baseUrl || DEFAULT_OLLAMA_V1),
    model: (process.env.ACA_LLM_MODEL || stored.llm?.model)?.trim() || undefined,
    apiKey: (process.env.ACA_LLM_API_KEY || stored.llm?.apiKey)?.trim() || undefined,
    timeoutMs: numEnv('ACA_LLM_TIMEOUT_MS', 180_000),
    retries: numEnv('ACA_LLM_RETRIES', 2),
    maxTokens: process.env.ACA_LLM_MAX_TOKENS ? numEnv('ACA_LLM_MAX_TOKENS', 0) || undefined : undefined,
    temperature: process.env.ACA_LLM_TEMPERATURE !== undefined ? Number(process.env.ACA_LLM_TEMPERATURE) : 0,
    jsonMode: boolEnv('ACA_LLM_JSON_MODE', true),
  };
  const embed: EmbedConfig = {
    provider: parseProvider(process.env.ACA_EMBED_PROVIDER || stored.embed?.provider),
    baseUrl: normalizeBaseUrl(process.env.ACA_EMBED_BASE_URL || process.env.ACA_LLM_BASE_URL || stored.llm?.baseUrl || DEFAULT_OLLAMA_V1),
    model: process.env.ACA_EMBED_MODEL || stored.embed?.model || 'bge-m3',
    apiKey: process.env.ACA_EMBED_API_KEY?.trim() || undefined,
    dim: process.env.ACA_EMBED_DIM ? numEnv('ACA_EMBED_DIM', 1024) : stored.embed?.dim ?? 1024,
    batchSize: numEnv('ACA_EMBED_BATCH', 16),
    timeoutMs: numEnv('ACA_EMBED_TIMEOUT_MS', 60_000),
    retries: numEnv('ACA_EMBED_RETRIES', 2),
    keepAlive: process.env.ACA_EMBED_KEEP_ALIVE?.trim() || '30m',
  };
  return { dbPath, password, llm, embed, weights: resolveWeights() };
}

export function requirePassword(cfg: ArchiveConfig): string {
  if (!cfg.password) {
    console.error('需要数据库密码：--password 或环境变量 ACA_PASSWORD');
    process.exit(1);
  }
  return cfg.password;
}
