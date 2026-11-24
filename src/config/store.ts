import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

/**
 * 用户可调设置（UI 写入，CLI/MCP 共享读取）。
 *
 * 存储位置：`$ACA_HOME/config.json`，默认 `~/.ai-chat-archive/config.json`。
 * 优先级：环境变量 > 本文件 > 内置默认值（见 config.ts）。
 */

export interface RetrievalWeights {
  /** 关键词（FTS5）权重 */
  fts: number;
  /** 拼音权重 */
  pinyin: number;
  /** 语义向量权重 */
  vec: number;
}

export interface StoredLlm {
  baseUrl?: string;
  model?: string;
  apiKey?: string;
}

export interface StoredEmbed {
  provider?: 'hash' | 'ollama' | 'openai-compatible';
  model?: string;
  dim?: number;
}

export interface StoredSettings {
  weights?: RetrievalWeights;
  llm?: StoredLlm;
  embed?: StoredEmbed;
}

export const DEFAULT_WEIGHTS: RetrievalWeights = { fts: 1, pinyin: 1, vec: 1 };

const MAX_WEIGHT = 5;

export function settingsDir(): string {
  return process.env.ACA_HOME || path.join(os.homedir(), '.ai-chat-archive');
}

export function settingsPath(): string {
  return path.join(settingsDir(), 'config.json');
}

function clampWeight(value: unknown, fallback: number): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(MAX_WEIGHT, Math.max(0, Math.round(n * 100) / 100));
}

function normalizeWeights(input?: Partial<RetrievalWeights>): RetrievalWeights | undefined {
  if (!input) return undefined;
  return {
    fts: clampWeight(input.fts, DEFAULT_WEIGHTS.fts),
    pinyin: clampWeight(input.pinyin, DEFAULT_WEIGHTS.pinyin),
    vec: clampWeight(input.vec, DEFAULT_WEIGHTS.vec),
  };
}

export function loadSettings(): StoredSettings {
  try {
    const raw = fs.readFileSync(settingsPath(), 'utf8');
    const parsed = JSON.parse(raw) as StoredSettings;
    if (!parsed || typeof parsed !== 'object') return {};
    return {
      weights: normalizeWeights(parsed.weights),
      llm: parsed.llm && typeof parsed.llm === 'object' ? parsed.llm : undefined,
      embed: parsed.embed && typeof parsed.embed === 'object' ? parsed.embed : undefined,
    };
  } catch {
    return {};
  }
}

/** 合并写入（先写临时文件再 rename，避免半截文件）；返回写入后的完整设置 */
export function saveSettings(patch: StoredSettings): StoredSettings {
  const current = loadSettings();
  const merged: StoredSettings = {};
  const weights = normalizeWeights({ ...current.weights, ...patch.weights });
  if (weights) merged.weights = weights;
  const llm = { ...current.llm, ...patch.llm };
  if (Object.keys(llm).length > 0) merged.llm = llm;
  const embed = { ...current.embed, ...patch.embed };
  if (Object.keys(embed).length > 0) merged.embed = embed;

  const target = settingsPath();
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const tmp = `${target}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(merged, null, 2)}\n`, 'utf8');
  fs.renameSync(tmp, target);
  return merged;
}

/** 生效权重：显式入参 > 已存设置 > 默认 1:1:1 */
export function resolveWeights(explicit?: Partial<RetrievalWeights>): RetrievalWeights {
  const base = normalizeWeights(loadSettings().weights) ?? { ...DEFAULT_WEIGHTS };
  if (!explicit) return base;
  return {
    fts: clampWeight(explicit.fts, base.fts),
    pinyin: clampWeight(explicit.pinyin, base.pinyin),
    vec: clampWeight(explicit.vec, base.vec),
  };
}
