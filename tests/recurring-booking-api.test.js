// 循環預約 API：匿名 401、preview→create 全流程、markPaid 對應已核對清單。
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
console.log('[recurring-booking-api test] start');

db.exec("DELETE FROM notifications WHERE user_id IN (SELECT id FROM users WHERE phone LIKE '0985%' OR email LIKE 'rca-%'); DELETE FROM bookings WHERE member_id IN (SELECT id FROM users WHERE phone LIKE '0985%'); DELETE FROM users WHERE phone LIKE '0985%' OR email LIKE 'rca-%'");
const uid = Number(db.prepare("INSERT INTO users (name,email,role) VALUES ('RCA Coach','rca-c@x.com','coach')").run().lastInsertRowid);
const coachId = Number(db.prepare("INSERT INTO coaches (user_id, display_name, is_active) VALUES (?, 'RCA', 1)").run(uid).lastInsertRowid);
const pad = n => String(n).padStart(2,'0');
const day = (d) => { const x = new Date(Date.now() + d*86400000); return `${x.getFullYear()}-${pad(x.getMonth()+1)}-${pad(x.getDate())}`; };
for (let dow = 0; dow <= 6; dow++) addRule({ coachId, dayOfWeek: dow, startTime: '09:00', endTime: '18:00' });
const base = `${day(5)}T11:00:00`;
const body = { coachId, startAt: base, sessionType: '1on1', frequency: 'weekly', count: 3 };

const anon = await req('POST', '/api/bookings/recurring/preview', { body });
expect('匿名 preview → 401', () => assert.equal(anon.status, 401));
const anonC = await req('POST', '/api/bookings/recurring', { body });
expect('匿名 create → 401', () => assert.equal(anonC.status, 401));

const login = await req('POST', '/api/auth/login', { body: { email: 'admin@chinup.local', password: 'admin1234' } });
const token = login.data?.token;
expect('admin login ok', () => assert.ok(token));

const pv = await req('POST', '/api/bookings/recurring/preview', { body, token });
expect('preview：3 場全 ok', () => {
  assert.equal(pv.status, 200);
  assert.equal(pv.data.occurrences.length, 3);
  assert.ok(pv.data.occurrences.every(o => o.ok));
});

const cr = await req('POST', '/api/bookings/recurring', {
  token,
  body: { ...body, name: '循環API客', phone: '0985000111', markPaid: true },
});
expect('create 201：建 3 堂、markPaid', () => {
  assert.equal(cr.status, 201);
  assert.equal(cr.data.created.length, 3);
  assert.equal(cr.data.markPaid, true);
});

const pending = await req('GET', '/api/admin/bookings/pending', { token });
expect('markPaid → 不進待核對', () => {
  assert.ok(!pending.data.some(x => cr.data.created.some(c => c.id === x.id)));
});
const done = await req('GET', '/api/admin/payments/confirmed', { token });
expect('markPaid → 出現在已核對清單', () => {
  assert.ok(cr.data.created.every(c => done.data.some(x => x.type === 'booking' && x.id === c.id)));
});

const av = await req('GET', `/api/coaches/${coachId}/availability?from=${day(5)}&to=${day(5)}`);
expect('首堂時段已被佔用（11:00 消失）', () => assert.ok(!av.data.some(s => s.start === base)));

const my = await req('POST', '/api/public/my', { body: { phone: '0985000111', name: '循環API客' } });
expect('我的課表：3 堂、全部 paid', () => {
  const items = my.data.items.filter(x => x.kind === 'booking');
  assert.equal(items.length, 3);
  assert.ok(items.every(x => x.paid === true));
});

db.exec("DELETE FROM notifications WHERE user_id IN (SELECT id FROM users WHERE phone LIKE '0985%' OR email LIKE 'rca-%'); DELETE FROM bookings WHERE coach_id = " + coachId + "; DELETE FROM coaches WHERE id = " + coachId + "; DELETE FROM users WHERE phone LIKE '0985%' OR email LIKE 'rca-%'");
console.log('[recurring-booking-api test] done');
