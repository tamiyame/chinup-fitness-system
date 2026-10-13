// API：一對二同行客人 — 公開預約帶同行、只填其一 400、我的課表雙身分、同行取消、教練設定同行端點。
// 需先起 server：LINE_MOCK=1 GCAL_MOCK=1 GMAIL_MOCK=1 PORT=3456 node src/server.js；BASE=http://localhost:3456
import assert from 'node:assert/strict';
import { db } from '../src/db/connection.js';
import { hashPassword } from '../src/services/auth.js';
import { addRule } from '../src/services/availabilityService.js';
const BASE = process.env.BASE || 'http://localhost:3000';
async function req(method, path, { body, token } = {}) {
  const headers = { 'Content-Type': 'application/json', 'X-Forwarded-For': '10.99.8.1' };
  if (token) headers['Authorization'] = `Bearer ${token}`;
  const res = await fetch(BASE + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text(); let data; try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  return { status: res.status, data };
}
function expect(label, fn){ try{fn();console.log(`  ✓ ${label}`);}catch(e){console.log(`  ✗ ${label}`);console.error(e);process.exitCode=1;} }
console.log('[booking-companion-api test] start');
const clean = () => db.exec("DELETE FROM notifications WHERE user_id IN (SELECT id FROM users WHERE phone LIKE '0986%' OR email LIKE 'bca-%'); DELETE FROM bookings WHERE member_id IN (SELECT id FROM users WHERE phone LIKE '0986%') OR member2_id IN (SELECT id FROM users WHERE phone LIKE '0986%'); DELETE FROM customer_packages WHERE member_id IN (SELECT id FROM users WHERE phone LIKE '0986%'); DELETE FROM coaches WHERE user_id IN (SELECT id FROM users WHERE email LIKE 'bca-%'); DELETE FROM users WHERE phone LIKE '0986%' OR email LIKE 'bca-%'");
clean();
const PW = hashPassword('bcapw1234');
const cuid = Number(db.prepare("INSERT INTO users (name,email,role,is_admin,password_hash) VALUES ('BCA教練','bca-c@x.com','coach',0,?)").run(PW).lastInsertRowid);
const coachId = Number(db.prepare("INSERT INTO coaches (user_id, display_name, is_active) VALUES (?, 'BCA', 1)").run(cuid).lastInsertRowid);
const pad = n => String(n).padStart(2,'0');
const d = new Date(Date.now() + 6*86400000);
const date = `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}`;
addRule({ coachId, dayOfWeek: d.getDay(), startTime: '09:00', endTime: '18:00' });
const coachLogin = await req('POST', '/api/auth/login', { body: { email: 'bca-c@x.com', password: 'bcapw1234' } });
const coachToken = coachLogin.data?.token;
expect('前置：教練 token', () => assert.equal(coachLogin.status, 200));

try {
  const half = await req('POST', '/api/public/bookings', { body: { coachId, startAt: `${date}T10:00:00`, name: '主客', phone: '0986000001', sessionType: '1on2', companionName: '同行' } });
  expect('只填同行姓名 → 400 invalid_companion', () => { assert.equal(half.status, 400); assert.equal(half.data?.error, 'invalid_companion'); });
  const not2 = await req('POST', '/api/public/bookings', { body: { coachId, startAt: `${date}T10:00:00`, name: '主客', phone: '0986000001', sessionType: '1on1', companionName: '同行', companionPhone: '0986000002' } });
  expect('1on1 帶同行 → 400 companion_not_allowed', () => { assert.equal(not2.status, 400); assert.equal(not2.data?.error, 'companion_not_allowed'); });
  const ok = await req('POST', '/api/public/bookings', { body: { coachId, startAt: `${date}T10:00:00`, name: '主客', phone: '0986000001', sessionType: '1on2', companionName: '同行', companionPhone: '0986000002' } });
  expect('1on2 帶同行 → 201、回 companionName', () => { assert.equal(ok.status, 201); assert.equal(ok.data?.companionName, '同行'); });
  const bid = ok.data?.id;
  const myMate = await req('POST', '/api/public/my', { body: { phone: '0986000002', name: '同行' } });
  expect('同行查我的課表 → 該筆 is_companion=true、companion_name=主客', () => {
    assert.equal(myMate.status, 200);
    const it = (myMate.data.items || []).find((x) => x.kind === 'booking' && x.id === bid);
    assert.ok(it); assert.equal(it.is_companion, true); assert.equal(it.companion_name, '主客');
  });
  const myMain = await req('POST', '/api/public/my', { body: { phone: '0986000001', name: '主客' } });
  expect('主客查我的課表 → companion_name=同行', () => {
    const it = (myMain.data.items || []).find((x) => x.kind === 'booking' && x.id === bid);
    assert.ok(it); assert.equal(it.is_companion, false); assert.equal(it.companion_name, '同行');
  });
  const del = await req('DELETE', `/api/public/bookings/${bid}`, { body: { phone: '0986000002', name: '同行' } });
  expect('同行取消 → 200 ok', () => { assert.equal(del.status, 200); assert.equal(del.data?.ok, true); });

  // 教練端：先建一筆 1on2（無同行），再用端點設定／清除
  const ok2 = await req('POST', '/api/public/bookings', { body: { coachId, startAt: `${date}T11:00:00`, name: '主客', phone: '0986000001', sessionType: '1on2' } });
  const bid2 = ok2.data?.id;
  const mateId = Number(db.prepare("SELECT id FROM users WHERE phone='0986000002'").get().id);
  const set = await req('PATCH', `/api/coach/bookings/${bid2}/companion`, { token: coachToken, body: { companionId: mateId } });
  expect('PATCH companion 設定 → 200、companionName', () => { assert.equal(set.status, 200); assert.equal(set.data?.companionId, mateId); assert.equal(set.data?.companionName, '同行'); });
  const clr = await req('PATCH', `/api/coach/bookings/${bid2}/companion`, { token: coachToken, body: { companionId: null } });
  expect('PATCH companion 清除 → 200、companionId null', () => { assert.equal(clr.status, 200); assert.equal(clr.data?.companionId, null); });
  const noauth = await req('PATCH', `/api/coach/bookings/${bid2}/companion`, { body: { companionId: mateId } });
  expect('PATCH companion 未登入 → 401', () => assert.equal(noauth.status, 401));
  const ok3 = await req('POST', '/api/public/bookings', { body: { coachId, startAt: `${date}T12:00:00`, name: '主客', phone: '0986000001', sessionType: '1on1' } });
  const bad = await req('PATCH', `/api/coach/bookings/${ok3.data?.id}/companion`, { token: coachToken, body: { companionId: mateId } });
  expect('對 1on1 設定同行 → 400 companion_not_allowed', () => { assert.equal(bad.status, 400); assert.equal(bad.data?.error, 'companion_not_allowed'); });
} finally {
  clean();
}
console.log('[booking-companion-api test] done');
