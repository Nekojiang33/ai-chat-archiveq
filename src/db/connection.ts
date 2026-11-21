import Database from 'better-sqlite3-multiple-ciphers';
import * as sqliteVec from 'sqlite-vec';
import fs from 'node:fs';
import path from 'node:path';

export type Db = Database.Database;

/**
 * 打开（必要时创建）加密归档库。
 *
 * 注意：SQLCipher 的 `key` pragma 不会立即校验密码，密码错误要到第一次读取才会暴露，
 * 这里主动读一次 sqlite_master，把「密码错/文件损坏」变成清晰的中文错误。
 */
export function openDb(dbPath: string, password?: string): Db {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  let db: Database.Database;
  try {
    db = new Database(dbPath);
    if (password) db.pragma(`key='${password.replace(/'/g, "''")}'`);
    db.prepare('SELECT COUNT(*) FROM sqlite_master').get();
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (/not a database|file is encrypted|decrypt|malformed/i.test(msg)) {
      throw new Error(`打开数据库失败：密码错误，或该文件不是本工具创建的加密库（${dbPath}）`);
    }
    throw e;
  }
  db.pragma('busy_timeout = 5000');
  db.pragma('journal_mode = WAL');
  // WAL 下 synchronous=NORMAL 依然满足崩溃一致性，批量导入写入明显更快
  db.pragma('synchronous = NORMAL');
  db.pragma('temp_store = MEMORY');
  db.pragma('cache_size = -32000'); // ≈32MB 页缓存
  db.pragma('mmap_size = 268435456'); // 256MB 内存映射，减少读系统调用
  db.pragma('foreign_keys = ON');
  try {
    sqliteVec.load(db);
  } catch (e) {
    throw new Error(`sqlite-vec 扩展加载失败（向量检索不可用）：${e instanceof Error ? e.message : String(e)}`);
  }
  return db;
}
