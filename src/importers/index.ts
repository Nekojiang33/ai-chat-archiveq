import fs from 'node:fs';
import path from 'node:path';
import AdmZip from 'adm-zip';
import type { Db } from '../db/connection.js';
import { upsertConversation } from './core.js';
import { parseChatGptConversations } from './chatgpt.js';
import { parseClaudeConversations } from './claude.js';
import { parseClaudeCodeJsonl, collectClaudeCodeFiles } from './claude-code.js';
import { isDshSession, parseDshSession } from './dsh.js';
import { decompressZstd } from '../util/zstd.js';
import type { ParsedConversation } from './types.js';

export interface ImportResult {
  files: number;
  conversations: number;
  newMessages: number;
}

/** zstd 压缩扩展名（DSH 会话日志为多帧 zstd） */
const ZSTD_EXTS = new Set(['.zstd', '.zst']);

function looksLikeChatGpt(data: unknown[]): boolean {
  return data.length > 0 && typeof data[0] === 'object' && data[0] !== null && 'mapping' in (data[0] as object);
}

function parseJsonArray(content: string): ParsedConversation[] {
  const data = JSON.parse(content);
  if (!Array.isArray(data)) throw new Error('JSON 顶层应为会话数组');
  if (looksLikeChatGpt(data)) return parseChatGptConversations(data);
  return parseClaudeConversations(data);
}

/** JSONL 类输入：Claude Code 或 DSH 会话；.zstd 先解压（DSH 会话日志为多帧拼接） */
function parseJsonlFile(filePath: string): ParsedConversation[] {
  const ext = path.extname(filePath).toLowerCase();
  const raw = ZSTD_EXTS.has(ext) ? decompressZstd(fs.readFileSync(filePath)) : fs.readFileSync(filePath);
  const content = raw.toString('utf8');
  const name = path.basename(filePath, ext);
  if (isDshSession(content)) return parseDshSession(content, name);
  return parseClaudeCodeJsonl(content, name);
}

function importOneFile(db: Db, filePath: string, result: ImportResult): void {
  const ext = path.extname(filePath).toLowerCase();
  let convs: ParsedConversation[] = [];
  if (ext === '.zip') {
    const zip = new AdmZip(fs.readFileSync(filePath));
    const entry = zip.getEntries().find((e) => !e.isDirectory && e.entryName.endsWith('conversations.json'));
    if (!entry) throw new Error(`${filePath}: ZIP 中未找到 conversations.json`);
    convs = parseJsonArray(entry.getData().toString('utf8'));
  } else if (ext === '.jsonl' || ZSTD_EXTS.has(ext)) {
    convs = parseJsonlFile(filePath);
  } else if (ext === '.json') {
    convs = parseJsonArray(fs.readFileSync(filePath, 'utf8'));
  } else {
    throw new Error(`${filePath}: 不支持的文件类型 ${ext}（支持 .zip / .json / .jsonl / .jsonl.zstd / .zstd）`);
  }
  result.files++;
  for (const conv of convs) {
    const r = upsertConversation(db, conv);
    result.conversations++;
    result.newMessages += r.insertedMessages;
  }
}

export function importPaths(db: Db, inputs: string[]): ImportResult {
  const result: ImportResult = { files: 0, conversations: 0, newMessages: 0 };
  for (const input of inputs) {
    const stat = fs.statSync(input);
    if (stat.isDirectory()) {
      // 递归收集 .jsonl / .jsonl.zstd / .zstd（Claude Code 与会话日志的目录结构都适用）
      for (const f of collectClaudeCodeFiles(input)) importOneFile(db, f, result);
      const jsons = fs
        .readdirSync(input, { withFileTypes: true })
        .filter((e) => e.isFile() && e.name.endsWith('.json'))
        .map((e) => path.join(input, e.name));
      for (const f of jsons) importOneFile(db, f, result);
    } else {
      importOneFile(db, input, result);
    }
  }
  return result;
}
