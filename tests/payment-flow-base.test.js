// 視窗無上限 + 教練列表 created_at 排序 + paid_at/paid_by 欄位與 backfill 語意。
import assert from 'node:assert/strict';
import { db, nowLocal } from '../src/db/connection.js';
import { addRule, computeAvailableSlots } from '../src/services/availabilityService.js';
import { listCoachBookings } from '../src/services/bookingService.js';

function expect(label, fn){ try{fn();console.log(`  ✓ ${label}`);}catch(e){console.log(`  ✗ ${label}`);console.error(e);process.exitCode=1;} }
console.log('[payment-flow-base test] start');
db.exec("DELETE FROM bookings; DELETE FROM coaches; DELETE FROM users WHERE email LIKE 'pfb-%'");

const uid = Number(db.prepare("INSERT INTO users (name,email,role) VALUES ('PFB Coach','pfb-c@x.com','coach')").run().lastInsertRowid);
const coachId = Number(db.prepare("INSERT INTO coaches (user_id, display_name, is_active) VALUES (?, 'PFB', 1)").run(uid).lastInsertRowid);
const mid = Number(db.prepare("INSERT INTO users (name,email,role) VALUES ('客','pfb-m@x.com','user')").run().lastInsertRowid);
const pad = n => String(n).padStart(2,'0');
const dateAt = (days) => { const d = new Date(Date.now() + days*86400000); return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}`; };

// 規則覆蓋所有星期（任何遠期日期都有班表）
for (let dow = 0; dow <= 6; dow++) addRule({ coachId, dayOfWeek: dow, startTime: '09:00', endTime: '12:00' });

expect('視窗無上限：+400 天仍有 slot（預設）', () => {
  const far = dateAt(400);
  const s = computeAvailableSlots({ coachId, fromDate: far, toDate: far });
  assert.ok(s.length > 0);
});
expect('bookingWindowDays 參數仍可限縮（30 → +400 天無 slot）', () => {
  const far = dateAt(400);
  const s = computeAvailableSlots({ coachId, fromDate: far, toDate: far, bookingWindowDays: 30 });
  assert.equal(s.length, 0);
});

// paid_at / paid_by 欄位存在
const cols = db.prepare('PRAGMA table_info(bookings)').all().map(c=>c.name);
expect('bookings.paid_at 存在', () => assert.ok(cols.includes('paid_at')));
expect('bookings.paid_by 存在', () => assert.ok(cols.includes('paid_by')));

// backfill 語意（直接驗證遷移 UPDATE 的條件式，於 fixture 列重現）：
// 過去場次 → paid、未來場次 → NULL
const insB = db.prepare("INSERT INTO bookings (coach_id, member_id, start_at, end_at, status) VALUES (?, ?, ?, ?, 'confirmed')");
const past = Number(insB.run(coachId, mid, '2020-01-01T10:00:00', '2020-01-01T11:00:00').lastInsertRowid);
const fut  = Number(insB.run(coachId, mid, `${dateAt(10)}T10:00:00`, `${dateAt(10)}T11:00:00`).lastInsertRowid);
db.prepare("UPDATE bookings SET paid_at = created_at WHERE status='confirmed' AND paid_at IS NULL AND start_at < ?").run(nowLocal());
expect('backfill：過去場次 → paid_at=created_at', () => {
  const r = db.prepare('SELECT paid_at, created_at FROM bookings WHERE id=?').get(past);
  assert.ok(r.paid_at && r.paid_at === r.created_at);
});
expect('backfill：未來場次 → paid_at NULL（進待核對）', () => {
  assert.equal(db.prepare('SELECT paid_at FROM bookings WHERE id=?').get(fut).paid_at, null);
});

// 教練列表排序：created_at 新→舊（同秒以 id 決勝）
expect('listCoachBookings 以 created_at DESC, id DESC', () => {
  const list = listCoachBookings(coachId);
  assert.equal(list[0].id, fut);   // 後插入者在前（同 created_at 秒級時 id 較大者在前）
  assert.equal(list[1].id, past);
});

db.exec("DELETE FROM bookings; DELETE FROM coaches; DELETE FROM users WHERE email LIKE 'pfb-%'");
console.log('[payment-flow-base test] done');
