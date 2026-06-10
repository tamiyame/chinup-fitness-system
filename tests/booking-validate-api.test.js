// 預約送出驗證管線（API 層）：off-grid 409、email 入庫、invalid_email 400。
// 需先起 server：LINE_MOCK=1 GCAL_MOCK=1 GMAIL_MOCK=1 PORT=3100 node src/server.js
import assert from 'node:assert/strict';
import { db } from '../src/db/connection.js';
import { addRule } from '../src/services/availabilityService.js';
const BASE = process.env.BASE || 'http://localhost:3000';
async function req(method, path, { body } = {}) {
  const res = await fetch(BASE + path, { method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text(); let data; try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  return { status: res.status, data };
}
function expect(label, fn){ try{fn();console.log(`  ✓ ${label}`);}catch(e){console.log(`  ✗ ${label}`);console.error(e);process.exitCode=1;} }
console.log('[booking-validate-api test] start');

// 比照 booking-anon reset：先刪 notifications（FK 無 cascade）再刪 users
db.exec("DELETE FROM notifications WHERE user_id IN (SELECT id FROM users WHERE phone LIKE '0997%' OR email LIKE 'bv-%'); DELETE FROM bookings WHERE member_id IN (SELECT id FROM users WHERE phone LIKE '0997%'); DELETE FROM users WHERE phone LIKE '0997%' OR email LIKE 'bv-%'");
const uid = Number(db.prepare("INSERT INTO users (name,email,role) VALUES ('BV Coach','bv-c@x.com','coach')").run().lastInsertRowid);
const coachId = Number(db.prepare("INSERT INTO coaches (user_id, display_name, is_active) VALUES (?, 'BV', 1)").run(uid).lastInsertRowid);
const pad = n => String(n).padStart(2,'0');
const d = new Date(Date.now() + 4*86400000);
const date = `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}`;
addRule({ coachId, dayOfWeek: d.getDay(), startTime: '09:00', endTime: '18:00' });

const av = await req('GET', `/api/coaches/${coachId}/availability?from=${date}&to=${date}`);
expect('availability 回 {start, remain} 物件陣列', () => {
  assert.equal(av.status, 200);
  assert(Array.isArray(av.data) && av.data.length > 0);
  assert(typeof av.data[0].start === 'string' && typeof av.data[0].remain === 'number');
});

const offGrid = await req('POST', '/api/public/bookings', { body: { coachId, startAt: `${date}T05:00:00`, name: '越界', phone: '0997000111' } });
expect('班表外時段 → 409 slot_unavailable', () => {
  assert.equal(offGrid.status, 409);
  assert.equal(offGrid.data.error, 'slot_unavailable');
});

const badEmail = await req('POST', '/api/public/bookings', { body: { coachId, startAt: `${date}T10:00:00`, name: '壞信', phone: '0997000222', email: 'oops' } });
expect('email 格式錯 → 400 invalid_email', () => {
  assert.equal(badEmail.status, 400);
  assert.equal(badEmail.data.error, 'invalid_email');
});

const ok = await req('POST', '/api/public/bookings', { body: { coachId, startAt: `${date}T10:00:00`, name: '王小信', phone: '0997000333', email: 'ok@example.com' } });
expect('合法預約 + email → 201 且入庫', () => {
  assert.equal(ok.status, 201);
  assert.equal(db.prepare('SELECT customer_email FROM bookings WHERE id=?').get(ok.data.id).customer_email, 'ok@example.com');
});

const dup = await req('POST', '/api/public/bookings', { body: { coachId, startAt: `${date}T10:00:00`, name: '撞期', phone: '0997000444' } });
expect('同教練同時段 → 409（slot_unavailable 或 slot_taken）', () => {
  assert.equal(dup.status, 409);
  assert(['slot_unavailable', 'slot_taken'].includes(dup.data.error));
});

db.exec("DELETE FROM notifications WHERE user_id IN (SELECT id FROM users WHERE phone LIKE '0997%' OR email LIKE 'bv-%'); DELETE FROM bookings WHERE coach_id = " + coachId + "; DELETE FROM coaches WHERE id = " + coachId + "; DELETE FROM users WHERE phone LIKE '0997%' OR email LIKE 'bv-%'");
console.log('[booking-validate-api test] done');
