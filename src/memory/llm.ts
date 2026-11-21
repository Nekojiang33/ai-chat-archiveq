import { normalizeBaseUrl, ollamaNativeBase, type LlmConfig } from '../config.js';
import { HttpError, requestJson } from '../util/http.js';

export interface LlmClient {
  readonly model: string;
  readonly baseUrl: string;
  /** 要求模型输出并返回 JSON（自动容错代码块 / 前后废话 / thinking 字段） */
  chatJson(system: string, user: string): Promise<unknown>;
  /** 纯文本补全 */
  chatText(system: string, user: string): Promise<string>;
  /** 列出端点可用模型（OpenAI 兼容 /models 优先，回退 Ollama /api/tags） */
  listModels(): Promise<string[]>;
}

export class LlmError extends Error {
  readonly status?: number;

  constructor(message: string, status?: number) {
    super(message);
    this.name = 'LlmError';
    this.status = status;
  }
}

const JSON_ONLY_INSTRUCTION =
  '务必只输出一个合法 JSON 对象（以 { 开头、} 结尾），不要输出解释、Markdown 代码块或任何额外文字。';

function stripCodeFence(text: string): string {
  const m = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
  return m ? m[1] : text;
}

/** 从模型输出中尽力解析 JSON：整串 → 代码块 → 首个 {...} → 首个 [...] */
export function extractJson(text: string): unknown {
  const raw = text.trim();
  const candidates: string[] = [];
  if (raw) candidates.push(raw);
  const fenced = stripCodeFence(text).trim();
  if (fenced && fenced !== raw) candidates.push(fenced);
  for (const c of candidates) {
    try {
      return JSON.parse(c);
    } catch {
      /* 继续尝试 */
    }
  }
  const body = fenced || raw;
  const objStart = body.indexOf('{');
  const objEnd = body.lastIndexOf('}');
  if (objStart >= 0 && objEnd > objStart) {
    try {
      return JSON.parse(body.slice(objStart, objEnd + 1));
    } catch {
      /* 继续尝试 */
    }
  }
  const arrStart = body.indexOf('[');
  const arrEnd = body.lastIndexOf(']');
  if (arrStart >= 0 && arrEnd > arrStart) {
    try {
      return JSON.parse(body.slice(arrStart, arrEnd + 1));
    } catch {
      /* 继续尝试 */
    }
  }
  throw new LlmError(`LLM 输出不是有效 JSON：${text.slice(0, 200)}`);
}

interface ChatCompletionResponse {
  choices?: {
    message?: { content?: string | null; thinking?: string | null; reasoning?: string | null };
    text?: string | null;
  }[];
  response?: string;
  error?: { message?: string } | string;
}

interface ErrorPayload {
  error?: { message?: string } | string;
}

function readContent(data: ChatCompletionResponse): string {
  const choice = data.choices?.[0];
  const parts = [
    choice?.message?.content ?? '',
    // qwen3 等带思考链的模型可能把内容放在 thinking/reasoning 字段
    choice?.message?.thinking ?? '',
    choice?.message?.reasoning ?? '',
    choice?.text ?? '',
    data.response ?? '',
  ];
  return parts.filter((p): p is string => typeof p === 'string' && p.length > 0).join('\n');
}

function errorMessageOf(payload: unknown): string | undefined {
  if (!payload || typeof payload !== 'object') return undefined;
  const err = (payload as ErrorPayload).error;
  if (typeof err === 'string') return err;
  if (err && typeof err === 'object' && typeof err.message === 'string') return err.message;
  return undefined;
}

/** 把底层 HTTP/网络错误翻译成可操作的中文提示 */
export function describeLlmFailure(e: unknown, baseUrl: string, model: string): LlmError {
  if (e instanceof LlmError) return e;
  if (e instanceof HttpError) {
    const status = e.status ?? 0;
    let hint = '';
    if (status === 404) {
      hint = `模型或端点不存在。请确认模型已拉取（ollama pull ${model}），且 ACA_LLM_BASE_URL 指向 OpenAI 兼容端点（如 ${baseUrl}）。`;
    } else if (status === 400 || status === 422) {
      hint = '请求被端点拒绝：常见原因是该模型不支持 response_format/JSON 模式，可尝试 ACA_LLM_JSON_MODE=0 或更换模型。';
    } else if (status === 401 || status === 403) {
      hint = '鉴权失败：远端端点需要 ACA_LLM_API_KEY。';
    } else if (status === 429) {
      hint = '端点限流或并发过高：稍后重试，或降低蒸馏并发。';
    } else if (status >= 500) {
      hint = '服务端错误：确认模型服务正常运行（ollama serve）。';
    }
    return new LlmError(`${e.message}${hint ? `\n提示：${hint}` : ''}`, status || undefined);
  }
  const msg = e instanceof Error ? e.message : String(e);
  return new LlmError(
    `无法连接 LLM 端点 ${baseUrl}：${msg}\n提示：本地 Ollama 需先启动 \`ollama serve\`（默认 11434 端口），并确认模型 ${model} 已拉取。`
  );
}

const INT32_MAX = 2_147_483_647;

export function createLlm(cfg: LlmConfig): LlmClient | null {
  if (!cfg.model) return null;
  const model = cfg.model;
  const baseUrl = normalizeBaseUrl(cfg.baseUrl);
  const nativeBase = ollamaNativeBase(cfg.baseUrl);
  const timeoutMs = cfg.timeoutMs ?? 180_000;
  const retries = cfg.retries ?? 2;
  const temperature = cfg.temperature ?? 0;
  const jsonMode = cfg.jsonMode ?? true;
  const headers: Record<string, string> = cfg.apiKey ? { authorization: `Bearer ${cfg.apiKey}` } : {};

  const complete = async (system: string, user: string, json: boolean): Promise<string> => {
    const body: Record<string, unknown> = {
      model,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
      temperature,
      stream: false,
    };
    if (cfg.maxTokens && cfg.maxTokens > 0) body.max_tokens = Math.min(cfg.maxTokens, INT32_MAX);
    if (json) body.response_format = { type: 'json_object' };
    const data = await requestJson<ChatCompletionResponse>(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers,
      body,
      timeoutMs,
      retries,
    });
    const apiError = errorMessageOf(data);
    if (apiError) throw new LlmError(`LLM 返回错误：${apiError}`);
    const text = readContent(data);
    if (!text.trim()) throw new LlmError('LLM 返回内容为空：确认模型正常、上下文未超限。');
    return text;
  };

  const listModels = async (): Promise<string[]> => {
    const idsOf = (payload: unknown): string[] => {
      const out: string[] = [];
      const p = payload as { data?: { id?: string }[]; models?: { name?: string; model?: string }[] };
      for (const m of p?.data ?? []) if (typeof m?.id === 'string') out.push(m.id);
      for (const m of p?.models ?? []) {
        const n = m?.name ?? m?.model;
        if (typeof n === 'string') out.push(n);
      }
      return out;
    };
    try {
      const data = await requestJson<unknown>(`${baseUrl}/models`, {
        headers,
        timeoutMs: Math.min(timeoutMs, 10_000),
        retries: 0,
      });
      return idsOf(data);
    } catch {
      /* 回退 Ollama 原生端点 */
    }
    try {
      const data = await requestJson<unknown>(`${nativeBase}/api/tags`, {
        headers,
        timeoutMs: 10_000,
        retries: 0,
      });
      return idsOf(data);
    } catch {
      return [];
    }
  };

  return {
    model,
    baseUrl,

    async chatText(system, user) {
      try {
        return await complete(system, user, false);
      } catch (e) {
        throw describeLlmFailure(e, baseUrl, model);
      }
    },

    async chatJson(system, user) {
      const userWithHint = `${user}\n\n${JSON_ONLY_INSTRUCTION}`;
      let text: string;
      if (jsonMode) {
        try {
          text = await complete(system, userWithHint, true);
        } catch (e) {
          // 旧版端点可能不支持 response_format：仅在明确 400/422/404 时回退一次
          if (e instanceof HttpError && (e.status === 400 || e.status === 422 || e.status === 404)) {
            try {
              text = await complete(system, userWithHint, false);
            } catch (e2) {
              throw describeLlmFailure(e2, baseUrl, model);
            }
          } else {
            throw describeLlmFailure(e, baseUrl, model);
          }
        }
      } else {
        try {
          text = await complete(system, userWithHint, false);
        } catch (e) {
          throw describeLlmFailure(e, baseUrl, model);
        }
      }

      try {
        return extractJson(text);
      } catch (parseError) {
        // 一次纠错重试：把解析失败原因反馈给模型，再解析一次
        const repairUser = `${userWithHint}\n\n上一次输出无法解析为 JSON。请严格只输出合法 JSON。`;
        let retryText = '';
        try {
          retryText = await complete(system, repairUser, false);
        } catch {
          retryText = '';
        }
        if (retryText) {
          try {
            return extractJson(retryText);
          } catch {
            /* 落到原始解析错误 */
          }
        }
        throw parseError;
      }
    },

    listModels,
  };
}
