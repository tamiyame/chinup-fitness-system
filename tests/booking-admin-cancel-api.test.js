// admin 取消教練課預約 API：權限、流程、時段釋出。
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
console.log('[booking-admin-cancel-api test] start');

db.exec("DELETE FROM notifications WHERE user_id IN (SELECT id FROM users WHERE phone LIKE '0992%' OR email LIKE 'bca-%'); DELETE FROM bookings WHERE member_id IN (SELECT id FROM users WHERE phone LIKE '0992%'); DELETE FROM users WHERE phone LIKE '0992%' OR email LIKE 'bca-%'");
const uid = Number(db.prepare("INSERT INTO users (name,email,role) VALUES ('BCA Coach','bca-c@x.com','coach')").run().lastInsertRowid);
const coachId = Number(db.prepare("INSERT INTO coaches (user_id, display_name, is_active) VALUES (?, 'BCA', 1)").run(uid).lastInsertRowid);
const pad = n => String(n).padStart(2,'0');
const d = new Date(Date.now() + 4*86400000);
const date = `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}`;
addRule({ coachId, dayOfWeek: d.getDay(), startTime: '09:00', endTime: '18:00' });

const login = await req('POST', '/api/auth/login', { body: { email: 'admin@chinup.local', password: 'admin1234' } });
const token = login.data?.token;
expect('admin login ok', () => assert.ok(token));

const bk = await req('POST', '/api/public/bookings', { body: { coachId, startAt: `${date}T11:00:00`, name: '鄭小消', phone: '0992000111' } });
expect('預約 201', () => assert.equal(bk.status, 201));
const bid = bk.data?.id;

const av1 = await req('GET', `/api/coaches/${coachId}/availability?from=${date}&to=${date}`);
expect('預約後 11:00 不在可約清單', () => assert.ok(!av1.data.some(s => s.start === `${date}T11:00:00`)));

const noAuth = await req('POST', `/api/admin/bookings/${bid}/cancel`);
expect('無 token cancel → 401', () => assert.equal(noAuth.status, 401));

const c1 = await req('POST', `/api/admin/bookings/${bid}/cancel`, { token, body: { reason: '測試取消' } });
expect('admin cancel → 200', () => assert.equal(c1.status, 200));

const c2 = await req('POST', `/api/admin/bookings/${bid}/cancel`, { token });
expect('重複 cancel → 409 already_cancelled', () => {
  assert.equal(c2.status, 409);
  assert.equal(c2.data.error, 'already_cancelled');
});

const p = await req('GET', '/api/admin/bookings/pending', { token });
expect('取消後不在待核對清單', () => assert.ok(!p.data.some(x => x.id === bid)));

const av2 = await req('GET', `/api/coaches/${coachId}/availability?from=${date}&to=${date}`);
expect('取消後 11:00 時段釋出', () => assert.ok(av2.data.some(s => s.start === `${date}T11:00:00`)));

db.exec("DELETE FROM notifications WHERE user_id IN (SELECT id FROM users WHERE phone LIKE '0992%' OR email LIKE 'bca-%'); DELETE FROM bookings WHERE coach_id = " + coachId + "; DELETE FROM coaches WHERE id = " + coachId + "; DELETE FROM users WHERE phone LIKE '0992%' OR email LIKE 'bca-%'");
console.log('[booking-admin-cancel-api test] done');
