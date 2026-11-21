import { LruCache, TtlLruCache } from '../util/lru.js';

/**
 * 检索侧缓存。
 *
 * 依据实测：查询 embedding 在真实 Ollama 下是一次网络往返（10–50ms），
 * 而本地 KNN 约 3ms；重复查询（agent 循环里很常见）缓存收益最大。
 *
 * 注意：**缓存按 Db 实例分区**（WeakMap 分配递增 id 拼进 key），
 * 否则同一进程内打开多个归档库时结果会串库。
 * 写入类操作（导入 / 蒸馏 / 手动记忆）调用 invalidateSearchCaches() 使其失效。
 */
const CACHE_ENABLED = process.env.ACA_CACHE !== '0';

const queryVecCache = new TtlLruCache<string, number[]>(
  Number(process.env.ACA_CACHE_VEC_ENTRIES || 256),
  Number(process.env.ACA_CACHE_VEC_TTL_MS || 10 * 60_000),
  CACHE_ENABLED
);

const resultCache = new TtlLruCache<string, unknown>(
  Number(process.env.ACA_CACHE_RESULT_ENTRIES || 128),
  Number(process.env.ACA_CACHE_RESULT_TTL_MS || 2 * 60_000),
  CACHE_ENABLED
);

const dbIds = new WeakMap<object, number>();
let nextDbId = 1;

/** 给一个 Db 实例分配稳定 id（用于缓存命名空间） */
export function dbKey(db: object): string {
  let id = dbIds.get(db);
  if (id === undefined) {
    id = nextDbId++;
    dbIds.set(db, id);
  }
  return String(id);
}

export function getCachedQueryVector(key: string): number[] | undefined {
  return queryVecCache.get(key);
}

export function setCachedQueryVector(key: string, vec: number[]): void {
  queryVecCache.set(key, vec);
}

export function getCachedResult<T>(key: string): T | undefined {
  return resultCache.get(key) as T | undefined;
}

export function setCachedResult<T>(key: string, value: T): void {
  resultCache.set(key, value);
}

/** 归档内容变化后调用（导入、蒸馏、手动记忆） */
export function invalidateSearchCaches(): void {
  resultCache.clear();
  // 查询向量与内容无关，保留；换模型时由 key（provider|model|dim）自然隔离
}

/** 仅供测试/诊断 */
export function cacheStats(): { queryVectors: number; results: number; enabled: boolean } {
  return { queryVectors: queryVecCache.size, results: resultCache.size, enabled: CACHE_ENABLED };
}

export { LruCache };
