import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { openDb } from '../src/db/connection.js';
import { migrate } from '../src/db/schema.js';
import { importPaths } from '../src/importers/index.js';
import { loadConfig } from '../src/config.js';
import { settingsPath } from '../src/config/store.js';
import { createUiServer } from '../src/ui/server.js';

let passed = 0;
let failed = 0;
function check(name: string, cond: boolean, extra?: string): void {
  if (cond) {
    passed++;
    console.log(`[PASS] ${name}`);
  } else {
    failed++;
    console.log(`[FAIL] ${name}${extra ? ' — ' + extra : ''}`);
  }
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aca-ui-'));
// 隔离：设置文件写临时目录，绝不动用户 ~/.ai-chat-archive
process.env.ACA_HOME = tmp;
for (const k of ['ACA_DB', 'ACA_PASSWORD', 'ACA_LLM_MODEL', 'ACA_LLM_BASE_URL', 'ACA_EMBED_PROVIDER', 'ACA_EMBED_MODEL', 'ACA_EMBED_DIM']) {
  delete process.env[k];
}

const dbPath = path.join(tmp, 'archive.db');
const password = 'ui-test-pass';
const db = openDb(dbPath, password);
migrate(db, 1024);
const fixture = path.join(tmp, 'claude.json');
fs.writeFileSync(
  fixture,
  JSON.stringify([
    {
      uuid: 'ui-conv-1',
      name: 'TypeScript 泛型讨论',
      created_at: '2026-11-20T08:00:00.000Z',
      chat_messages: [
        { sender: 'human', text: 'TypeScript 的条件类型怎么用？' },
        { sender: 'assistant', text: '条件类型形如 T extends U ? X : Y，配合 infer 可以抽取类型。' },
      ],
    },
    {
      uuid: 'ui-conv-2',
      name: '本地归档检索',
      created_at: '2026-11-21T08:00:00.000Z',
      chat_messages: [
        { sender: 'human', text: '向量检索和中文分词怎么配合？' },
        { sender: 'assistant', text: '用 jieba 写 FTS5，再叠加 sqlite-vec 向量召回，RRF 融合。' },
      ],
    },
  ])
);
importPaths(db, [fixture]);
db.close();

// ---- 假的 Ollama：/api/tags + /api/pull 流 ----
const ollama = http.createServer((req, res) => {
  if (req.url === '/api/tags') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ models: [{ name: 'qwen2.5:3b', size: 1_929_912_432 }, { name: 'bge-m3:latest', size: 1_157_671_200 }] }));
    return;
  }
  if (req.url === '/api/pull' && req.method === 'POST') {
    req.resume();
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'application/x-ndjson' });
      res.write(`${JSON.stringify({ status: 'pulling manifest' })}\n`);
      res.write(`${JSON.stringify({ status: 'downloading', completed: 10, total: 100 })}\n`);
      res.end(`${JSON.stringify({ status: 'success' })}\n`);
    });
    return;
  }
  res.writeHead(404).end('{}');
});
await new Promise<void>((r) => ollama.listen(0, '127.0.0.1', r));
const ollamaBase = `http://127.0.0.1:${(ollama.address() as { port: number }).port}`;
process.env.ACA_OLLAMA_BASE = ollamaBase;

const cfg = loadConfig({ dbPath, password });
const ui = await createUiServer({ cfg, port: 0 });
const base = ui.url;

const getJson = async (p: string): Promise<{ status: number; body: Record<string, unknown> }> => {
  const res = await fetch(`${base}${p}`);
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
};
const sendJson = async (p: string, method: string, body: unknown): Promise<{ status: number; body: Record<string, unknown> }> => {
  const res = await fetch(`${base}${p}`, {
    method,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
};

// ---------------- 静态页面 ----------------
const assetsExist = fs.existsSync(path.resolve('assets/ui/index.html'));
if (assetsExist) {
  const page = await fetch(`${base}/`);
  const html = await page.text();
  check('UI: 首页返回 HTML 且含关键控件', page.status === 200 && html.includes('data-testid="query-input"'), String(page.status));
  const css = await fetch(`${base}/style.css`);
  check('UI: 样式表可访问', css.status === 200 && (css.headers.get('content-type') ?? '').includes('text/css'));
} else {
  console.log('[SKIP] assets/ui 尚未生成，跳过静态页面断言');
}

// ---------------- 状态 ----------------
const state = await getJson('/api/state');
const dbState = state.body.db as { conversations: number; messages: number; dim: number };
const weights0 = state.body.weights as { fts: number; pinyin: number; vec: number };
const presets = state.body.presets as { llmModels: unknown[] };
check('state: 统计正确', state.status === 200 && dbState.conversations === 2 && dbState.messages === 4, JSON.stringify(dbState));
check('state: 维度与默认权重', dbState.dim === 1024 && weights0.fts === 1 && weights0.pinyin === 1 && weights0.vec === 1);
check('state: 内置 Qwen 预设', presets.llmModels.length >= 4);
check('state: 探测到 Ollama', (state.body.ollama as { available: boolean }).available === true);

// ---------------- 索引 + 检索 ----------------
const indexed = await sendJson('/api/index', 'POST', {});
check('index: 消息向量化', indexed.status === 200 && (indexed.body.embedded as number) === 4, JSON.stringify(indexed.body));

const s1 = await sendJson('/api/search', 'POST', { query: '条件类型', limit: 5 });
const s1messages = s1.body.messages as { content: string; via: string[] }[];
check('search: 命中对话', s1.status === 200 && s1messages.length > 0 && s1messages.some((m) => m.content.includes('条件类型')));
check('search: 返回耗时字段', typeof s1.body.elapsedMs === 'number');

const sVecOnly = await sendJson('/api/search', 'POST', { query: '条件类型', weights: { fts: 0, pinyin: 0, vec: 1 } });
const sZero = await sendJson('/api/search', 'POST', { query: '条件类型', weights: { fts: 0, pinyin: 0, vec: 0 } });
check('search: 仅向量权重也能命中', ((sVecOnly.body.messages as unknown[]) ?? []).length > 0);
check('search: 三路权重为 0 时无结果（加权生效）', ((sZero.body.messages as unknown[]) ?? []).length === 0);

// ---------------- 实体 / 记忆 ----------------
const list = await getJson('/api/entity?list=1&limit=10');
check('entity: 列表接口', list.status === 200 && Array.isArray(list.body.entities));

const remember = await sendJson('/api/remember', 'POST', { content: '用户偏好用 TypeScript 严格模式', importance: 0.9 });
check('remember: 写入成功', remember.body.ok === true && typeof remember.body.id === 'string');
const memSearch = await sendJson('/api/search', 'POST', { query: '用户偏好', limit: 5 });
check('search: 新记忆可被召回', ((memSearch.body.memories as unknown[]) ?? []).length > 0);

// ---------------- 配置持久化 ----------------
const put = await sendJson('/api/config', 'PUT', { weights: { fts: 2, pinyin: 0.5, vec: 1 } });
const cfgAfter = await getJson('/api/config');
const w = cfgAfter.body.weights as { fts: number; pinyin: number; vec: number };
check('config: 权重写入成功', put.status === 200 && w.fts === 2 && w.pinyin === 0.5 && w.vec === 1, JSON.stringify(w));
const savedFile = settingsPath();
const savedJson = fs.existsSync(savedFile) ? (JSON.parse(fs.readFileSync(savedFile, 'utf8')) as { weights?: unknown }) : {};
check('config: 落盘到 config.json（ACA_HOME 隔离）', !!savedJson.weights && path.dirname(savedFile) === tmp);

const persisted = await sendJson('/api/search', 'POST', { query: '条件类型' });
check('config: 未显式传权重时使用已保存设置', persisted.status === 200 && typeof persisted.body.messages !== 'undefined');

// ---------------- 模型 ----------------
const models = await getJson('/api/models');
check('models: 列出已安装模型', models.status === 200 && (models.body.installed as unknown[]).length === 2 && models.body.available === true);

const pullRes = await fetch(`${base}/api/models/pull`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ model: 'qwen2.5:3b' }),
});
const pullText = await pullRes.text();
const pullLines = pullText.split('\n').filter(Boolean).map((l) => JSON.parse(l) as { status: string; line?: string });
check('models/pull: NDJSON 流式返回', pullRes.status === 200 && pullLines[0]?.status === 'line' && pullLines.some((l) => l.status === 'done'), pullText.slice(0, 160));

// Ollama 不可达时给 502 + 可读错误
process.env.ACA_OLLAMA_BASE = 'http://127.0.0.1:1';
const pullFail = await sendJson('/api/models/pull', 'POST', { model: 'qwen2.5:3b' });
check('models/pull: Ollama 不可用时 502', pullFail.status === 502 && String(pullFail.body.error).includes('Ollama'), JSON.stringify(pullFail.body).slice(0, 120));

// ---------------- 错误处理 ----------------
const missing = await getJson('/api/nope');
check('错误: 未知接口返回 404 JSON', missing.status === 404 && typeof missing.body.error === 'string');
const badBody = await fetch(`${base}/api/search`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{oops' });
check('错误: 非法 JSON 返回 400', badBody.status === 400);

await ui.close();
ollama.close();
fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
