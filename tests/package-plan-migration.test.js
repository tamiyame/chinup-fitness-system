// 套裝方案價目表：既有資料庫升級（新表 package_plans、customer_packages 補 from_plan）。
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';

const dbPath = join(tmpdir(), `package-plan-mig-${process.pid}.db`);
const freshPath = join(tmpdir(), `package-plan-fresh-${process.pid}.db`);
for (const p of [dbPath, freshPath]) for (const s of ['', '-wal', '-shm']) rmSync(p + s, { force: true });

function expect(label, fn) { try { fn(); console.log(`  ✓ ${label}`); } catch (e) { console.log(`  ✗ ${label}`); console.error(e); process.exitCode = 1; } }
console.log('[package-plan-migration test] start');

// 改動前的 customer_packages（有 source、沒有 from_plan）＋一筆舊資料；沒有 package_plans 表
const old = new DatabaseSync(dbPath, { enableForeignKeyConstraints: false });
old.exec(`
CREATE TABLE customer_packages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  member_id INTEGER NOT NULL REFERENCES users(id),
  session_type TEXT NOT NULL CHECK (session_type IN ('1on1','1on2')),
  total_sessions INTEGER NOT NULL CHECK (total_sessions > 0),
  remaining_sessions INTEGER NOT NULL CHECK (remaining_sessions >= 0),
  amount INTEGER,
  expires_at TEXT,
  note TEXT,
  discount_code TEXT,
  source TEXT NOT NULL DEFAULT 'staff' CHECK (source IN ('staff', 'online')),
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  archived_at TEXT
);
`);
old.prepare("INSERT INTO customer_packages (member_id, session_type, total_sessions, remaining_sessions, amount, note) VALUES (1, '1on1', 10, 7, 14000, '舊方案')").run();
old.close();

process.env.DB_PATH = dbPath;
const { db } = await import('../src/db/connection.js');
const insPlan = (type, total, unit) => db.prepare('INSERT INTO package_plans (session_type, total_sessions, unit_price) VALUES (?, ?, ?)').run(type, total, unit);

expect('既有資料表補上 from_plan，舊資料是 NULL、其他欄位不變', () => {
  assert.ok(db.prepare('PRAGMA table_info(customer_packages)').all().some((c) => c.name === 'from_plan'));
  const r = db.prepare('SELECT * FROM customer_packages WHERE id = 1').get();
  assert.equal(r.from_plan, null);
  assert.equal(r.remaining_sessions, 7);
  assert.equal(r.amount, 14000);
  assert.equal(r.note, '舊方案');
  assert.equal(r.source, 'staff');
});
expect('from_plan 只接受 0／1／NULL', () => {
  assert.throws(() => db.prepare('UPDATE customer_packages SET from_plan = 2 WHERE id = 1').run(), /CHECK/);
  db.prepare('UPDATE customer_packages SET from_plan = 1 WHERE id = 1').run();
  db.prepare('UPDATE customer_packages SET from_plan = 0 WHERE id = 1').run();
  db.prepare('UPDATE customer_packages SET from_plan = NULL WHERE id = 1').run();
});
expect('package_plans 表存在；同類型同堂數不能重複，不同類型可以', () => {
  insPlan('1on1', 10, 1400);
  assert.throws(() => insPlan('1on1', 10, 1500), /UNIQUE/);
  insPlan('1on2', 10, 1900);
});
expect('package_plans 的 CHECK：類型、堂數 > 0、單價 > 0', () => {
  assert.throws(() => insPlan('group', 10, 1400), /CHECK/);
  assert.throws(() => insPlan('1on1', 0, 1400), /CHECK/);
  assert.throws(() => insPlan('1on1', 20, 0), /CHECK/);
});

// 另開行程再開一次同一個資料庫（重複開機）＋開一個全新的資料庫
const connUrl = new URL('../src/db/connection.js', import.meta.url).href;
const boot = (path, body) => execFileSync(process.execPath, ['--input-type=module', '-e',
  `const { db } = await import(${JSON.stringify(connUrl)}); ${body}`], { env: { ...process.env, DB_PATH: path }, encoding: 'utf8' });
expect('升級過的資料庫重複開機不出錯，資料還在', () => {
  const out = boot(dbPath, "console.log(db.prepare('SELECT COUNT(*) AS c FROM package_plans').get().c);");
  assert.equal(out.trim(), '2');
});
expect('全新資料庫的 customer_packages 也有 from_plan、也有 package_plans 表', () => {
  const out = boot(freshPath, "console.log(db.prepare('PRAGMA table_info(customer_packages)').all().some((c) => c.name === 'from_plan'), !!db.prepare(\"SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'package_plans'\").get());");
  assert.equal(out.trim(), 'true true');
});

db.close();
for (const p of [dbPath, freshPath]) for (const s of ['', '-wal', '-shm']) rmSync(p + s, { force: true });
console.log('[package-plan-migration test] done');
