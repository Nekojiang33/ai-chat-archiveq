import { Jieba } from '@node-rs/jieba';
import { createRequire } from 'node:module';
import { pinyin } from 'pinyin-pro';

const nodeRequire = createRequire(import.meta.url);
const { dict } = nodeRequire('@node-rs/jieba/dict') as { dict: Uint8Array };

let jieba: Jieba | undefined;

function getJieba(): Jieba {
  if (!jieba) jieba = Jieba.withDict(dict);
  return jieba;
}

const CJK = /[\u4e00-\u9fff]/;
const ALNUM = /[\p{L}\p{N}]/u;
const PY_OPTS = { toneType: 'none', type: 'string', nonZh: 'consecutive' } as const;

// 拼音转换是中文导入里最贵的一步，而词表高度重复（同一批对话反复出现同一批词）。
// 按词缓存可把重复词的转换成本降到一次 Map 查找；超过上限整体清空（无序 LRU 的更简实现）。
const PY_CACHE_MAX = Math.max(1000, Number(process.env.ACA_PINYIN_CACHE || 20000));
const pyCache = new Map<string, string>();

function wordPinyin(word: string): string {
  const hit = pyCache.get(word);
  if (hit !== undefined) return hit;
  const value = pinyin(word, PY_OPTS).replace(/\s+/g, '');
  if (pyCache.size >= PY_CACHE_MAX) pyCache.clear();
  pyCache.set(word, value);
  return value;
}

export interface TokenizedText {
  /** FTS content 列：jieba 分词后的空格串 */
  content: string;
  /** FTS pinyin 列：CJK 词转拼音、拉丁词原样保留（支持 fenci → 分词 的反查） */
  pinyin: string;
}

/**
 * 一次切词同时产出 content 与 pinyin。
 *
 * 优化点（相对逐列调用 tokenize/tokenizePinyin）：
 * - jieba 只切一次（原实现每列各切一次）；
 * - 文本无中文时跳过 pinyin 转换（pinyin-pro 是这块最贵的步骤，实测约占 80%），
 *   拼音列留空即可——拉丁词在 content 列已可检索，拼音路只对中文有意义。
 */
export function tokenizeBoth(text: string): TokenizedText {
  const words = getJieba().cut(text, true);
  const content: string[] = [];
  const py: string[] = [];
  for (const raw of words) {
    const w = raw.trim().toLowerCase();
    if (w.length === 0 || !ALNUM.test(w)) continue;
    content.push(w);
    // 拉丁词元原样进拼音列：这样「fenci 查分词」的反查才成立；
    // 只有 CJK 词需要调 pinyin-pro（也是唯一昂贵的一步）。
    py.push(CJK.test(w) ? wordPinyin(w) : w);
  }
  return { content: content.join(' '), pinyin: py.join(' ') };
}

export function tokenizeArray(text: string): string[] {
  return getJieba()
    .cut(text, true)
    .map((s) => s.trim().toLowerCase())
    .filter((s) => s.length > 0 && ALNUM.test(s));
}

export function tokenize(text: string): string {
  return tokenizeBoth(text).content;
}

export function tokenizePinyin(text: string): string {
  return tokenizeBoth(text).pinyin;
}

export function ftsMatchExpr(query: string): string {
  return tokenizeArray(query)
    .map((t) => `"${t.replace(/"/g, '""')}"`)
    .join(' OR ');
}

export function pinyinMatchExpr(query: string): string {
  return tokenizeBoth(query)
    .pinyin.split(' ')
    .filter(Boolean)
    .map((t) => `"${t.replace(/"/g, '""')}"`)
    .join(' OR ');
}

/** 查询是否含中文（决定是否需要走拼音检索路） */
export function hasCjk(text: string): boolean {
  return CJK.test(text);
}
