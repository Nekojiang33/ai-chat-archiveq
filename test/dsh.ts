import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { openDb } from '../src/db/connection.js';
import { migrate } from '../src/db/schema.js';
import { importPaths } from '../src/importers/index.js';
import { isDshSession, parseDshSession } from '../src/importers/dsh.js';

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

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aca-dsh-'));

// 构造一个 DSH 会话日志：真人输入 + 注入消息 + 带工具调用/推理的助手消息
const lines = [
  { type: 'session', version: 4, id: 'session-test-0001', createdAt: 1795000000000, cwd: 'C:\\demo' },
  { type: 'developer/message', seq: 1, time: 1795000000100, data: { message: { role: 'developer', content: [] } } },
  { type: 'session/title', seq: 2, time: 1795000000200, data: { title: '@path 初步标题', source: { kind: 'fallback' } } },
  {
    type: 'session/title',
    seq: 3,
    time: 1795000000300,
    data: { title: '归档器对接 DSH 会话', source: { kind: 'provider' } },
  },
  {
    type: 'user/message',
    seq: 4,
    time: 1795000001000,
    data: { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: '把 DeepSeek Harness 的会话日志也归档进知识库。' }] },
  },
  {
    type: 'user/message',
    seq: 5,
    time: 1795000001100,
    data: {
      role: 'user',
      source: { kind: 'runtime-context' },
      content: [{ type: 'text', text: 'Current runtime context. 这段注入内容不应入库。' }],
    },
  },
  {
    type: 'user/message',
    seq: 6,
    time: 1795000001200,
    data: { role: 'user', source: { kind: 'time-context' }, content: [{ type: 'text', text: 'Time sampled while preparing turn 1' }] },
  },
  {
    type: 'assistant/message',
    seq: 7,
    time: 1795000002000,
    data: {
      turn: 1,
      step: 1,
      message: {
        role: 'assistant',
        content: [
          { type: 'reasoning', text: '内部推理不应入库' },
          { type: 'text', text: '可以：解析 session.v4.jsonl.zstd，只保留真人输入与助手文本。' },
          { type: 'tool-call', id: 'call_1', name: 'ops_bash', arguments: '{"command":"ls"}' },
        ],
      },
    },
  },
  {
    type: 'assistant/message',
    seq: 8,
    time: 1795000002500,
    data: { turn: 1, step: 2, message: { role: 'assistant', content: [{ type: 'tool-call', id: 'call_2', name: 'ops_bash', arguments: '{}' }] } },
  },
  {
    type: 'user/message',
    seq: 9,
    time: 1795000003000,
    data: { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: '顺便用 zstd 多帧压缩验证一下。' }] },
  },
  {
    type: 'assistant/message',
    seq: 10,
    time: 1795000004000,
    data: {
      turn: 2,
      step: 1,
      message: { role: 'assistant', content: [{ type: 'text', text: '已支持多帧 zstd：逐帧解压后拼接 JSONL。' }] },
    },
  },
];
const jsonl = lines.map((l) => JSON.stringify(l)).join('\n') + '\n';
const jsonlPath = path.join(tmp, 'session.v4.jsonl');
fs.writeFileSync(jsonlPath, jsonl, 'utf8');

// 多帧 zstd：两个独立帧拼接（模拟 DSH 逐批落盘）
const zstd = (zlib as unknown as { zstdCompressSync?: (b: Buffer) => Buffer }).zstdCompressSync;
const zstdPath = path.join(tmp, 'session.v4.jsonl.zstd');
if (typeof zstd === 'function') {
  const half = Math.floor(jsonl.length / 2);
  const cut = jsonl.lastIndexOf('\n', half) + 1;
  const f1 = zstd(Buffer.from(jsonl.slice(0, cut), 'utf8'));
  const f2 = zstd(Buffer.from(jsonl.slice(cut), 'utf8'));
  fs.writeFileSync(zstdPath, Buffer.concat([f1, f2]));
}

// --- 纯解析（不落库）---
check('识别为 DSH 会话', isDshSession(jsonl));
check('非 DSH 内容不误判', !isDshSession(JSON.stringify({ type: 'user', sessionId: 'x' }) + '\n'));
const parsed = parseDshSession(jsonl, 'fallback');
check('解析出 1 个会话', parsed.length === 1, String(parsed.length));
const conv = parsed[0];
check('source 为 dsh', conv.source === 'dsh', conv.source);
check('externalId 取会话 id', conv.externalId === 'session-test-0001', conv.externalId);
check('标题取最后一个 title 事件', conv.title === '归档器对接 DSH 会话', String(conv.title));
check(
  '只保留真人输入与助手文本（4 条）',
  conv.messages.length === 4,
  JSON.stringify(conv.messages.map((m) => m.role + ':' + m.content.slice(0, 12)))
);
check('注入消息未入库', !conv.messages.some((m) => m.content.includes('runtime context') || m.content.includes('Time sampled')));
check('推理与纯工具消息未入库', !conv.messages.some((m) => m.content.includes('内部推理')));
check('角色交替正确', conv.messages.map((m) => m.role).join(',') === 'user,assistant,user,assistant');

// --- 落库导入 ---
const dbPath = path.join(tmp, 'archive.db');
const db = openDb(dbPath, 'dsh-test-pass');
migrate(db, 512);

const r1 = importPaths(db, [jsonlPath]);
check('导入 JSONL：1 会话 4 消息', r1.conversations === 1 && r1.newMessages === 4, JSON.stringify(r1));

const r2 = importPaths(db, [jsonlPath]);
check('幂等：重复导入 0 新增', r2.newMessages === 0 && r2.conversations === 1, JSON.stringify(r2));

if (typeof zstd === 'function') {
  const r3 = importPaths(db, [zstdPath]);
  check('导入多帧 zstd：同一会话 0 新增', r3.conversations === 1 && r3.newMessages === 0, JSON.stringify(r3));
} else {
  console.log('[SKIP] 当前 Node 无 zstdCompressSync，跳过多帧压缩用例');
}

const stored = db.prepare(`SELECT title, message_count FROM conversations WHERE source = 'dsh'`).get() as
  | { title: string; message_count: number }
  | undefined;
check('库中记录 DSH 会话与标题', stored?.title === '归档器对接 DSH 会话' && stored?.message_count === 4, JSON.stringify(stored));

const hit = db
  .prepare(`SELECT m.content FROM messages_fts f JOIN messages m ON m.id = f.message_id WHERE f.content MATCH ? LIMIT 1`)
  .get('"zstd"') as { content: string } | undefined;
check('FTS 可检索到归档内容', !!hit && /zstd/i.test(hit.content), hit?.content.slice(0, 40));

db.close();
fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
