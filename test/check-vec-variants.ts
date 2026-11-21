import Database from 'better-sqlite3-multiple-ciphers';
import * as sqliteVec from 'sqlite-vec';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const file = path.join(os.tmpdir(), `aca-vec2-${Date.now()}.db`);
const db = new Database(file);
db.pragma("key='testpass'");
sqliteVec.load(db);

function tryCase(name: string, fn: () => void) {
  try { fn(); console.log(`[PASS] ${name}`); }
  catch (e: any) { console.log(`[FAIL] ${name} -> ${e.message}`); }
}

// 变体1: 显式整数 id
tryCase('int pk: INSERT INTO v(id, e)', () => {
  db.exec('CREATE VIRTUAL TABLE v1 USING vec0(id INTEGER PRIMARY KEY, e float[4])');
  db.prepare('INSERT INTO v1(id, e) VALUES (?, ?)').run(1, JSON.stringify([0.1, 0.2, 0.3, 0.4]));
});

// 变体2: rowid 语法
tryCase('int pk: INSERT INTO v(rowid, e)', () => {
  db.exec('CREATE VIRTUAL TABLE v2 USING vec0(id INTEGER PRIMARY KEY, e float[4])');
  db.prepare('INSERT INTO v2(rowid, e) VALUES (?, ?)').run(1, JSON.stringify([0.1, 0.2, 0.3, 0.4]));
});

// 变体3: 不给 id，自动生成
tryCase('auto id: INSERT INTO v(e)', () => {
  db.exec('CREATE VIRTUAL TABLE v3 USING vec0(e float[4])');
  db.prepare('INSERT INTO v3(e) VALUES (?)').run(JSON.stringify([0.1, 0.2, 0.3, 0.4]));
  console.log('  generated ids:', db.prepare('SELECT rowid FROM v3 LIMIT 3').all().map((r: any) => r.rowid));
});

// 变体4: TEXT 主键
tryCase('text pk: INSERT INTO v(id, e)', () => {
  db.exec('CREATE VIRTUAL TABLE v4 USING vec0(id TEXT PRIMARY KEY, e float[4])');
  db.prepare('INSERT INTO v4(id, e) VALUES (?, ?)').run('msg-1', JSON.stringify([0.1, 0.2, 0.3, 0.4]));
});

// 变体5: KNN 查询验证（用变体4的表）
tryCase('knn search on text pk table', () => {
  db.prepare('INSERT INTO v4(id, e) VALUES (?, ?)').run('msg-2', JSON.stringify([0.9, 0.8, 0.7, 0.6]));
  const rows = db.prepare('SELECT id, distance FROM v4 WHERE e MATCH ? ORDER BY distance LIMIT 1').all(JSON.stringify([0.1, 0.2, 0.3, 0.35]));
  console.log('  nearest:', JSON.stringify(rows));
});

db.close();
fs.unlinkSync(file);
