import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig, normalizeBaseUrl, ollamaNativeBase, type ArchiveConfig, type LlmConfig } from '../config.js';
import { resolveWeights, saveSettings, settingsPath, type RetrievalWeights } from '../config/store.js';
import { openDb, type Db } from '../db/connection.js';
import { migrate, readEmbedDim } from '../db/schema.js';
import { importPaths } from '../importers/index.js';
import { stableId } from '../importers/core.js';
import { createEmbedder, type Embedder } from '../search/embed.js';
import { ensureMessageEmbeddings, getEntityContext, queryMemory, searchMessages } from '../search/hybrid.js';
import { invalidateSearchCaches } from '../search/cache.js';
import { runDistill, distillableCount } from '../memory/pipeline.js';

/**
 * 本地可视化界面（替代终端操作）。
 *
 * 设计原则：
 * - 只监听 127.0.0.1，不做鉴权（本机工具）；云端 API Key 只在蒸馏请求里临时使用，
 *   或由用户在设置里显式保存到 `~/.ai-chat-archive/config.json`。
 * - 零前端依赖：静态资产从仓库 `assets/ui/` 读取（瑞士风格，见该目录）。
 * - 长任务用流式响应（模型安装走 Ollama 的 /api/pull NDJSON）。
 */

const HOST = '127.0.0.1';
const DEFAULT_PORT = 7788;
const MAX_BODY_BYTES = 256 * 1024;

const PRESET_LLM_MODELS = [
  { id: 'qwen2.5:1.5b', label: 'Qwen2.5 1.5B', note: '最快，约 1.0GB' },
  { id: 'qwen2.5:3b', label: 'Qwen2.5 3B', note: '推荐：质量与速度平衡，约 1.9GB' },
  { id: 'qwen2.5:7b', label: 'Qwen2.5 7B', note: '质量更好，约 4.7GB，建议 8GB+ 显存' },
  { id: 'qwen3:4b', label: 'Qwen3 4B', note: '带推理链，约 2.6GB' },
];

const PRESET_EMBED_MODELS = [
  { id: 'bge-m3', label: 'bge-m3', note: '1024 维，中文效果好（默认）' },
  { id: 'nomic-embed-text', label: 'nomic-embed-text', note: '768 维，换它需要重建库' },
];

class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e));

function assetsDir(): string {
  // dist/ui/server.js 与 src/ui/server.ts 都在仓库内，向上两级即仓库根
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, '..', '..', 'assets', 'ui');
}

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
}

function sendText(res: http.ServerResponse, status: number, text: string, type = 'text/plain; charset=utf-8'): void {
  res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store' });
  res.end(text);
}

function readJsonBody(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        req.destroy();
        reject(new ApiError(413, '请求体过大'));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8').trim();
      if (!raw) return resolve({});
      try {
        const parsed = JSON.parse(raw) as unknown;
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
          return reject(new ApiError(400, '请求体必须是 JSON 对象'));
        }
        resolve(parsed as Record<string, unknown>);
      } catch {
        reject(new ApiError(400, '请求体不是合法 JSON'));
      }
    });
    req.on('error', (e) => reject(new ApiError(400, `读取请求失败：${errText(e)}`)));
  });
}

async function fetchJson(url: string, init: RequestInit = {}, timeoutMs = 5000): Promise<unknown> {
  const res = await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  const text = await res.text();
  if (!res.ok) throw new ApiError(502, `上游返回 ${res.status}：${text.slice(0, 300)}`);
  return text ? (JSON.parse(text) as unknown) : {};
}

/** Ollama 原生地址：优先 ACA_OLLAMA_BASE，否则从 OpenAI 兼容地址去掉 /v1 */
function ollamaBase(cfg: ArchiveConfig): string {
  return normalizeBaseUrl(process.env.ACA_OLLAMA_BASE || ollamaNativeBase(cfg.embed.baseUrl || cfg.llm.baseUrl));
}

interface OllamaProbe {
  available: boolean;
  models: { name: string; size: number }[];
  base: string;
  error?: string;
}

async function probeOllama(cfg: ArchiveConfig): Promise<OllamaProbe> {
  const base = ollamaBase(cfg);
  try {
    const data = (await fetchJson(`${base}/api/tags`, {}, 2500)) as { models?: { name?: string; size?: number }[] };
    const models = (data.models ?? [])
      .map((m) => ({ name: String(m.name ?? ''), size: Number(m.size ?? 0) }))
      .filter((m) => m.name.length > 0);
    return { available: true, models, base };
  } catch (e) {
    return { available: false, models: [], base, error: errText(e) };
  }
}

function llmConfigFor(cfg: ArchiveConfig, body: Record<string, unknown>, provider: string): LlmConfig {
  const baseUrl = normalizeBaseUrl(String(body.baseUrl ?? '') || cfg.llm.baseUrl);
  const model = String(body.model ?? '').trim() || cfg.llm.model;
  const apiKey = String(body.apiKey ?? '').trim() || cfg.llm.apiKey;
  if (!model) throw new ApiError(400, '缺少模型名（model）');
  if (provider === 'cloud' && !apiKey) throw new ApiError(400, '云端蒸馏需要 API Key');
  return { ...cfg.llm, baseUrl, model, apiKey };
}

export interface UiServerOptions {
  cfg?: ArchiveConfig;
  port?: number;
  host?: string;
}

export interface UiServerHandle {
  url: string;
  port: number;
  server: http.Server;
  close: () => Promise<void>;
}

export async function createUiServer(options: UiServerOptions = {}): Promise<UiServerHandle> {
  const cfg = options.cfg ?? loadConfig();
  const db: Db = openDb(cfg.dbPath, cfg.password);
  migrate(db, cfg.embed.dim);
  let embedder: Embedder = createEmbedder(cfg.embed);

  const count = (sql: string): number => (db.prepare(sql).get() as { n: number }).n;

  async function state(): Promise<unknown> {
    const ollama = await probeOllama(cfg);
    return {
      db: {
        path: cfg.dbPath,
        conversations: count('SELECT COUNT(*) n FROM conversations'),
        messages: count('SELECT COUNT(*) n FROM messages'),
        embedded: count('SELECT COUNT(*) n FROM message_vec'),
        entities: count('SELECT COUNT(*) n FROM entities'),
        facts: count('SELECT COUNT(*) n FROM facts'),
        memories: count('SELECT COUNT(*) n FROM memories'),
        pendingDistill: distillableCount(db),
        dim: readEmbedDim(db) ?? cfg.embed.dim,
      },
      providers: {
        llm: { baseUrl: cfg.llm.baseUrl, model: cfg.llm.model ?? null, hasKey: Boolean(cfg.llm.apiKey) },
        embed: { provider: cfg.embed.provider, model: cfg.embed.model, dim: cfg.embed.dim },
      },
      weights: resolveWeights(),
      ollama: { available: ollama.available, models: ollama.models },
      presets: { llmModels: PRESET_LLM_MODELS, embedModels: PRESET_EMBED_MODELS },
    };
  }

  async function search(body: Record<string, unknown>): Promise<unknown> {
    const query = String(body.query ?? '').trim();
    if (!query) throw new ApiError(400, '缺少查询内容（query）');
    const limit = Math.min(50, Math.max(1, Number(body.limit ?? 8) || 8));
    const weights = body.weights && typeof body.weights === 'object' ? (body.weights as Partial<RetrievalWeights>) : undefined;
    const started = Date.now();
    const messages = await searchMessages(db, embedder, query, {
      limit,
      source: body.source ? String(body.source) : undefined,
      weights,
    });
    let memories: unknown[] = [];
    let facts: unknown[] = [];
    if (body.includeMemory !== false) {
      const memory = await queryMemory(db, embedder, query, { limit });
      memories = memory.memories;
      facts = memory.facts;
    }
    return { messages, memories, facts, elapsedMs: Date.now() - started };
  }

  async function pullModel(model: string, res: http.ServerResponse): Promise<void> {
    if (!model.trim()) throw new ApiError(400, '缺少模型名（model）');
    const base = ollamaBase(cfg);
    let upstream: Response;
    try {
      upstream = await fetch(`${base}/api/pull`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model, stream: true }),
      });
    } catch (e) {
      throw new ApiError(502, `无法连接 Ollama（${base}）：${errText(e)}。请先启动 ollama serve`);
    }
    if (!upstream.ok || !upstream.body) {
      const detail = await upstream.text().catch(() => '');
      throw new ApiError(502, `Ollama 安装失败（${upstream.status}）：${detail.slice(0, 300) || '请确认 ollama serve 正在运行'}`);
    }
    res.writeHead(200, { 'content-type': 'application/x-ndjson; charset=utf-8', 'cache-control': 'no-store' });
    const reader = upstream.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          try {
            const evt = JSON.parse(trimmed) as { status?: string; error?: string; completed?: number; total?: number };
            if (evt.error) res.write(`${JSON.stringify({ status: 'error', error: evt.error })}\n`);
            else
              res.write(
                `${JSON.stringify({
                  status: 'line',
                  line: evt.status ?? '',
                  completed: evt.completed ?? null,
                  total: evt.total ?? null,
                })}\n`
              );
          } catch {
            res.write(`${JSON.stringify({ status: 'line', line: trimmed })}\n`);
          }
        }
      }
      res.write(`${JSON.stringify({ status: 'done' })}\n`);
    } finally {
      reader.releaseLock();
      res.end();
    }
  }

  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', `http://${HOST}`);
    const pathname = decodeURIComponent(url.pathname);

    void (async () => {
      try {
        // ---------------- 静态资源 ----------------
        if (req.method === 'GET' && (pathname === '/' || pathname === '/index.html')) {
          const file = path.join(assetsDir(), 'index.html');
          if (!fs.existsSync(file)) throw new ApiError(500, '缺少前端资源 assets/ui/index.html');
          return sendText(res, 200, fs.readFileSync(file, 'utf8'), 'text/html; charset=utf-8');
        }
        if (req.method === 'GET' && ['/app.js', '/style.css', '/favicon.svg'].includes(pathname)) {
          const file = path.join(assetsDir(), pathname.slice(1));
          if (!fs.existsSync(file)) throw new ApiError(404, `资源不存在：${pathname}`);
          const type = pathname.endsWith('.css')
            ? 'text/css; charset=utf-8'
            : pathname.endsWith('.js')
              ? 'text/javascript; charset=utf-8'
              : 'image/svg+xml';
          return sendText(res, 200, fs.readFileSync(file, 'utf8'), type);
        }

        // ---------------- JSON API ----------------
        if (req.method === 'GET' && pathname === '/api/state') return sendJson(res, 200, await state());

        if (req.method === 'POST' && pathname === '/api/search') return sendJson(res, 200, await search(await readJsonBody(req)));

        if (req.method === 'POST' && pathname === '/api/import') {
          const body = await readJsonBody(req);
          const paths = Array.isArray(body.paths) ? body.paths.map(String).filter(Boolean) : [];
          if (paths.length === 0) throw new ApiError(400, '缺少导入路径（paths）');
          const result = importPaths(db, paths);
          invalidateSearchCaches();
          return sendJson(res, 200, result);
        }

        if (req.method === 'POST' && pathname === '/api/index') {
          const embedded = await ensureMessageEmbeddings(db, embedder);
          return sendJson(res, 200, { embedded });
        }

        if (req.method === 'POST' && pathname === '/api/distill') {
          const body = await readJsonBody(req);
          const provider = String(body.provider ?? 'ollama');
          const llm = llmConfigFor(cfg, body, provider);
          const result = await runDistill(db, embedder, llm, {
            limit: Math.min(20, Math.max(1, Number(body.limit ?? 5) || 5)),
            maxChars: Math.min(40_000, Math.max(1000, Number(body.maxChars ?? 8000) || 8000)),
            force: body.force === true,
          });
          return sendJson(res, 200, result);
        }

        if (req.method === 'GET' && pathname === '/api/entity') {
          const name = url.searchParams.get('name');
          if (name) {
            const context = getEntityContext(db, name);
            return sendJson(res, 200, context ?? { error: `未找到实体: ${name}` });
          }
          const limit = Math.min(200, Math.max(1, Number(url.searchParams.get('limit') ?? 30) || 30));
          const type = url.searchParams.get('type');
          const rows = type
            ? db.prepare(`SELECT name, type, mention_count FROM entities WHERE type = ? ORDER BY mention_count DESC LIMIT ?`).all(type, limit)
            : db.prepare(`SELECT name, type, mention_count FROM entities ORDER BY mention_count DESC LIMIT ?`).all(limit);
          return sendJson(res, 200, { entities: rows });
        }

        if (req.method === 'POST' && pathname === '/api/remember') {
          const body = await readJsonBody(req);
          const content = String(body.content ?? '').trim();
          if (!content) throw new ApiError(400, '缺少记忆内容（content）');
          const layer = String(body.layer ?? 'semantic');
          const importance = Math.min(1, Math.max(0, Number(body.importance ?? 0.5) || 0.5));
          const id = stableId('memory', content);
          db.prepare(`INSERT OR REPLACE INTO memories (id, layer, content, importance, created_at) VALUES (?, ?, ?, ?, ?)`).run(
            id,
            layer,
            content,
            importance,
            Date.now()
          );
          const [vec] = await embedder.embed([content]);
          db.prepare('INSERT OR REPLACE INTO memory_vec (memory_id, embedding) VALUES (?, ?)').run(id, JSON.stringify(vec));
          invalidateSearchCaches();
          return sendJson(res, 200, { ok: true, id });
        }

        if (req.method === 'GET' && pathname === '/api/config') {
          return sendJson(res, 200, {
            weights: resolveWeights(),
            llm: { baseUrl: cfg.llm.baseUrl, model: cfg.llm.model ?? null, hasKey: Boolean(cfg.llm.apiKey) },
            embed: { provider: cfg.embed.provider, model: cfg.embed.model, dim: cfg.embed.dim },
            settingsPath: settingsPath(),
          });
        }

        if (req.method === 'PUT' && pathname === '/api/config') {
          const body = await readJsonBody(req);
          const patch: Record<string, unknown> = {};
          if (body.weights && typeof body.weights === 'object') patch.weights = body.weights;
          if (body.llm && typeof body.llm === 'object') patch.llm = body.llm;
          if (body.embed && typeof body.embed === 'object') patch.embed = body.embed;
          const saved = saveSettings(patch as never);
          // 本次进程内立即生效（无需重启）
          const reloaded = loadConfig({ dbPath: cfg.dbPath, password: cfg.password });
          Object.assign(cfg.llm, reloaded.llm);
          Object.assign(cfg.embed, reloaded.embed);
          embedder = createEmbedder(cfg.embed);
          invalidateSearchCaches();
          return sendJson(res, 200, { ok: true, settings: saved, weights: resolveWeights() });
        }

        if (req.method === 'GET' && pathname === '/api/models') {
          const ollama = await probeOllama(cfg);
          return sendJson(res, 200, { available: ollama.available, base: ollama.base, installed: ollama.models, error: ollama.error });
        }

        if (req.method === 'POST' && pathname === '/api/models/pull') {
          const body = await readJsonBody(req);
          return await pullModel(String(body.model ?? ''), res);
        }

        throw new ApiError(404, `未知接口：${req.method} ${pathname}`);
      } catch (e) {
        if (res.headersSent) {
          res.end();
          return;
        }
        const status = e instanceof ApiError ? e.status : 500;
        sendJson(res, status, { error: errText(e) });
      }
    })();
  });

  const port = options.port ?? Number(process.env.ACA_UI_PORT || DEFAULT_PORT);
  const host = options.host ?? HOST;
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => resolve());
  });
  const actualPort = (server.address() as { port: number }).port;

  return {
    url: `http://${host}:${actualPort}`,
    port: actualPort,
    server,
    close: async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      db.close();
    },
  };
}
