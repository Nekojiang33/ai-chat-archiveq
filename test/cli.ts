import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import AdmZip from 'adm-zip';

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

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aca-cli-'));
const dbA = path.join(tmp, 'a.db');
const dbB = path.join(tmp, 'b.db');
const CLI = path.resolve('dist/cli.js');

// 子进程环境隔离：剥离 shell 里的 ACA_*，否则「未配置 LLM」类断言会被外部变量干扰
const cleanEnv = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('ACA_')));

const run = (args: string[]): { code: number | null; out: string } => {
  const r = spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', env: cleanEnv });
  return { code: r.status, out: (r.stdout || '') + (r.stderr || '') };
};

const chatgptData = [
  {
    id: 'conv-1',
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
          content: { content_type: 'text', parts: ['我在用 SQLite 做向量检索，中文分词怎么处理？'] },
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
          content: { content_type: 'text', parts: ['可以用 jieba 分词后写入，查询时同样切词。'] },
        },
      },
    },
  },
];
const zip = new AdmZip();
zip.addFile('conversations.json', Buffer.from(JSON.stringify(chatgptData), 'utf8'));
const zipPath = path.join(tmp, 'export.zip');
zip.writeZip(zipPath);

const args = (extra: string[]): string[] => [...extra, '--db', dbA, '--password', 'p123'];

const r1 = run(['init', ...args([])]);
check('CLI: init', r1.code === 0 && r1.out.includes('已初始化'), r1.out);

const r2 = run(['import', ...args([zipPath])]);
check('CLI: import', r2.code === 0 && r2.out.includes('1 个会话') && r2.out.includes('2 条消息'), r2.out);

const r3 = run(['search', ...args(['向量检索'])]);
check('CLI: search 中文', r3.code === 0 && r3.out.includes('向量检索'), r3.out);

const r4 = run(['search', ...args(['fenci'])]);
check('CLI: search 拼音', r4.code === 0 && r4.out.includes('分词'), r4.out);

const r5 = run(['status', ...args([])]);
check('CLI: status', r5.code === 0 && r5.out.includes('会话 1') && r5.out.includes('消息 2'), r5.out);

const r6 = run(['distill', ...args([])]);
check('CLI: distill 无 LLM 时给出配置提示', r6.code === 0 && r6.out.includes('ACA_LLM_MODEL'), r6.out);

const blobPath = path.join(tmp, 'sync.blob');
const r7 = run(['sync', 'pack', ...args([blobPath])]);
check('CLI: sync pack', r7.code === 0 && r7.out.includes('AES-256-GCM'), r7.out);

const r8 = run(['sync', 'unpack', blobPath, '--db', dbB, '--password', 'p123']);
check('CLI: sync unpack 到新库', r8.code === 0 && r8.out.includes('新增 2 条消息'), r8.out);

const r9 = run(['sync', 'unpack', blobPath, '--db', path.join(tmp, 'c.db'), '--password', 'wrong']);
check('CLI: 错误密码被拒绝', r9.code !== 0 && r9.out.includes('解密失败'), r9.out);

const r10 = spawnSync(process.execPath, [CLI, 'mcp', '--db', dbA, '--password', 'p123'], {
  env: cleanEnv,
  input:
    JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 't', version: '0' } },
    }) + '\n',
  encoding: 'utf8',
});
check('CLI: mcp stdio initialize 握手', (r10.stdout || '').includes('ai-chat-archive'), (r10.stdout || '') + (r10.stderr || ''));

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
