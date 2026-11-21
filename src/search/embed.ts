import crypto from 'node:crypto';
import { tokenizeArray } from '../db/tokenizer.js';
import { ollamaNativeBase, normalizeBaseUrl, type EmbedConfig, type EmbedProvider } from '../config.js';
import { HttpError, requestJson } from '../util/http.js';

export interface Embedder {
  dim: number;
  model: string;
  provider: EmbedProvider;
  embed(texts: string[]): Promise<number[][]>;
  /** 探测端点真实维度与延迟（doctor / 建库前校验用） */
  probe(): Promise<{ dim: number; model: string; latencyMs: number }>;
}

/** 嵌入模型返回维度与建库维度不一致时抛出（比 sqlite-vec 的原始报错可读得多） */
export class EmbedDimError extends Error {
  readonly expected: number;
  readonly actual: number;

  constructor(expected: number, actual: number, model: string) {
    super(
      `嵌入维度不匹配：模型 ${model} 返回 ${actual} 维，但当前配置/建库维度为 ${expected} 维。\n` +
        `提示：设置 ACA_EMBED_DIM=${actual} 并重建数据库/索引（sqlite-vec 要求建库维度固定）；` +
        `或改用 ${expected} 维模型。`
    );
    this.name = 'EmbedDimError';
    this.expected = expected;
    this.actual = actual;
  }
}

function hashEmbedOne(text: string, dim: number): number[] {
  const v = new Float64Array(dim);
  const toks = tokenizeArray(text).slice(0, 256);
  for (const tok of toks) {
    const h = crypto.createHash('sha256').update(tok).digest();
    v[h.readUInt32BE(0) % dim] += 1;
    v[h.readUInt32BE(4) % dim] -= 1;
  }
  let norm = 0;
  for (const x of v) norm += x * x;
  norm = Math.sqrt(norm) || 1;
  return Array.from(v, (x) => x / norm);
}

interface OpenAiEmbeddingResponse {
  data?: { embedding?: number[]; index?: number }[];
}

interface OllamaEmbedResponse {
  embeddings?: number[][];
}

interface OllamaLegacyEmbeddingResponse {
  embedding?: number[];
}

/** OpenAI 兼容 /embeddings（支持数组批输入） */
async function embedOpenAiCompatible(cfg: EmbedConfig, texts: string[], timeoutMs: number): Promise<number[][]> {
  const base = normalizeBaseUrl(cfg.baseUrl);
  const headers: Record<string, string> = cfg.apiKey ? { authorization: `Bearer ${cfg.apiKey}` } : {};
  const batchSize = Math.max(1, cfg.batchSize ?? 16);
  const retries = cfg.retries ?? 2;
  const out: number[][] = [];
  for (let i = 0; i < texts.length; i += batchSize) {
    const batch = texts.slice(i, i + batchSize);
    const data = await requestJson<OpenAiEmbeddingResponse>(`${base}/embeddings`, {
      method: 'POST',
      headers,
      body: { model: cfg.model, input: batch },
      timeoutMs,
      retries,
    });
    const list = data.data ?? [];
    if (list.length !== batch.length) {
      throw new Error(`embeddings 返回数量与输入不一致：期望 ${batch.length}，实际 ${list.length}`);
    }
    const ordered = list.every((d) => typeof d.index === 'number')
      ? [...list].sort((a, b) => (a.index ?? 0) - (b.index ?? 0))
      : list;
    for (const d of ordered) {
      if (!Array.isArray(d.embedding)) throw new Error('embeddings 返回缺少 embedding 字段');
      out.push(d.embedding);
    }
  }
  return out;
}

/** Ollama 原生 /api/embed（批量），失败时回退旧版 /api/embeddings（逐条） */
async function embedOllamaNative(cfg: EmbedConfig, texts: string[], timeoutMs: number): Promise<number[][]> {
  const nativeBase = ollamaNativeBase(cfg.baseUrl);
  const headers: Record<string, string> = cfg.apiKey ? { authorization: `Bearer ${cfg.apiKey}` } : {};
  const retries = cfg.retries ?? 2;
  try {
    const data = await requestJson<OllamaEmbedResponse>(`${nativeBase}/api/embed`, {
      method: 'POST',
      headers,
      // keep_alive 避免模型被卸载后首次调用重新加载（实测冷启动可达十几秒）
      body: { model: cfg.model, input: texts, ...(cfg.keepAlive ? { keep_alive: cfg.keepAlive } : {}) },
      timeoutMs,
      retries,
    });
    if (Array.isArray(data.embeddings) && data.embeddings.length === texts.length) return data.embeddings;
    if (Array.isArray(data.embeddings) && data.embeddings.length > 0) return data.embeddings;
    throw new Error('/api/embed 未返回 embeddings');
  } catch (e) {
    // 404/400：老版本 Ollama 没有 /api/embed，回退逐条接口
    if (!(e instanceof HttpError) || ![400, 404, 405].includes(e.status ?? 0)) throw e;
  }
  const out: number[][] = [];
  for (const text of texts) {
    const data = await requestJson<OllamaLegacyEmbeddingResponse>(`${nativeBase}/api/embeddings`, {
      method: 'POST',
      headers,
      body: { model: cfg.model, prompt: text, ...(cfg.keepAlive ? { keep_alive: cfg.keepAlive } : {}) },
      timeoutMs,
      retries,
    });
    if (!Array.isArray(data.embedding)) throw new Error('/api/embeddings 返回缺少 embedding 字段');
    out.push(data.embedding);
  }
  return out;
}

function validateDims(vecs: number[][], cfg: EmbedConfig): number[][] {
  for (const v of vecs) {
    if (!Array.isArray(v) || v.length === 0) throw new Error('嵌入返回格式非法（空向量）');
    if (v.length !== cfg.dim) throw new EmbedDimError(cfg.dim, v.length, cfg.model);
  }
  return vecs;
}

export function createEmbedder(cfg: EmbedConfig): Embedder {
  const dim = cfg.dim;
  const timeoutMs = cfg.timeoutMs ?? 60_000;

  if (cfg.provider === 'hash') {
    return {
      dim,
      model: 'hash',
      provider: 'hash',
      embed: async (texts) => texts.map((t) => hashEmbedOne(t, dim)),
      probe: async () => ({ dim, model: 'hash', latencyMs: 0 }),
    };
  }

  const remoteEmbed =
    cfg.provider === 'ollama'
      ? async (texts: string[]): Promise<number[][]> => {
          try {
            return await embedOllamaNative(cfg, texts, timeoutMs);
          } catch (e) {
            // 原生接口不可用时再试 OpenAI 兼容接口（部分代理只暴露 /v1）
            if (e instanceof HttpError && [400, 404, 405].includes(e.status ?? 0)) {
              return embedOpenAiCompatible(cfg, texts, timeoutMs);
            }
            throw e;
          }
        }
      : async (texts: string[]): Promise<number[][]> => {
          try {
            return await embedOpenAiCompatible(cfg, texts, timeoutMs);
          } catch (e) {
            if (e instanceof HttpError && [404, 405].includes(e.status ?? 0)) {
              return embedOllamaNative(cfg, texts, timeoutMs);
            }
            throw e;
          }
        };

  return {
    dim,
    model: cfg.model,
    provider: cfg.provider,
    async embed(texts) {
      if (texts.length === 0) return [];
      return validateDims(await remoteEmbed(texts), cfg);
    },
    async probe() {
      const started = Date.now();
      const [vec] = await remoteEmbed(['维度探测']);
      if (!vec || vec.length === 0) throw new Error('嵌入端点未返回向量');
      return { dim: vec.length, model: cfg.model, latencyMs: Date.now() - started };
    },
  };
}
