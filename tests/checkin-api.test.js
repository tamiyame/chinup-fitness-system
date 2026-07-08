// 打卡 API：權限/未設定/距離/窗口/冪等/註銷/代選免疫。server 需帶 LINE_MOCK=1 GCAL_MOCK=1 GMAIL_MOCK=1。
import assert from 'node:assert/strict';
import { db } from '../src/db/connection.js';
import { hashPassword } from '../src/services/auth.js';
const BASE = process.env.BASE || 'http://localhost:3000';
async function req(method, path, { body, token } = {}) {
  const headers = { 'Content-Type': 'application/json', 'X-Forwarded-For': '10.99.7.1' };
  if (token) headers['Authorization'] = `Bearer ${token}`;
  const res = await fetch(BASE + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text(); let data; try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  return { status: res.status, data };
}
function expect(label, fn){ try{fn();console.log(`  ✓ ${label}`);}catch(e){console.log(`  ✗ ${label}`);console.error(e);process.exitCode=1;} }
console.log('[checkin-api test] start');

// ── 清理與資料 ──
db.exec(`
  DELETE FROM shift_attendance WHERE coach_id IN (SELECT id FROM coaches WHERE user_id IN (SELECT id FROM users WHERE email LIKE 'ckn-%'));
  DELETE FROM coach_shifts WHERE coach_id IN (SELECT id FROM coaches WHERE user_id IN (SELECT id FROM users WHERE email LIKE 'ckn-%'));
  DELETE FROM auth_sessions WHERE user_id IN (SELECT id FROM users WHERE email LIKE 'ckn-%');
  DELETE FROM coaches WHERE user_id IN (SELECT id FROM users WHERE email LIKE 'ckn-%');
  DELETE FROM users WHERE email LIKE 'ckn-%';
  DELETE FROM app_settings WHERE key LIKE 'checkin_%';
`);
const GYM = { lat: 25.0330, lng: 121.5654 };
const cUid = Number(db.prepare("INSERT INTO users (name,email,role,password_hash) VALUES ('CKN教練','ckn-c@x.com','coach',?)").run(hashPassword('cknpass123')).lastInsertRowid);
const cId = Number(db.prepare("INSERT INTO coaches (user_id, display_name, is_active) VALUES (?, 'CKN-C', 1)").run(cUid).lastInsertRowid);
const dUid = Number(db.prepare("INSERT INTO users (name,email,role,password_hash) VALUES ('CKN無班','ckn-d@x.com','coach',?)").run(hashPassword('cknpass123')).lastInsertRowid);
db.prepare("INSERT INTO coaches (user_id, display_name, is_active) VALUES (?, 'CKN-D', 1)").run(dUid);
const uUid = Number(db.prepare("INSERT INTO users (name,email,role) VALUES ('CKN會員','ckn-u@x.com','user')").run().lastInsertRowid);
// 給 C 一條涵蓋「現在」的全日班表（測試與 server 同機同時區，牆鐘一致）
const now = new Date();
db.prepare("INSERT INTO coach_shifts (coach_id, day_of_week, start_time, end_time, effective_from) VALUES (?, ?, '00:00', '23:59', '2000-01-01')")
  .run(cId, now.getDay());

const tokC = (await req('POST', '/api/auth/login', { body: { email: 'ckn-c@x.com', password: 'cknpass123' } })).data?.token;
const tokD = (await req('POST', '/api/auth/login', { body: { email: 'ckn-d@x.com', password: 'cknpass123' } })).data?.token;
// role=user 依角色模型不能密碼登入（auth.js login() 擋 user_login_disabled）——
// 比照 package-unit-price-api.test.js 慣例直接種 auth_sessions，取得會員 token 測 403 守門。
const tokU = 'ckn-user-token-1';
db.prepare("INSERT OR REPLACE INTO auth_sessions (token, user_id, expires_at) VALUES (?, ?, '2099-01-01T00:00:00')").run(tokU, uUid);
expect('三帳號 token 齊備（C/D 登入、U 種 session）', () => { assert.ok(tokC); assert.ok(tokD); assert.ok(tokU); });

{
  const a = await req('POST', '/api/coach/checkin', { body: GYM });
  expect('未登入 POST → 401', () => assert.equal(a.status, 401));
  const b = await req('POST', '/api/coach/checkin', { body: GYM, token: tokU });
  expect('role=user POST → 403 coach_only', () => { assert.equal(b.status, 403); assert.equal(b.data.error, 'coach_only'); });
  const c = await req('GET', '/api/coach/checkin/today', { token: tokU });
  expect('role=user GET → 403', () => assert.equal(c.status, 403));
}
{
  const r = await req('POST', '/api/coach/checkin', { body: GYM, token: tokC });
  expect('座標未設定 → 503 checkin_not_configured', () => { assert.equal(r.status, 503); assert.equal(r.data.error, 'checkin_not_configured'); });
}
db.prepare("INSERT OR REPLACE INTO app_settings (key, value) VALUES ('checkin_lat', ?), ('checkin_lng', ?)").run(String(GYM.lat), String(GYM.lng));
{
  const far = await req('POST', '/api/coach/checkin', { body: { lat: 25.0478, lng: 121.5170 }, token: tokC });
  expect('距離超出 → 403 not_at_gym + detail.distance_m', () => {
    assert.equal(far.status, 403); assert.equal(far.data.error, 'not_at_gym'); assert.ok(far.data.detail.distance_m > 1000);
  });
  const bad = await req('POST', '/api/coach/checkin', { body: {}, token: tokC });
  expect('缺座標 → 400 missing_location', () => assert.equal(bad.data.error, 'missing_location'));
  const ok = await req('POST', '/api/coach/checkin', { body: { ...GYM, accuracy: 12.5 }, token: tokC });
  expect('成功打卡 → 200，attendance 快照齊全', () => {
    assert.equal(ok.status, 200); assert.equal(ok.data.already, false);
    assert.equal(ok.data.attendance.source, 'checkin');
    assert.equal(ok.data.attendance.start_time, '00:00');
    assert.equal(ok.data.attendance.distance_m, 0);
  });
  const dup = await req('POST', '/api/coach/checkin', { body: GYM, token: tokC });
  expect('重複打卡 → 200 already=true 冪等', () => { assert.equal(dup.status, 200); assert.equal(dup.data.already, true); });
  db.prepare('UPDATE shift_attendance SET voided_at = ?, voided_by = ? WHERE id = ?')
    .run('2026-01-01T00:00:00', 1, ok.data.attendance.id);
  const voided = await req('POST', '/api/coach/checkin', { body: GYM, token: tokC });
  expect('已註銷再打 → 409 attendance_voided', () => { assert.equal(voided.status, 409); assert.equal(voided.data.error, 'attendance_voided'); });
  const noShift = await req('POST', '/api/coach/checkin', { body: GYM, token: tokD });
  expect('無班表教練 → 409 no_active_shift', () => { assert.equal(noShift.status, 409); assert.equal(noShift.data.error, 'no_active_shift'); });
}
{
  const t = await req('GET', '/api/coach/checkin/today', { token: tokC });
  expect('today 形狀：date/slots/extras/period/periodHours', () => {
    assert.equal(t.status, 200);
    assert.match(t.data.date, /^\d{4}-\d{2}-\d{2}$/);
    assert.ok(Array.isArray(t.data.slots) && Array.isArray(t.data.extras));
    assert.match(t.data.period, /^\d{4}-\d{2}$/);
    assert.equal(typeof t.data.periodHours, 'number');
    assert.equal(t.data.slots[0].status, 'voided');
  });
  const im = await req('GET', `/api/coach/checkin/today?coachId=${cId}`, { token: tokD });
  expect('coachId query 無效——永遠回本人（D 無班表 slots 空）', () => {
    assert.equal(im.status, 200); assert.equal(im.data.slots.length, 0);
  });
}
console.log('[checkin-api test] done');
