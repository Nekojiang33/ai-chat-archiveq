import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { openDb } from '../src/db/connection.js';
import { migrate } from '../src/db/schema.js';
import { importPaths } from '../src/importers/index.js';
import { createMcpServer } from '../src/mcp/server.js';
import { loadConfig } from '../src/config.js';

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

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aca-mcp-'));
const dbPath = path.join(tmp, 'archive.db');

const claudeData = [
  {
    uuid: 'conv-claude-1',
    name: 'TypeScript 泛型讨论',
    created_at: '2026-10-01T08:00:00.000Z',
    chat_messages: [
      { sender: 'human', created_at: '2026-10-01T08:00:00.000Z', text: 'TypeScript 的条件类型怎么用？' },
      { sender: 'assistant', created_at: '2026-10-01T08:01:00.000Z', text: '条件类型形如 T extends U ? X : Y，配合 infer 可以抽取类型。' },
    ],
  },
];
const jsonPath = path.join(tmp, 'claude-export.json');
fs.writeFileSync(jsonPath, JSON.stringify(claudeData));

const db = openDb(dbPath, 'mcp-pass');
migrate(db, 1024);
importPaths(db, [jsonPath]);
// 预置一个实体 + 事实，供 entity 上下文用例使用（正常由蒸馏产生）
const now = Date.now();
db.prepare(`INSERT OR IGNORE INTO entities (id, name, type, mention_count, created_at, updated_at) VALUES (?, ?, ?, 1, ?, ?)`).run(
  'e-typescript',
  'TypeScript',
  'tool',
  now,
  now
);
db.prepare(`INSERT OR IGNORE INTO facts (id, entity_id, content, valid_from, confidence, created_at) VALUES (?, ?, ?, ?, ?, ?)`).run(
  'f-typescript',
  'e-typescript',
  '用户使用 TypeScript 开发',
  now,
  0.9,
  now
);
db.close();

process.env.ACA_DB = dbPath;
process.env.ACA_PASSWORD = 'mcp-pass';
// 隔离外部环境：本用例断言「未配置 LLM」时的提示，不能被 shell 里的 ACA_* 影响
for (const k of ['ACA_LLM_MODEL', 'ACA_LLM_BASE_URL', 'ACA_EMBED_PROVIDER', 'ACA_EMBED_MODEL', 'ACA_EMBED_DIM', 'ACA_EMBED_BASE_URL']) {
  delete process.env[k];
}
const cfg = loadConfig();
const { server, db: srvDb } = createMcpServer(cfg);

const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
await server.connect(serverTransport);
const client = new Client({ name: 'test-client', version: '0.0.1' });
await client.connect(clientTransport);

type Res = { content: { type: string; text: string }[] };
const call = async (name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> =>
  JSON.parse(((await client.callTool({ name, arguments: args })) as Res).content[0].text) as Record<string, unknown>;

const tools = await client.listTools();
check('MCP: 收敛为 4 个工具', tools.tools.length === 4, tools.tools.map((t) => t.name).join(', '));
check('MCP: 工具名符合 recall/entity/remember/maintain', ['recall', 'entity', 'remember', 'maintain'].every((n) => tools.tools.some((t) => t.name === n)));

const recall = await call('recall', { query: '条件类型' });
const messages = recall.messages as { content: string }[];
check('recall: 命中对话原文', messages.length > 0 && messages.some((m) => m.content.includes('条件类型')));

const recallPy = await call('recall', { query: 'leixing' });
check('recall: 拼音检索命中', ((recallPy.messages as unknown[]) || []).length > 0, JSON.stringify(recallPy).slice(0, 120));

const remember = await call('remember', { content: '用户主要使用 TypeScript 开发', layer: 'semantic', importance: 0.9 });
check('remember: 写入成功', remember.ok === true);

const recallMem = await call('recall', { query: 'TypeScript 开发偏好' });
const memories = recallMem.memories as { content: string }[];
check('recall: 命中记忆', memories.some((m) => m.content.includes('TypeScript')));

const recallNoMem = await call('recall', { query: '条件类型', includeMemory: false });
check('recall: includeMemory=false 时不返回记忆', (recallNoMem.memories as unknown[]).length === 0);

const list = await call('entity', { limit: 5 });
check('entity: 省略 name 返回实体列表', Array.isArray(list.entities));

const ctx = await call('entity', { name: 'TypeScript' });
check('entity: 指定名称返回上下文', (ctx.entity as { name: string }).name === 'TypeScript', JSON.stringify(ctx).slice(0, 120));

const status = await call('maintain', { action: 'status' });
check(
  'maintain: status 统计正确',
  status.conversations === 1 && status.messages === 2 && status.memories === 1,
  JSON.stringify(status)
);

const distill = await call('maintain', { action: 'distill', limit: 1 });
check('maintain: distill 未配置 LLM 时返回提示', ((distill.errors as string[]) ?? []).length === 1 && (distill.errors as string[])[0].includes('ACA_LLM_MODEL'));

srvDb.close();
await client.close();
await server.close();
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
