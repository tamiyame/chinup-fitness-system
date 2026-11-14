// 線上單堂方案：既有資料庫升級（customer_packages 補 source 欄位、bookings(package_id) 索引）。
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rmSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

const dbPath = join(tmpdir(), `online-single-mig-${process.pid}.db`);
for (const s of ['', '-wal', '-shm']) rmSync(dbPath + s, { force: true });

function expect(label, fn) { try { fn(); console.log(`  ✓ ${label}`); } catch (e) { console.log(`  ✗ ${label}`); console.error(e); process.exitCode = 1; } }
console.log('[online-single-migration test] start');

// 改動前的 customer_packages（沒有 source 欄位）＋一筆舊資料
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
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  archived_at TEXT
);
`);
old.prepare("INSERT INTO customer_packages (member_id, session_type, total_sessions, remaining_sessions) VALUES (1, '1on1', 10, 10)").run();
old.close();

process.env.DB_PATH = dbPath;
const { db } = await import('../src/db/connection.js');

expect('既有資料表補上 source，舊資料預設 staff', () => {
  assert.ok(db.prepare('PRAGMA table_info(customer_packages)').all().some((c) => c.name === 'source'));
  assert.equal(db.prepare('SELECT source FROM customer_packages WHERE id = 1').get().source, 'staff');
});
expect('source 只接受 staff／online', () => {
  assert.throws(() => db.prepare("UPDATE customer_packages SET source = 'bogus' WHERE id = 1").run(), /CHECK/);
});
expect('bookings(package_id) 有索引', () => {
  assert.ok(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = 'idx_bookings_package'").get());
});
