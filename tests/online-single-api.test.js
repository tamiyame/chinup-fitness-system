// 線上單堂方案 API：預約落地成方案、後台動作限制、付款／取消／退款後的 single、週曆來源、補登過去日期、summary。
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
console.log('[online-single-api test] start');

const clean = () => db.exec(`
  DELETE FROM notifications WHERE user_id IN (SELECT id FROM users WHERE email LIKE 'osa-%' OR phone LIKE '0969%');
  DELETE FROM bookings WHERE member_id IN (SELECT id FROM users WHERE phone LIKE '0969%' OR email LIKE 'osa-%');
  DELETE FROM bookings WHERE coach_id IN (SELECT id FROM coaches WHERE user_id IN (SELECT id FROM users WHERE email LIKE 'osa-%'));
  DELETE FROM customer_packages WHERE member_id IN (SELECT id FROM users WHERE phone LIKE '0969%' OR email LIKE 'osa-%');
  DELETE FROM coaches WHERE user_id IN (SELECT id FROM users WHERE email LIKE 'osa-%');
  DELETE FROM users WHERE email LIKE 'osa-%' OR phone LIKE '0969%';
`);
clean();
const uid = Number(db.prepare("INSERT INTO users (name,email,role) VALUES ('OSA Coach','osa-c@x.com','coach')").run().lastInsertRowid);
const coachId = Number(db.prepare("INSERT INTO coaches (user_id, display_name, is_active) VALUES (?, 'OSA', 1)").run(uid).lastInsertRowid);
const fut = new Date(Date.now() + 4*86400000), past = new Date(Date.now() - 7*86400000);
addRule({ coachId, dayOfWeek: fut.getDay(), startTime: '09:00', endTime: '18:00', effectiveFrom: '2000-01-01' });
addRule({ coachId, dayOfWeek: past.getDay(), startTime: '09:00', endTime: '18:00', effectiveFrom: '2000-01-01' });
const futDate = fmtDate(fut), pastDate = fmtDate(past);

const login = await req('POST', '/api/auth/login', { body: { email: 'admin@chinup.local', password: 'admin1234' } });
const token = login.data?.token;
expect('admin login ok', () => assert.ok(token));

const pkgs = async (memberId) => (await req('GET', `/api/coach/packages?memberId=${memberId}&includeArchived=1`, { token })).data;

// 1. 預約 → 線上單堂方案
const bk = await req('POST', '/api/public/bookings', { body: { coachId, startAt: `${futDate}T10:00:00`, name: '單堂客', phone: '0969000001' } });
expect('預約 201', () => assert.equal(bk.status, 201));
const bid = bk.data?.id;
const memberId = db.prepare('SELECT member_id FROM bookings WHERE id = ?').get(bid).member_id;
let list = await pkgs(memberId);
const pid = list[0]?.id;
expect('方案清單一筆：source online、single 已預約・待核對', () => {
  assert.equal(list.length, 1);
  assert.equal(list[0].source, 'online');
  assert.equal(list[0].single.state, 'booked');
  assert.equal(list[0].single.pay_status, 'pending');
});

// 2. 後台限制
const adj = await req('PATCH', `/api/coach/packages/${pid}`, { token, body: { remaining: 1 } });
expect('調整堂數 → 409 online_single_readonly', () => { assert.equal(adj.status, 409); assert.equal(adj.data.error, 'online_single_readonly'); });
const rst = await req('POST', `/api/coach/packages/${pid}/restore`, { token });
expect('還原 → 409 online_single_readonly', () => { assert.equal(rst.status, 409); assert.equal(rst.data.error, 'online_single_readonly'); });
const arc = await req('POST', `/api/coach/packages/${pid}/archive`, { token });
expect('作廢有預約的 → 409 has_active_booking', () => { assert.equal(arc.status, 409); assert.equal(arc.data.error, 'has_active_booking'); });

// 3. 核對
await req('POST', `/api/admin/bookings/${bid}/confirm-payment`, { token });
list = await pkgs(memberId);
expect('核對後 pay_status paid、可退款的是這筆', () => {
  assert.equal(list[0].single.pay_status, 'paid');
  assert.equal(list[0].single.refundable_booking_id, bid);
});

// 4. 取消 → 保留 1 堂
await req('POST', `/api/admin/bookings/${bid}/cancel`, { token });
list = await pkgs(memberId);
expect('取消後 credit、剩 1 堂', () => {
  assert.equal(list[0].single.state, 'credit');
  assert.equal(list[0].remaining_sessions, 1);
});

// 5. 退款
const rf = await req('POST', `/api/admin/bookings/${bid}/refund`, { token });
expect('退款 200', () => assert.equal(rf.status, 200));
list = await pkgs(memberId);
expect('退款後 已取消・已退款', () => {
  assert.equal(list[0].single.state, 'cancelled');
  assert.equal(list[0].single.pay_status, 'refunded');
});
const rf2 = await req('POST', `/api/admin/bookings/${bid}/refund`, { token });
expect('再退一次 → 409 already_refunded', () => { assert.equal(rf2.status, 409); assert.equal(rf2.data.error, 'already_refunded'); });

// 6. 週曆帶來源
const bk2 = await req('POST', '/api/public/bookings', { body: { coachId, startAt: `${futDate}T11:00:00`, name: '單堂客二', phone: '0969000002' } });
const wk = await req('GET', `/api/coach/week?all=1&start=${futDate}`, { token });
expect('週曆：線上預約帶 pkg_source online', () => {
  assert.equal(bk2.status, 201);
  const hit = wk.data.bookings.find(b => b.id === bk2.data.id);
  assert.ok(hit); assert.equal(hit.pkg_source, 'online');
});

// 7. 管理者補登過去日期 → 也有方案
const bk3 = await req('POST', '/api/public/bookings', { token, body: { coachId, startAt: `${pastDate}T10:00:00`, name: '補登客', phone: '0969000003' } });
expect('補登過去預約 201、package_id 不是 NULL', () => {
  assert.equal(bk3.status, 201);
  assert.notEqual(db.prepare('SELECT package_id FROM bookings WHERE id = ?').get(bk3.data.id).package_id, null);
});

// 8. summary
const sm = await req('GET', '/api/admin/packages/summary', { token });
expect('summary 200、三個數字、帶補登失敗原因欄位', () => {
  assert.equal(sm.status, 200);
  for (const v of [sm.data.packages.online, sm.data.packages.staff, sm.data.confirmedWithoutPackage]) assert.equal(typeof v, 'number');
  assert.ok('backfillError' in sm.data); assert.equal(typeof sm.data.backfillError, 'object');   // null 或 { at, reason, ... }
});
const smAnon = await req('GET', '/api/admin/packages/summary');
expect('summary 無 token → 401 或 403', () => assert.ok([401, 403].includes(smAnon.status)));

clean();
console.log('[online-single-api test] done');
