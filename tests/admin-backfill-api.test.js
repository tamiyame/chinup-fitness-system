// 管理者補登端點：availability?backfill=1（admin 限定）+ POST /api/admin/bookings/backfill。
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
const pad = n => String(n).padStart(2,'0');
const fmtDate = d => `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}`;

console.log('[admin-backfill-api test] start');
db.exec("DELETE FROM bookings WHERE member_id IN (SELECT id FROM users WHERE phone LIKE '0957%'); DELETE FROM users WHERE email LIKE 'abfa-%' OR phone LIKE '0957%'");
const uid = Number(db.prepare("INSERT INTO users (name,email,role) VALUES ('ABFA Coach','abfa-c@x.com','coach')").run().lastInsertRowid);
const coachId = Number(db.prepare("INSERT INTO coaches (user_id, display_name, is_active) VALUES (?, 'ABFA', 1)").run(uid).lastInsertRowid);

const past = new Date(Date.now() - 7*86400000);
const pastDate = fmtDate(past);
addRule({ coachId, dayOfWeek: past.getDay(), startTime: '09:00', endTime: '18:00', effectiveFrom: '2000-01-01' });
const pastStart = `${pastDate}T10:00:00`;

const login = await req('POST', '/api/auth/login', { body: { email: 'admin@chinup.local', password: 'admin1234' } });
const token = login.data?.token;
expect('admin login ok', () => assert.ok(token));

const avNoAuth = await req('GET', `/api/coaches/${coachId}/availability?from=${pastDate}&to=${pastDate}&backfill=1`);
expect('無 token + backfill=1 → 過去日期空清單', () => {
  assert.equal(avNoAuth.status, 200);
  assert.equal(avNoAuth.data.length, 0);
});

const avAdmin = await req('GET', `/api/coaches/${coachId}/availability?from=${pastDate}&to=${pastDate}&backfill=1`, { token });
expect('admin + backfill=1 → 過去 slot past:true', () => {
  assert.equal(avAdmin.status, 200);
  assert.ok(avAdmin.data.some(s => s.start === pastStart && s.past === true));
});

const bfNoAuth = await req('POST', '/api/admin/bookings/backfill', { body: { coachId, startAt: pastStart, name:'補登客', phone:'0957000001', sessionType:'1on1', amount:1500 } });
expect('無 token 補登 → 401', () => assert.equal(bfNoAuth.status, 401));

const futStart = `${fmtDate(new Date(Date.now()+7*86400000))}T10:00:00`;
const bfFut = await req('POST', '/api/admin/bookings/backfill', { token, body: { coachId, startAt: futStart, name:'未來', phone:'0957000002', sessionType:'1on1', amount:1500 } });
expect('未來 startAt 補登 → 400 not_past', () => { assert.equal(bfFut.status, 400); assert.equal(bfFut.data.error, 'not_past'); });

const bfNeg = await req('POST', '/api/admin/bookings/backfill', { token, body: { coachId, startAt: pastStart, name:'x', phone:'0957000003', sessionType:'1on1', amount:-1 } });
expect('負數金額 → 400 invalid_amount', () => { assert.equal(bfNeg.status, 400); assert.equal(bfNeg.data.error, 'invalid_amount'); });

const bfOk = await req('POST', '/api/admin/bookings/backfill', { token, body: { coachId, startAt: pastStart, name:'補登客', phone:'0957000001', sessionType:'1on1', amount:1500, note:'API 補登' } });
expect('補登成功 201', () => assert.equal(bfOk.status, 201));
const bid = bfOk.data?.id;

const my = await req('POST', '/api/public/my', { body: { phone: '0957000001', name: '補登客' } });
expect('補登預約出現在課表且 paid=true', () => {
  const item = my.data.items.find(x => x.kind === 'booking' && x.id === bid);
  assert.ok(item); assert.equal(item.paid, true);
});

db.exec(`DELETE FROM bookings WHERE coach_id = ${coachId}; DELETE FROM coaches WHERE id = ${coachId}; DELETE FROM users WHERE id = ${uid} OR phone LIKE '0957%'`);
console.log('[admin-backfill-api test] done');
