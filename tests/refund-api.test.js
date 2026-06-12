// 取消並退款 API：權限守門 + 教練課端到端（核對→退款→時段釋出→已核對清單標記）。
// server 需帶 LINE_MOCK=1 GCAL_MOCK=1 GMAIL_MOCK=1。
import assert from 'node:assert/strict';
import { db } from '../src/db/connection.js';
import { addRule } from '../src/services/availabilityService.js';
const BASE = process.env.BASE || 'http://localhost:3000';
async function req(method, path, { body, token } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers['Authorization'] = `Bearer ${token}`;
  const res = await fetch(BASE + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text(); let data; try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  return { status: res.status, data };
}
function expect(label, fn){ try{fn();console.log(`  ✓ ${label}`);}catch(e){console.log(`  ✗ ${label}`);console.error(e);process.exitCode=1;} }
console.log('[refund-api test] start');

db.exec("DELETE FROM notifications WHERE user_id IN (SELECT id FROM users WHERE phone LIKE '0988%' OR email LIKE 'rfa-%'); DELETE FROM bookings WHERE member_id IN (SELECT id FROM users WHERE phone LIKE '0988%'); DELETE FROM users WHERE phone LIKE '0988%' OR email LIKE 'rfa-%'");
const uid = Number(db.prepare("INSERT INTO users (name,email,role) VALUES ('RFA Coach','rfa-c@x.com','coach')").run().lastInsertRowid);
const coachId = Number(db.prepare("INSERT INTO coaches (user_id, display_name, is_active) VALUES (?, 'RFA', 1)").run(uid).lastInsertRowid);
const pad = n => String(n).padStart(2,'0');
const d = new Date(Date.now() + 4*86400000);
const date = `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}`;
addRule({ coachId, dayOfWeek: d.getDay(), startTime: '09:00', endTime: '18:00' });

const login = await req('POST', '/api/auth/login', { body: { email: 'admin@chinup.local', password: 'admin1234' } });
const token = login.data?.token;
expect('admin login ok', () => assert.ok(token));

const bk = await req('POST', '/api/public/bookings', { body: { coachId, startAt: `${date}T13:00:00`, name: '柯小退', phone: '0988000111' } });
const bid = bk.data?.id;
expect('預約 201', () => assert.equal(bk.status, 201));

const noAuth = await req('POST', `/api/admin/bookings/${bid}/refund`);
expect('無 token refund → 401', () => assert.equal(noAuth.status, 401));

const early = await req('POST', `/api/admin/bookings/${bid}/refund`, { token });
expect('未核對先退款 → 409 not_paid', () => {
  assert.equal(early.status, 409);
  assert.equal(early.data.error, 'not_paid');
});

await req('POST', `/api/admin/bookings/${bid}/confirm-payment`, { token });
const rf = await req('POST', `/api/admin/bookings/${bid}/refund`, { token });
expect('核對後退款 → 200 cancelled:true', () => {
  assert.equal(rf.status, 200);
  assert.equal(rf.data.cancelled, true);
});

const av = await req('GET', `/api/coaches/${coachId}/availability?from=${date}&to=${date}`);
expect('退款後 13:00 時段釋出', () => assert.ok(av.data.some(s => s.start === `${date}T13:00:00`)));

const done = await req('GET', '/api/admin/payments/confirmed', { token });
expect('已核對清單保留並帶 refunded_at', () => {
  const row = done.data.find(x => x.type === 'booking' && x.id === bid);
  assert.ok(row && row.refunded_at);
});

const rf2 = await req('POST', `/api/admin/bookings/${bid}/refund`, { token });
expect('重複退款 → 409 already_refunded', () => {
  assert.equal(rf2.status, 409);
  assert.equal(rf2.data.error, 'already_refunded');
});

db.exec("DELETE FROM notifications WHERE user_id IN (SELECT id FROM users WHERE phone LIKE '0988%' OR email LIKE 'rfa-%'); DELETE FROM bookings WHERE coach_id = " + coachId + "; DELETE FROM coaches WHERE id = " + coachId + "; DELETE FROM users WHERE phone LIKE '0988%' OR email LIKE 'rfa-%'");
console.log('[refund-api test] done');
