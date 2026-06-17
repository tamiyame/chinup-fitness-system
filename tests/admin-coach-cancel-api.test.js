// 管理者代教練取消未來預約 = coach-flavored：會員收到 booking_cancelled_by_coach、需 reason。
// 非管理者(非擁有教練)帶 coachId 取消 → 403；coachId 與 booking 不符 → 403；缺 reason → 400。
// server 需帶 LINE_MOCK=1 GCAL_MOCK=1 GMAIL_MOCK=1。
import assert from 'node:assert/strict';
import { db } from '../src/db/connection.js';
import { hashPassword } from '../src/services/auth.js';
const BASE = process.env.BASE || 'http://localhost:3000';
async function req(method, path, { body, token } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers['Authorization'] = `Bearer ${token}`;
  const res = await fetch(BASE + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text(); let data; try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  return { status: res.status, data };
}
function expect(label, fn){ try{fn();console.log(`  ✓ ${label}`);}catch(e){console.log(`  ✗ ${label}`);console.error(e);process.exitCode=1;} }
const pad = n => String(n).padStart(2,'0');
const fmtDate = d => `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}`;

console.log('[admin-coach-cancel-api test] start');
db.exec(`
  DELETE FROM notifications WHERE user_id IN (SELECT id FROM users WHERE email LIKE 'accx-%');
  DELETE FROM bookings WHERE coach_id IN (SELECT id FROM coaches WHERE user_id IN (SELECT id FROM users WHERE email LIKE 'accx-%'));
  DELETE FROM bookings WHERE member_id IN (SELECT id FROM users WHERE email LIKE 'accx-%');
  DELETE FROM coaches WHERE user_id IN (SELECT id FROM users WHERE email LIKE 'accx-%');
  DELETE FROM users WHERE email LIKE 'accx-%';
`);
// 目標教練 C、會員 M、未來預約 b
const cUid = Number(db.prepare("INSERT INTO users (name,email,role) VALUES ('ACCX Coach','accx-c@x.com','coach')").run().lastInsertRowid);
const cId = Number(db.prepare("INSERT INTO coaches (user_id, display_name, is_active) VALUES (?, 'ACCX-C', 1)").run(cUid).lastInsertRowid);
const mUid = Number(db.prepare("INSERT INTO users (name,email,role) VALUES ('ACCX Member','accx-m@x.com','user')").run().lastInsertRowid);
// 另一位非管理者教練 D（用來測 403）
const dUid = Number(db.prepare("INSERT INTO users (name,email,role,is_admin,password_hash) VALUES ('ACCX Other','accx-d@x.com','coach',0,?)").run(hashPassword('coachpass123')).lastInsertRowid);
db.prepare("INSERT INTO coaches (user_id, display_name, is_active) VALUES (?, 'ACCX-D', 1)").run(dUid);

const future = new Date(Date.now() + 3*86400000);
let bookingSlot = 10;
function makeBooking() {
  const h = pad(bookingSlot++);
  const startAt = `${fmtDate(future)}T${h}:00:00`;
  const endAt   = `${fmtDate(future)}T${h}:59:00`;
  return Number(db.prepare("INSERT INTO bookings (coach_id, member_id, start_at, end_at, status, session_type) VALUES (?,?,?,?,'confirmed','1on1')")
    .run(cId, mUid, startAt, endAt).lastInsertRowid);
}

const login = await req('POST', '/api/auth/login', { body: { email: 'admin@chinup.local', password: 'admin1234' } });
const token = login.data?.token;
expect('admin login ok', () => assert.ok(token));
const dlogin = await req('POST', '/api/auth/login', { body: { email: 'accx-d@x.com', password: 'coachpass123' } });
const dtoken = dlogin.data?.token;

// 缺 reason → 400
const b1 = makeBooking();
const noReason = await req('DELETE', `/api/bookings/${b1}?coachId=${cId}`, { token, body: {} });
expect('admin 代取消缺 reason → 400 missing_reason', () => { assert.equal(noReason.status, 400); assert.equal(noReason.data.error, 'missing_reason'); });

// admin 帶相符 coachId + reason → 200，會員收到 booking_cancelled_by_coach
const b2 = makeBooking();
const ok = await req('DELETE', `/api/bookings/${b2}?coachId=${cId}`, { token, body: { reason: '教練臨時有事' } });
expect('admin 代取消 → 200', () => assert.equal(ok.status, 200));
expect('預約已取消', () => { const row = db.prepare('SELECT status, cancel_reason FROM bookings WHERE id=?').get(b2); assert.equal(row.status, 'cancelled'); assert.equal(row.cancel_reason, '教練臨時有事'); });
expect('會員收到 booking_cancelled_by_coach', () => {
  const n = db.prepare("SELECT COUNT(*) c FROM notifications WHERE user_id=? AND type='booking_cancelled_by_coach'").get(mUid);
  assert.ok(n.c >= 1);
});

// coachId 與 booking.coach_id 不符（admin）→ 不視為代理 → 403
const b3 = makeBooking();
const mismatch = await req('DELETE', `/api/bookings/${b3}?coachId=999999`, { token, body: { reason: 'x' } });
expect('admin coachId 不符 → 403 forbidden', () => assert.equal(mismatch.status, 403));

// 非管理者(非擁有教練 D)帶 coachId=C 取消 → 403
const b4 = makeBooking();
const dCancel = await req('DELETE', `/api/bookings/${b4}?coachId=${cId}`, { token: dtoken, body: { reason: 'x' } });
expect('非管理者非擁有者代取消 → 403 forbidden', () => assert.equal(dCancel.status, 403));

db.exec(`
  DELETE FROM notifications WHERE user_id IN (${mUid}, ${cUid}, ${dUid});
  DELETE FROM bookings WHERE coach_id = ${cId};
  DELETE FROM coaches WHERE user_id IN (${cUid}, ${dUid});
  DELETE FROM users WHERE email LIKE 'accx-%';
`);
console.log('[admin-coach-cancel-api test] done');
