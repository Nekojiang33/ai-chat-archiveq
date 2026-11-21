import Database from 'better-sqlite3-multiple-ciphers';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const file = path.join(os.tmpdir(), `aca-check-${Date.now()}.db`);
{
  const db = new Database(file);
  db.pragma("key='testpass'");
  const ver = db.prepare('select sqlite_version() as v').get().v;
  db.exec('CREATE VIRTUAL TABLE t USING fts5(c)');
  db.exec("INSERT INTO t VALUES('hello world 数据库')");
  const hit = db.prepare('select * from t where t match ?').get('hello');
  console.log('sqlite:', ver, '| fts5 match:', hit ? 'OK' : 'FAIL');
  db.close();
}
{
  const raw = fs.readFileSync(file);
  console.log('encrypted file is not plaintext sqlite header:', raw.subarray(0, 16).toString('hex') !== '53514c69746520666f726d61742033');
  const db = new Database(file);
  let wrongPass = false;
  try { db.prepare('select 1').get(); } catch { wrongPass = true; }
  console.log('wrong password rejected:', wrongPass);
  db.pragma("key='testpass'");
  console.log('reopen with correct key:', db.prepare('select count(*) n from t').get().n === 1 ? 'OK' : 'FAIL');
  db.close();
}
fs.unlinkSync(file);
