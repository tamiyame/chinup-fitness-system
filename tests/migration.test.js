// 驗證舊 DB（email NOT NULL、registrations 無 pending/order_id）升級後正確
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rmSync } from 'node:fs';

const dbPath = join(tmpdir(), `migration-test-${process.pid}.db`);
rmSync(dbPath, { force: true });
rmSync(dbPath + '-wal', { force: true });
rmSync(dbPath + '-shm', { force: true });

// 1) 建立「舊 schema」DB（email NOT NULL、registrations 舊 CHECK、無 group_orders）
const old = new DatabaseSync(dbPath);
old.exec(`
  CREATE TABLE users (
    id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL,
    email TEXT UNIQUE NOT NULL, phone TEXT, password_hash TEXT, google_id TEXT,
    role TEXT NOT NULL DEFAULT 'user', notification_preference TEXT NOT NULL DEFAULT 'email',
    line_user_id TEXT, line_bind_code TEXT, line_bind_expires_at TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE course_categories (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE NOT NULL, description TEXT, sort_order INTEGER NOT NULL DEFAULT 0, active INTEGER NOT NULL DEFAULT 1, created_at TEXT);
  CREATE TABLE course_templates (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, description TEXT, min_capacity INTEGER NOT NULL, max_capacity INTEGER NOT NULL, day_of_week INTEGER NOT NULL, start_time TEXT NOT NULL, duration_minutes INTEGER NOT NULL DEFAULT 60, recurrence TEXT NOT NULL, cycle_start_date TEXT NOT NULL, cycle_end_date TEXT NOT NULL, registration_deadline_hours INTEGER NOT NULL DEFAULT 24, status TEXT NOT NULL DEFAULT 'published', created_at TEXT);
  CREATE TABLE course_sessions (id INTEGER PRIMARY KEY AUTOINCREMENT, template_id INTEGER NOT NULL REFERENCES course_templates(id) ON DELETE CASCADE, session_date TEXT NOT NULL, start_at TEXT NOT NULL, end_at TEXT NOT NULL, registration_deadline TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'open', confirmed_count INTEGER NOT NULL DEFAULT 0, waitlist_count INTEGER NOT NULL DEFAULT 0, UNIQUE(template_id, session_date));
  CREATE TABLE registrations (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id INTEGER NOT NULL REFERENCES course_sessions(id) ON DELETE CASCADE, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, status TEXT NOT NULL CHECK(status IN ('confirmed','waitlisted','cancelled','rejected')), position INTEGER, registered_at TEXT NOT NULL DEFAULT (datetime('now')), UNIQUE(session_id, user_id));
  INSERT INTO users (name, email, phone, role) VALUES ('Old User', 'old@x.com', '0912345678', 'user');
  INSERT INTO course_templates (name, min_capacity, max_capacity, day_of_week, start_time, recurrence, cycle_start_date, cycle_end_date) VALUES ('Old Class', 1, 5, 1, '19:00', 'weekly', '2026-01-01', '2026-12-31');
  INSERT INTO course_sessions (template_id, session_date, start_at, end_at, registration_deadline) VALUES (1, '2026-06-01', '2026-06-01T19:00:00', '2026-06-01T20:00:00', '2026-05-31T19:00:00');
  INSERT INTO course_sessions (template_id, session_date, start_at, end_at, registration_deadline) VALUES (1, '2026-06-08', '2026-06-08T19:00:00', '2026-06-08T20:00:00', '2026-06-07T19:00:00');
  INSERT INTO registrations (session_id, user_id, status) VALUES (1, 1, 'confirmed');
`);
old.close();

// 2) 設定 DB_PATH 後 import connection（觸發 migration）
process.env.DB_PATH = dbPath;
const { db } = await import('../src/db/connection.js');

function expect(label, fn) {
  try { fn(); console.log(`  ✓ ${label}`); }
  catch (e) { console.log(`  ✗ ${label}`); console.error(e); process.exitCode = 1; }
}

console.log('[migration test] start');

const emailCol = db.prepare('PRAGMA table_info(users)').all().find((c) => c.name === 'email');
expect('users.email is now nullable', () => assert.equal(emailCol.notnull, 0));

const regCols = db.prepare('PRAGMA table_info(registrations)').all().map((c) => c.name);
expect('registrations has order_id', () => assert(regCols.includes('order_id')));
expect('registrations has amount_due', () => assert(regCols.includes('amount_due')));

expect('group_orders table exists', () =>
  assert(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='group_orders'").get()));

expect('idx_users_phone exists', () =>
  assert(db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='idx_users_phone'").get()));

const tplCols = db.prepare('PRAGMA table_info(course_templates)').all().map((c) => c.name);
expect('course_templates has price_per_session', () => assert(tplCols.includes('price_per_session')));

expect('course_templates has auto_renew', () => assert(tplCols.includes('auto_renew')));
expect('auto_renew 回填：結束日 ≥ 今天的舊範本 = 1、旗標已寫', () => {
  assert.equal(db.prepare("SELECT auto_renew FROM course_templates WHERE name='Old Class'").get().auto_renew, 1);
  assert.equal(db.prepare("SELECT value FROM app_settings WHERE key='auto_renew_backfill_done'").get()?.value, '1');
});

expect('member_point_balance view dropped', () =>
  assert(!db.prepare("SELECT name FROM sqlite_master WHERE type='view' AND name='member_point_balance'").get()));

// 資料保留
expect('user row preserved', () => assert.equal(db.prepare('SELECT name FROM users WHERE id=1').get().name, 'Old User'));
expect('registration row preserved', () => assert.equal(db.prepare('SELECT status FROM registrations WHERE id=1').get().status, 'confirmed'));

// pending status 現在可插入
expect('pending registration allowed', () => {
  db.prepare("INSERT INTO group_orders (member_id, customer_name, customer_phone, total_amount, expires_at) VALUES (1,'Old User','0912345678',500,'2026-06-01T00:00:00')").run();
  const oid = db.prepare('SELECT last_insert_rowid() AS id').get().id;
  db.prepare("INSERT INTO registrations (session_id, user_id, status, order_id, amount_due) VALUES (2,1,'pending',?,500)").run(oid);
});

console.log('[migration test] done');
