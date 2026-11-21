import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import AdmZip from 'adm-zip';
import { openDb } from '../src/db/connection.js';
import { migrate } from '../src/db/schema.js';
import { importPaths } from '../src/importers/index.js';
import { createEmbedder } from '../src/search/embed.js';
import { searchMessages, queryMemory, getEntityContext } from '../src/search/hybrid.js';
import { runDistill } from '../src/memory/pipeline.js';
import { packArchive, unpackInto } from '../src/sync/blob.js';

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

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aca-e2e-'));
const dbPath = path.join(tmp, 'archive.db');
const PASSWORD = 'e2e-pass-测试';

const chatgptData = [
  {
    id: 'conv-chatgpt-1',
    title: '数据库设计讨论',
    create_time: 1730000000,
    update_time: 1730001000,
    mapping: {
      root: { id: 'root', parent: null, children: ['n1'] },
      n1: {
        id: 'n1',
        parent: 'root',
        children: ['n2'],
        message: {
          id: 'm1',
          author: { role: 'user' },
          create_time: 1730000000,
          content: { content_type: 'text', parts: ['我在用 SQLite 做向量检索，FTS5 中文分词怎么处理？'] },
        },
      },
      n2: {
        id: 'n2',
        parent: 'n1',
        children: [],
        message: {
          id: 'm2',
          author: { role: 'assistant' },
          create_time: 1730000050,
          model: 'gpt-4o',
          content: { content_type: 'text', parts: ['可以用 jieba 分词后写入 FTS5，查询时同样切词。sqlite-vec 提供向量检索。'] },
        },
      },
    },
  },
  {
    id: 'conv-chatgpt-2',
    title: '旅行计划',
    create_time: 1730100000,
    update_time: 1730100500,
    mapping: {
      root: { id: 'root', parent: null, children: ['n1'] },
      n1: {
        id: 'n1',
        parent: 'root',
        children: ['n2'],
        message: {
          id: 'm1',
          author: { role: 'user' },
          create_time: 1730100000,
          content: { content_type: 'text', parts: ['帮我规划十一假期的杭州行程'] },
        },
      },
      n2: {
        id: 'n2',
        parent: 'n1',
        children: [],
        message: {
          id: 'm2',
          author: { role: 'assistant' },
          create_time: 1730100100,
          model: 'gpt-4o',
          content: { content_type: 'text', parts: ['第一天西湖，第二天灵隐寺与龙井村，第三天千岛湖。'] },
        },
      },
    },
  },
];
const zip = new AdmZip();
zip.addFile('conversations.json', Buffer.from(JSON.stringify(chatgptData), 'utf8'));
const zipPath = path.join(tmp, 'chatgpt-export.zip');
zip.writeZip(zipPath);

const claudeCodeLines = [
  JSON.stringify({
    type: 'user',
    sessionId: 'sess-cc-1',
    uuid: 'u1',
    timestamp: '2026-11-01T10:00:00.000Z',
    message: { role: 'user', content: '帮我把项目从 npm 迁移到 pnpm' },
  }),
  JSON.stringify({
    type: 'assistant',
    sessionId: 'sess-cc-1',
    uuid: 'a1',
    timestamp: '2026-11-01T10:00:30.000Z',
    message: {
      role: 'assistant',
      model: 'claude-sonnet-4',
      content: [{ type: 'text', text: '先删 node_modules 和 package-lock.json，然后 corepack enable && pnpm import && pnpm install。' }],
    },
  }),
  JSON.stringify({ type: 'summary', sessionId: 'sess-cc-1', summary: 'npm 迁移 pnpm' }),
  JSON.stringify({ type: 'user', isSidechain: true, sessionId: 'sess-cc-1', message: { role: 'user', content: 'sidechain 应被忽略' } }),
];
const jsonlPath = path.join(tmp, 'sess-cc-1.jsonl');
fs.writeFileSync(jsonlPath, claudeCodeLines.join('\n'));

const db = openDb(dbPath, PASSWORD);
migrate(db, 1024);

const r1 = importPaths(db, [zipPath, jsonlPath]);
check('导入: 3 个会话', r1.conversations === 3, JSON.stringify(r1));
check('导入: 6 条消息', r1.newMessages === 6, `got ${r1.newMessages}`);

const r2 = importPaths(db, [zipPath, jsonlPath]);
check('幂等: 重复导入 0 新消息', r2.newMessages === 0 && r2.conversations === 3);

const head = fs.readFileSync(dbPath).subarray(0, 16).toString('utf8');
check('加密: 数据库文件非明文 SQLite', !head.startsWith('SQLite format 3'), head.slice(0, 12));

const embedder = createEmbedder({ provider: 'hash', baseUrl: '', model: '', dim: 1024 });

const hitsZh = await searchMessages(db, embedder, '向量检索');
check('检索: 中文关键词命中', hitsZh.length > 0, JSON.stringify(hitsZh.map((h) => h.content.slice(0, 20))));
const hitsPy = await searchMessages(db, embedder, 'fenci');
check('检索: 连写拼音命中', hitsPy.length > 0 && hitsPy.some((h) => h.content.includes('分词')), 'pinyin path');
const hitsExact = await searchMessages(db, embedder, 'sqlite-vec');
check('检索: 精确英文 token 命中', hitsExact.length > 0 && hitsExact.some((h) => h.content.includes('sqlite-vec')));
const hitsFiltered = await searchMessages(db, embedder, '假期', { source: 'chatgpt' });
check('检索: 来源过滤', hitsFiltered.length > 0 && hitsFiltered.every((h) => h.source === 'chatgpt'));
const hitsNone = await searchMessages(db, embedder, '量子纠缠超导');
check('检索: 无关词不误命中', hitsNone.length === 0);

const llmServer = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    res.setHeader('content-type', 'application/json');
    if (req.url?.endsWith('/chat/completions')) {
      res.end(
        JSON.stringify({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  facts: [
                    { entity: 'SQLite', entity_type: 'tool', content: '用户在项目中使用 SQLite 做向量检索与全文检索', confidence: 0.95 },
                    { entity: 'pnpm', entity_type: 'tool', content: '用户于 2026-11 将项目包管理器从 npm 迁移到 pnpm', confidence: 0.9 },
                    // 路径型实体名属于噪声：应被 pipeline 过滤（否则下面的 facts 断言会变成 3）
                    { entity: 'C:\\Users\\demo\\ollama.exe', entity_type: 'tool', content: '路径型实体不应入库', confidence: 0.9 },
                  ],
                  summary: '讨论了 SQLite 向量检索方案与包管理器迁移。',
                }),
              },
            },
          ],
        })
      );
    } else {
      res.statusCode = 404;
      res.end('{}');
    }
  });
});
await new Promise<void>((r) => llmServer.listen(0, '127.0.0.1', r));
const port = (llmServer.address() as { port: number }).port;

const dr = await runDistill(db, embedder, { baseUrl: `http://127.0.0.1:${port}/v1`, model: 'mock-model' }, { limit: 10 });
check('蒸馏: 3 会话处理', dr.conversations === 3, JSON.stringify(dr));
check('蒸馏: 事实入库（幂等去重）', dr.facts === 2, `facts=${dr.facts}`);
check(
  '蒸馏: 路径型实体被过滤',
  (db.prepare(`SELECT COUNT(*) n FROM entities WHERE name LIKE '%\\%'`).get() as { n: number }).n === 0
);
check('蒸馏: 情景记忆入库', dr.memories === 3, `memories=${dr.memories}`);
check('蒸馏: 消息向量化', dr.embeddedMessages >= 6);
check('蒸馏: 无错误', dr.errors.length === 0, dr.errors.join('; '));
llmServer.close();

const memFacts = await queryMemory(db, embedder, '包管理器偏好');
check('记忆: 事实查询命中', memFacts.facts.length > 0, JSON.stringify(memFacts.facts));
const memVec = await queryMemory(db, embedder, 'SQLite 方案');
check('记忆: 向量查询命中', memVec.memories.length > 0, `memories=${memVec.memories.length}`);

const ctx = getEntityContext(db, 'SQLite');
check('上下文: 实体事实与对话', !!ctx && ctx.facts.length > 0 && ctx.conversations.length > 0, JSON.stringify(ctx));

const blobPath = path.join(tmp, 'sync.blob');
const pk = packArchive(db, blobPath, PASSWORD);
check('同步: 打包 3 会话 6 消息', pk.conversations === 3 && pk.messages === 6, JSON.stringify(pk));
const blobRaw = fs.readFileSync(blobPath);
check('同步: blob 带魔数且非明文', blobRaw.subarray(0, 4).toString() === 'ACAB' && !blobRaw.includes('SQLite format'));

const db2Path = path.join(tmp, 'archive2.db');
const db2 = openDb(db2Path, PASSWORD);
migrate(db2, 1024);
const up = unpackInto(db2, blobPath, PASSWORD);
check('同步: 解包合并', up.conversations === 3 && up.newMessages === 6, JSON.stringify(up));
const up2 = unpackInto(db2, blobPath, PASSWORD);
check('同步: 幂等解包 0 新增', up2.newMessages === 0);

let wrongPass = false;
try {
  const dbx = openDb(path.join(tmp, 'x.db'), 'wrong');
  unpackInto(dbx, blobPath, 'wrong-password');
} catch {
  wrongPass = true;
}
check('同步: 错误密码被拒绝', wrongPass);

const hits2 = await searchMessages(db2, embedder, '向量检索');
check('同步: 目标库可检索', hits2.length > 0);

db.close();
db2.close();
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
