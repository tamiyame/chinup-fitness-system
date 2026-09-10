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
  CREATE TABLE discount_codes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    code TEXT NOT NULL UNIQUE,
    discount_type TEXT NOT NULL CHECK(discount_type IN ('percent','fixed')),
    discount_value INTEGER NOT NULL,
    active INTEGER NOT NULL DEFAULT 1,
    valid_from TEXT, valid_until TEXT, max_uses INTEGER, per_phone_limit INTEGER, min_amount INTEGER, note TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE discount_redemptions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    code_id INTEGER NOT NULL REFERENCES discount_codes(id),
    phone TEXT NOT NULL,
    kind TEXT NOT NULL CHECK(kind IN ('group_order','booking')),
    ref_id INTEGER NOT NULL,
    amount INTEGER NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  INSERT INTO discount_codes (id, code, discount_type, discount_value, note) VALUES (7, 'OLDFIX', 'fixed', 100, 'legacy');
  INSERT INTO discount_redemptions (code_id, phone, kind, ref_id, amount) VALUES (7, '0900000000', 'group_order', 1, 100);
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

// ── fixed_price：舊 CHECK 的 discount_codes 整表 rebuild ──
expect('discount_codes CHECK 含 fixed_price', ()=>{ const sql=db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='discount_codes'").get().sql; assert(sql.includes("'fixed_price'"), sql); });
expect('discount_codes_new 沒殘留', ()=>assert.equal(db.prepare("SELECT name FROM sqlite_master WHERE name='discount_codes_new'").get(), undefined));
expect('舊碼 id/型態/值/備註原樣', ()=>{ const r=db.prepare('SELECT * FROM discount_codes WHERE id=7').get(); assert.equal(r.code,'OLDFIX'); assert.equal(r.discount_type,'fixed'); assert.equal(r.discount_value,100); assert.equal(r.note,'legacy'); });
expect('redemption 仍指向 id 7、FK 檢查乾淨', ()=>{ const r=db.prepare('SELECT code_id FROM discount_redemptions WHERE ref_id=1').get(); assert.equal(r.code_id,7); assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []); });
expect('升級後可寫入 fixed_price', ()=>{ db.prepare("INSERT INTO discount_codes (code, discount_type, discount_value) VALUES ('NEWFP','fixed_price',1200)").run(); assert.equal(db.prepare("SELECT discount_type FROM discount_codes WHERE code='NEWFP'").get().discount_type,'fixed_price'); });
expect('UNIQUE(code) 在 rebuild 後仍在', ()=>assert.throws(()=>db.prepare("INSERT INTO discount_codes (code, discount_type, discount_value) VALUES ('OLDFIX','percent',5)").run(), /UNIQUE/));
expect('rebuild 後新 id 接續（不與 7 撞）', ()=>{ const id=Number(db.prepare("INSERT INTO discount_codes (code, discount_type, discount_value) VALUES ('NEWFP2','fixed_price',900)").run().lastInsertRowid); assert(id>7, String(id)); });

console.log('[discount-migration] done');
