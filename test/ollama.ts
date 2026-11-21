/**
 * 真实 Ollama 集成测试（不是 mock）。
 *
 * 前置条件：
 *   1. 本机已启动 `ollama serve`（默认 http://127.0.0.1:11434）
 *   2. 已拉取对话模型与嵌入模型：
 *        ollama pull qwen2.5:3b
 *        ollama pull bge-m3
 *
 * 运行：
 *   ACA_OLLAMA=1 npm run test:ollama
 *
 * 环境变量：
 *   ACA_TEST_OLLAMA        Ollama 的 OpenAI 兼容 baseUrl（默认 http://127.0.0.1:11434/v1）
 *   ACA_TEST_LLM_MODEL     蒸馏用对话模型（默认 qwen2.5:3b）
 *   ACA_TEST_EMBED_MODEL   嵌入模型（默认 bge-m3，1024 维）
 *   ACA_TEST_REQUIRE=1     服务/模型缺失时由「跳过」改为「失败」（CI 用）
 *
 * 设计：服务不可用时默认 exit 0 并打印 SKIP，避免把「没装 Ollama」误判为代码缺陷；
 * 但一旦服务存在，所有断言都是真实的端到端验证（真实推理 + 真实向量 + 真实 sqlite-vec）。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { normalizeBaseUrl } from '../src/config.js';
import { openDb } from '../src/db/connection.js';
import { migrate, readEmbedDim } from '../src/db/schema.js';
import { importPaths } from '../src/importers/index.js';
import { createEmbedder, EmbedDimError } from '../src/search/embed.js';
import { searchMessages, queryMemory, ensureMessageEmbeddings } from '../src/search/hybrid.js';
import { runDistill } from '../src/memory/pipeline.js';
import { createLlm } from '../src/memory/llm.js';

const OLLAMA_V1 = normalizeBaseUrl(process.env.ACA_TEST_OLLAMA || process.env.ACA_LLM_BASE_URL || 'http://127.0.0.1:11434/v1');
const NATIVE_BASE = OLLAMA_V1.replace(/\/v1$/, '');
const LLM_MODEL = process.env.ACA_TEST_LLM_MODEL || process.env.ACA_LLM_MODEL || 'qwen2.5:3b';
const EMBED_MODEL = process.env.ACA_TEST_EMBED_MODEL || 'bge-m3';
const REQUIRE = process.env.ACA_TEST_REQUIRE === '1';
const PASSWORD = 'ollama-e2e-pass-真实测试';

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

const skipAll = (reason: string): never => {
  console.log(`\n[SKIP] ${reason}`);
  console.log('提示：启动 Ollama 并拉取模型后重跑：ollama serve & ollama pull qwen2.5:3b & ollama pull bge-m3');
  console.log(REQUIRE ? 'ACA_TEST_REQUIRE=1 已开启，按失败处理。' : '（未设置 ACA_TEST_REQUIRE=1，按跳过处理）');
  process.exit(REQUIRE ? 1 : 0);
};

async function getJson(url: string, timeoutMs = 5000): Promise<unknown> {
  const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
  return res.json();
}

function hasModel(models: string[], want: string): boolean {
  return models.some((m) => m === want || m === `${want}:latest` || `${m}:latest` === want);
}

// ---------- 0) 环境探测 ----------
console.log(`Ollama 端点: ${OLLAMA_V1}`);
let models: string[] = [];
let version = '';
try {
  const tags = (await getJson(`${NATIVE_BASE}/api/tags`)) as { models?: { name?: string }[] };
  models = (tags.models ?? []).map((m) => m.name ?? '').filter(Boolean);
  try {
    version = ((await getJson(`${NATIVE_BASE}/api/version`)) as { version?: string }).version ?? '';
  } catch {
    version = '';
  }
} catch (e) {
  skipAll(`无法连接 Ollama（${NATIVE_BASE}）：${e instanceof Error ? e.message : String(e)}`);
}
console.log(`Ollama 版本: ${version || '未知'}，已拉取模型: ${models.length} 个`);
check('Ollama 服务可达', true, version);

const missing = [LLM_MODEL, EMBED_MODEL].filter((m) => !hasModel(models, m));
if (missing.length > 0) {
  skipAll(
    `缺少模型 ${missing.join(', ')}（已安装：${models.join(', ') || '无'}）。请运行：${missing
      .map((m) => `ollama pull ${m}`)
      .join(' && ')}`
  );
}
check('对话模型已拉取', hasModel(models, LLM_MODEL), LLM_MODEL);
check('嵌入模型已拉取', hasModel(models, EMBED_MODEL), EMBED_MODEL);

// ---------- 1) 嵌入端点与真实维度 ----------
const probeCfg = {
  provider: 'ollama' as const,
  baseUrl: OLLAMA_V1,
  model: EMBED_MODEL,
  dim: 1, // 占位，probe() 返回真实维度
  batchSize: 4,
  timeoutMs: 120_000,
  retries: 1,
};
const probeEmbedder = createEmbedder(probeCfg);
let realDim = 0;
try {
  const p = await probeEmbedder.probe();
  realDim = p.dim;
  console.log(`嵌入模型 ${EMBED_MODEL} 实际维度: ${realDim}（探测 ${p.latencyMs}ms）`);
  check('嵌入端点可用', realDim > 0);
} catch (e) {
  check('嵌入端点可用', false, e instanceof Error ? e.message : String(e));
}

const embedder = createEmbedder({ ...probeCfg, dim: realDim || 1024, timeoutMs: 120_000 });

// 维度校验必须真的会拦截
try {
  await embedder.embed(['维度校验']);
  check('嵌入维度校验（匹配时放行）', true);
} catch (e) {
  check('嵌入维度校验（匹配时放行）', false, e instanceof Error ? e.message : String(e));
}
const wrongDimEmbedder = createEmbedder({ ...probeCfg, dim: (realDim || 1024) + 7 });
let dimRejected = false;
try {
  await wrongDimEmbedder.embed(['维度校验']);
} catch (e) {
  dimRejected = e instanceof EmbedDimError;
}
check('嵌入维度校验（不匹配时抛 EmbedDimError）', dimRejected);

// ---------- 2) 真实库 + 维度元数据 ----------
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aca-ollama-'));
const dbPath = path.join(tmp, 'archive.db');
const db = openDb(dbPath, PASSWORD);
migrate(db, realDim || 1024);
check('建库记录向量维度', readEmbedDim(db) === (realDim || 1024), String(readEmbedDim(db)));

let dimMismatchRejected = false;
try {
  migrate(db, (realDim || 1024) + 1);
} catch {
  dimMismatchRejected = true;
}
check('换维度打开旧库被拒绝', dimMismatchRejected);

// ---------- 3) 导入夹具（中文真实语境） ----------
const claudeExport = [
  {
    uuid: 'conv-ollama-1',
    name: '包管理器迁移讨论',
    created_at: '2026-11-10T09:00:00.000Z',
    chat_messages: [
      {
        sender: 'human',
        created_at: '2026-11-10T09:00:00.000Z',
        text: '我们把仓库从 npm 换成了 pnpm，锁文件也一起迁移了，记得把 CI 缓存路径改掉。',
      },
      {
        sender: 'assistant',
        created_at: '2026-11-10T09:00:40.000Z',
        text: '好的：先删除 package-lock.json 与 node_modules，再 corepack enable && pnpm import && pnpm install，CI 里把 cache 目录改成 pnpm store。',
      },
    ],
  },
  {
    uuid: 'conv-ollama-2',
    name: '本地知识库检索方案',
    created_at: '2026-11-12T14:30:00.000Z',
    chat_messages: [
      {
        sender: 'human',
        created_at: '2026-11-12T14:30:00.000Z',
        text: '我想给 AI 对话做一个离线知识库，用 sqlite-vec 存向量，中文分词用 jieba，再用 bge-m3 生成嵌入。',
      },
      {
        sender: 'assistant',
        created_at: '2026-11-12T14:30:35.000Z',
        text: '可以：FTS5 存关键词、sqlite-vec 存向量，查询时三路召回做 RRF 融合；注意向量维度建库后不可变更。',
      },
    ],
  },
];
const fixturePath = path.join(tmp, 'claude-export.json');
fs.writeFileSync(fixturePath, JSON.stringify(claudeExport), 'utf8');
const imported = importPaths(db, [fixturePath]);
check('导入夹具会话', imported.conversations === 2 && imported.newMessages === 4, JSON.stringify(imported));

// ---------- 4) 真实向量检索（语义路径） ----------
const warnings: string[] = [];
const embedded = await ensureMessageEmbeddings(db, embedder);
check('消息向量化（真实嵌入）', embedded === 4, `embedded=${embedded}`);
const vecCount = (db.prepare('SELECT COUNT(*) n FROM message_vec').get() as { n: number }).n;
check('消息向量覆盖全部消息', vecCount === 4, `message_vec=${vecCount}`);

const semanticQ = '前端依赖安装工具的偏好';
const semanticHits = await searchMessages(db, embedder, semanticQ, { onWarn: (m) => warnings.push(m) });
check('检索过程中无向量降级告警', warnings.length === 0, warnings.join('; '));
check(
  '语义检索命中向量路（查询词与原文无字面重合）',
  semanticHits.length > 0 && semanticHits.some((h) => h.via.includes('vec')),
  JSON.stringify(semanticHits.map((h) => ({ via: h.via, text: h.content.slice(0, 24) })))
);
check(
  '语义检索排序合理（首选消息与包管理相关）',
  semanticHits.length > 0 && /pnpm|npm|package/i.test(semanticHits[0].content),
  semanticHits[0]?.content.slice(0, 60)
);

// ---------- 5) 真实 LLM：JSON 往返 ----------
const llmCfg = {
  baseUrl: OLLAMA_V1,
  model: LLM_MODEL,
  timeoutMs: Number(process.env.ACA_TEST_LLM_TIMEOUT_MS || 300_000),
  retries: 1,
  temperature: 0,
  jsonMode: true,
};
const llm = createLlm(llmCfg);
if (!llm) throw new Error('createLlm 返回 null');
check('createLlm 可用', true);

const listed = await llm.listModels();
check('listModels 能列出模型', listed.length >= 1, `got ${listed.length}`);

const t0 = Date.now();
let jsonRoundTrip: unknown = null;
try {
  jsonRoundTrip = await llm.chatJson('你是自检助手，只输出 JSON。', '请只输出 JSON：{"ok": true, "model": "self-test"}');
} catch (e) {
  jsonRoundTrip = null;
  console.log(`  LLM 错误: ${e instanceof Error ? e.message : String(e)}`);
}
check('LLM JSON 模式往返成功', !!jsonRoundTrip && typeof jsonRoundTrip === 'object');
console.log(`  真实推理耗时 ${Date.now() - t0}ms → ${JSON.stringify(jsonRoundTrip)}`);

// ---------- 6) 真实蒸馏管线 ----------
const distillWarnings: string[] = [];
const tDistill = Date.now();
const dr = await runDistill(db, embedder, llmCfg, {
  limit: 5,
  maxChars: 8000,
  onProgress: (m) => console.log(`  ${m}`),
  onWarn: (m) => distillWarnings.push(m),
});
console.log(`  蒸馏耗时 ${((Date.now() - tDistill) / 1000).toFixed(1)}s`);
check('蒸馏处理全部会话', dr.conversations === 2, JSON.stringify(dr));
check('蒸馏无错误', dr.errors.length === 0, dr.errors.join(' | '));
check('抽取到事实', dr.facts > 0, `facts=${dr.facts}`);
check('生成情景记忆', dr.memories > 0, `memories=${dr.memories}`);
check('实体入库', dr.entities > 0, `entities=${dr.entities}`);
check('蒸馏无致命告警', distillWarnings.length === 0, distillWarnings.join('; '));

// ---------- 7) 记忆检索（真实语义） ----------
const memWarnings: string[] = [];
const mem = await queryMemory(db, embedder, '我以前说过用哪个包管理器和什么检索方案？', {
  onWarn: (m) => memWarnings.push(m),
});
check('记忆查询无降级告警', memWarnings.length === 0, memWarnings.join('; '));
check('记忆查询有结果（记忆或事实）', mem.memories.length + mem.facts.length > 0, JSON.stringify({ m: mem.memories.length, f: mem.facts.length }));
check(
  '记忆内容与真实对话相关',
  [...mem.memories.map((x) => x.content), ...mem.facts.map((x) => x.content)].some((c) => /pnpm|npm|sqlite|向量|bge/i.test(c)),
  JSON.stringify([...mem.memories, ...mem.facts].map((x) => x.content.slice(0, 40)))
);

// ---------- 8) 幂等重跑 ----------
const dr2 = await runDistill(db, embedder, llmCfg, { limit: 5, maxChars: 8000 });
check('重复蒸馏不再重复入库', dr2.facts === 0 && dr2.memories === 0, JSON.stringify(dr2));

db.close();
fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\n${passed} passed, ${failed} failed（模型：${LLM_MODEL} + ${EMBED_MODEL}）`);
process.exit(failed > 0 ? 1 : 0);
