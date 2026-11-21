/**
 * 性能基准：量化本地热点，用于优化前后对比。
 *
 * 运行：
 *   npm run bench                 # 默认 2000 条消息 / 200 次查询
 *   BENCH_MSGS=8000 npm run bench
 *
 * 设计要点：用 hash 嵌入，把「本地计算」与「网络/模型」分开测；
 * 每段都做 warmup，避免 JIT / SQLite 页缓存干扰。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDb } from '../src/db/connection.js';
import { migrate } from '../src/db/schema.js';
import { importPaths } from '../src/importers/index.js';
import { createEmbedder } from '../src/search/embed.js';
import { searchMessages, queryMemory, ensureMessageEmbeddings } from '../src/search/hybrid.js';
import { tokenizeBoth } from '../src/db/tokenizer.js';
import { cacheStats } from '../src/search/cache.js';

const N = Number(process.env.BENCH_MSGS || 2000);
const QUERIES = Number(process.env.BENCH_QUERIES || 200);
const DIM = 1024;

function report(label: string, n: number, dt: number, extra = ''): void {
  const perOp = dt / Math.max(1, n);
  console.log(
    `${label.padEnd(32)} ${String(n).padStart(6)} 次  ${dt.toFixed(0).padStart(7)} ms  ${perOp.toFixed(3).padStart(8)} ms/次  ${extra}`
  );
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aca-bench-'));
const dbPath = path.join(tmp, 'bench.db');

const ZH = ['向量检索', '中文分词', '本地归档', '加密数据库', '记忆蒸馏', '混合检索', '拼音检索', '性能优化'];
const EN = ['sqlite-vec', 'better-sqlite3', 'node-gyp', 'mcp server', 'ollama', 'bge-m3'];
const FILLER = '我们把方案拆成关键词、拼音和语义三路召回，再按 RRF 融合排序，并对结果做去重与截断。';

function textFor(i: number): string {
  return `第 ${i} 条：讨论 ${ZH[i % ZH.length]} 与 ${EN[(i * 7) % EN.length]} 的落地方案。${FILLER}`;
}

// ---------------- 1. 分词 ----------------
function benchTokenize(): void {
  const samples = Array.from({ length: 400 }, (_, i) => textFor(i));
  const rounds = 25; // 10000 次
  for (const s of samples.slice(0, 50)) tokenizeBoth(s);
  const t0 = performance.now();
  let units = 0;
  for (let r = 0; r < rounds; r++) {
    for (const s of samples) {
      const t = tokenizeBoth(s);
      units += t.content.length + t.pinyin.length;
    }
  }
  report('分词 tokenizeBoth（导入路径）', rounds * samples.length, performance.now() - t0, `产出字符 ${units}`);
}

// ---------------- 2. 导入 ----------------
const convCount = Math.max(1, Math.round(N / 10));
const exportData = Array.from({ length: convCount }, (_, c) => ({
  uuid: `conv-${c}`,
  name: `压测会话 ${c}`,
  created_at: '2026-11-21T00:00:00.000Z',
  chat_messages: Array.from({ length: 10 }, (_, m) => {
    const i = c * 10 + m;
    return { sender: m % 2 === 0 ? 'human' : 'assistant', text: textFor(i) };
  }),
}));
const fixture = path.join(tmp, 'bench.json');
fs.writeFileSync(fixture, JSON.stringify(exportData));

const db = openDb(dbPath, 'bench-pass');
migrate(db, DIM);

let t = performance.now();
const imp = importPaths(db, [fixture]);
report('导入（jieba+拼音+FTS）', imp.newMessages, performance.now() - t, `${imp.conversations} 会话`);

// 纯英文夹具：验证「无中文时跳过拼音」的收益
{
  const enDb = openDb(path.join(tmp, 'bench-en.db'), 'bench-pass');
  migrate(enDb, DIM);
  const enFixture = path.join(tmp, 'bench-en.json');
  fs.writeFileSync(
    enFixture,
    JSON.stringify(
      exportData.map((c) => ({
        uuid: c.uuid + '-en',
        name: c.name + '-en',
        created_at: c.created_at,
        chat_messages: c.chat_messages.map((m) => ({ sender: m.sender, text: m.text.replace(/第 \d+ 条：讨论 [^ ]+ 与/, 'Item discusses') })),
      }))
    )
  );
  const t0 = performance.now();
  const enImp = importPaths(enDb, [enFixture]);
  report('导入（纯英文，跳过拼音）', enImp.newMessages, performance.now() - t0);
  enDb.close();
}

// ---------------- 3. 向量化（hash，仅本地） ----------------
const embedder = createEmbedder({ provider: 'hash', baseUrl: '', model: '', dim: DIM });
t = performance.now();
const embedded = await ensureMessageEmbeddings(db, embedder);
report('hash 向量化 + vec0 写入', embedded, performance.now() - t);

// ---------------- 4. 检索 ----------------
async function benchSearch(label: string, query: string, times: number): Promise<void> {
  for (let i = 0; i < 5; i++) await searchMessages(db, embedder, query, { limit: 10 });
  const t0 = performance.now();
  let hits = 0;
  for (let i = 0; i < times; i++) {
    hits += (await searchMessages(db, embedder, query, { limit: 10 })).length;
  }
  report(label, times, performance.now() - t0, `累计命中 ${hits}`);
}

await benchSearch('混合检索（中文关键词）', '向量检索', QUERIES);
await benchSearch('混合检索（英文 token）', 'sqlite-vec', QUERIES);
await benchSearch('混合检索（拼音）', 'fenci', Math.max(20, Math.round(QUERIES / 4)));

// 冷路径（每条查询都不同）：用 ACA_CACHE=0 运行本脚本即可量出真实扫描成本
const varying = Array.from({ length: 40 }, (_, i) => `向量检索 变体${i}`);
{
  const t0 = performance.now();
  let hits = 0;
  for (const q of varying) hits += (await searchMessages(db, embedder, q, { limit: 10 })).length;
  report('混合检索（40 条不同查询）', varying.length, performance.now() - t0, `累计命中 ${hits}`);
}

// ---------------- 5. 记忆查询 ----------------
const insMem = db.prepare('INSERT OR REPLACE INTO memories (id, layer, content, importance, created_at) VALUES (?, ?, ?, ?, ?)');
const insVec = db.prepare('INSERT OR REPLACE INTO memory_vec (memory_id, embedding) VALUES (?, ?)');
const memTexts = Array.from({ length: 200 }, (_, i) => `记忆 ${i}：${textFor(i)}`);
const memVecs = await embedder.embed(memTexts);
db.transaction(() => {
  memTexts.forEach((text, i) => {
    insMem.run(`mem-${i}`, 'episodic', text, 0.5, Date.now());
    insVec.run(`mem-${i}`, JSON.stringify(memVecs[i]));
  });
})();

for (let i = 0; i < 5; i++) await queryMemory(db, embedder, '检索性能', { limit: 8 });
t = performance.now();
let memHits = 0;
for (let i = 0; i < 100; i++) memHits += (await queryMemory(db, embedder, `检索性能 ${i % 5}`, { limit: 8 })).memories.length;
report('记忆查询（向量+事实 LIKE）', 100, performance.now() - t, `累计 ${memHits} 条`);

// ---------------- 6. FTS 单查询 ----------------
{
  const stmt = db.prepare(`SELECT COUNT(*) n FROM messages_fts WHERE messages_fts MATCH ?`);
  for (let i = 0; i < 10; i++) stmt.get('"向量"');
  const t0 = performance.now();
  for (let i = 0; i < 200; i++) stmt.get(`"${ZH[i % ZH.length]}"`);
  report('FTS5 单查询', 200, performance.now() - t0);
}

db.close();
fs.rmSync(tmp, { recursive: true, force: true });

benchTokenize();
const stats = cacheStats();
console.log(`\nN=${N} 条消息 / ${QUERIES} 次查询 / 维度 ${DIM} / 缓存 ${stats.enabled ? '开' : '关'}`);
