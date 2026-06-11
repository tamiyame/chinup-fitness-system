// 付款核對 API：pending/confirm/confirmed 三端點 + /api/public/my 的 paid 欄位。
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
console.log('[booking-payment-api test] start');

// 比照 booking-validate reset：notifications 子查詢需含 email（教練無電話、其通知會擋 users 刪除）
db.exec("DELETE FROM notifications WHERE user_id IN (SELECT id FROM users WHERE phone LIKE '0994%' OR email LIKE 'bpa-%'); DELETE FROM bookings WHERE member_id IN (SELECT id FROM users WHERE phone LIKE '0994%'); DELETE FROM users WHERE phone LIKE '0994%' OR email LIKE 'bpa-%'");
const uid = Number(db.prepare("INSERT INTO users (name,email,role) VALUES ('BPA Coach','bpa-c@x.com','coach')").run().lastInsertRowid);
const coachId = Number(db.prepare("INSERT INTO coaches (user_id, display_name, is_active) VALUES (?, 'BPA', 1)").run(uid).lastInsertRowid);
const pad = n => String(n).padStart(2,'0');
const d = new Date(Date.now() + 4*86400000);
const date = `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}`;
addRule({ coachId, dayOfWeek: d.getDay(), startTime: '09:00', endTime: '18:00' });

const login = await req('POST', '/api/auth/login', { body: { email: 'admin@chinup.local', password: 'admin1234' } });
const token = login.data?.token;
expect('admin login ok', () => assert.ok(token));

// 公開預約 → 應為待核對
const bk = await req('POST', '/api/public/bookings', { body: { coachId, startAt: `${date}T10:00:00`, name: '吳小核', phone: '0994000111' } });
expect('預約 201', () => assert.equal(bk.status, 201));
const bid = bk.data?.id;

const p1 = await req('GET', '/api/admin/bookings/pending', { token });
expect('pending 清單含新預約', () => {
  assert.equal(p1.status, 200);
  assert.ok(p1.data.some(x => x.id === bid));
});
const noAuth = await req('GET', '/api/admin/bookings/pending');
expect('無 token pending → 401', () => assert.equal(noAuth.status, 401));

const my1 = await req('POST', '/api/public/my', { body: { phone: '0994000111', name: '吳小核' } });
expect('我的課表：paid=false（待確認）', () => {
  const item = my1.data.items.find(x => x.kind === 'booking' && x.id === bid);
  assert.ok(item);
  assert.equal(item.paid, false);
});

const cf = await req('POST', `/api/admin/bookings/${bid}/confirm-payment`, { token });
expect('confirm-payment 200', () => assert.equal(cf.status, 200));
const cf2 = await req('POST', `/api/admin/bookings/${bid}/confirm-payment`, { token });
expect('重複 confirm → 409 already_paid', () => {
  assert.equal(cf2.status, 409);
  assert.equal(cf2.data.error, 'already_paid');
});

const p2 = await req('GET', '/api/admin/bookings/pending', { token });
expect('confirm 後不在 pending', () => assert.ok(!p2.data.some(x => x.id === bid)));

const done = await req('GET', '/api/admin/payments/confirmed', { token });
expect('confirmed 清單含該預約（type=booking、有經手人）', () => {
  assert.equal(done.status, 200);
  const row = done.data.find(x => x.type === 'booking' && x.id === bid);
  assert.ok(row);
  assert.ok(row.paid_by_name);
});

const my2 = await req('POST', '/api/public/my', { body: { phone: '0994000111', name: '吳小核' } });
expect('我的課表：paid=true（已確認）', () => {
  const item = my2.data.items.find(x => x.kind === 'booking' && x.id === bid);
  assert.equal(item.paid, true);
});

db.exec("DELETE FROM notifications WHERE user_id IN (SELECT id FROM users WHERE phone LIKE '0994%' OR email LIKE 'bpa-%'); DELETE FROM bookings WHERE coach_id = " + coachId + "; DELETE FROM coaches WHERE id = " + coachId + "; DELETE FROM users WHERE phone LIKE '0994%' OR email LIKE 'bpa-%'");
console.log('[booking-payment-api test] done');
