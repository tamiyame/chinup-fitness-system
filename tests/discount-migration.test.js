import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rmSync } from 'node:fs';

const dbPath = join(tmpdir(), `discount-mig-${process.pid}.db`);
for (const s of ['', '-wal', '-shm']) rmSync(dbPath + s, { force: true });
const old = new DatabaseSync(dbPath);
old.exec(`
  CREATE TABLE users (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT, email TEXT, phone TEXT, password_hash TEXT, google_id TEXT, role TEXT NOT NULL DEFAULT 'user', notification_preference TEXT NOT NULL DEFAULT 'email', line_user_id TEXT, line_bind_code TEXT, line_bind_expires_at TEXT, created_at TEXT);
  CREATE TABLE coaches (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER, display_name TEXT, bio TEXT, specialty TEXT, avatar_path TEXT, is_active INTEGER DEFAULT 1, created_at TEXT);
  CREATE TABLE bookings (id INTEGER PRIMARY KEY AUTOINCREMENT, coach_id INTEGER NOT NULL, member_id INTEGER NOT NULL, start_at TEXT NOT NULL, end_at TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'confirmed', cancelled_at TEXT, cancelled_by INTEGER, cancel_reason TEXT, note TEXT, created_at TEXT, CHECK (start_at < end_at));
  CREATE TABLE group_orders (id INTEGER PRIMARY KEY AUTOINCREMENT, member_id INTEGER NOT NULL, customer_name TEXT NOT NULL, customer_phone TEXT NOT NULL, total_amount INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'pending', expires_at TEXT NOT NULL, paid_at TEXT, paid_by INTEGER, cancelled_at TEXT, created_at TEXT);
  INSERT INTO group_orders (member_id, customer_name, customer_phone, total_amount, expires_at) VALUES (1,'X','0900000000',500,'2030-01-01T00:00:00');
`);
old.close();
process.env.DB_PATH = dbPath;
const { db } = await import('../src/db/connection.js');

function expect(l, fn){ try{fn();console.log('  ✓ '+l);}catch(e){console.log('  ✗ '+l);console.error(e);process.exitCode=1;} }
const goCols = db.prepare('PRAGMA table_info(group_orders)').all().map(c=>c.name);
expect('group_orders has discount_code', ()=>assert(goCols.includes('discount_code')));
expect('group_orders has original_amount', ()=>assert(goCols.includes('original_amount')));
const bkCols = db.prepare('PRAGMA table_info(bookings)').all().map(c=>c.name);
expect('bookings has discount_amount', ()=>assert(bkCols.includes('discount_amount')));
expect('discount_codes table exists', ()=>assert(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='discount_codes'").get()));
expect('discount_redemptions exists', ()=>assert(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='discount_redemptions'").get()));
expect('app_settings seeded 1500', ()=>assert.equal(db.prepare("SELECT value FROM app_settings WHERE key='one_on_one_price'").get().value,'1500'));
expect('old order preserved', ()=>assert.equal(db.prepare('SELECT total_amount FROM group_orders WHERE id=1').get().total_amount,500));
console.log('[discount-migration] done');
