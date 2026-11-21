/**
 * 轻量 HTTP JSON 客户端：统一超时、重试与错误信息。
 *
 * 本地模型（Ollama）在 CPU 上可能非常慢，远端服务也可能瞬时 5xx，
 * 因此把「超时 + 指数退避重试」收敛到一处，避免每个调用方各写一遍。
 */

export interface HttpJsonOptions {
  method?: 'GET' | 'POST';
  headers?: Record<string, string>;
  body?: unknown;
  /** 单次请求超时毫秒 */
  timeoutMs: number;
  /** 额外重试次数（0 表示只请求一次） */
  retries: number;
}

export class HttpError extends Error {
  readonly status?: number;

  constructor(message: string, status?: number) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
  }
}

export function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 425 || status === 429 || status >= 500;
}

function isConnectionError(e: unknown): boolean {
  if (e instanceof HttpError) return false;
  if (!(e instanceof Error)) return true;
  if (e.name === 'AbortError' || e.name === 'TimeoutError') return true;
  const cause = (e as Error & { cause?: { code?: string } }).cause;
  if (cause?.code) return true;
  // fetch 在连接失败时抛 TypeError('fetch failed')
  return e.name === 'TypeError';
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export async function requestJson<T>(url: string, o: HttpJsonOptions): Promise<T> {
  const retries = Math.max(0, Math.floor(o.retries));
  let lastError: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    let retryable = false;
    try {
      const res = await fetch(url, {
        method: o.method ?? 'GET',
        headers: { ...(o.body === undefined ? {} : { 'content-type': 'application/json' }), ...(o.headers ?? {}) },
        body: o.body === undefined ? undefined : JSON.stringify(o.body),
        signal: AbortSignal.timeout(o.timeoutMs),
      });
      if (!res.ok) {
        const detail = await res.text().catch(() => '');
        retryable = isRetryableStatus(res.status);
        throw new HttpError(
          `HTTP ${res.status} ${res.statusText}${detail ? `：${detail.slice(0, 400)}` : ''}`,
          res.status
        );
      }
      return (await res.json()) as T;
    } catch (e) {
      lastError = e;
      if (!retryable && !isConnectionError(e)) throw e;
      if (attempt === retries) break;
      await sleep(Math.min(8000, 500 * 2 ** attempt));
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}
