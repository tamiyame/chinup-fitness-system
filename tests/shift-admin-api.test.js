// 駐場後台 API：班表 CRUD/時薪/補登/註銷/settings 驗證/權限。server 需帶 LINE_MOCK=1 GCAL_MOCK=1 GMAIL_MOCK=1。
import assert from 'node:assert/strict';
import { db } from '../src/db/connection.js';
import { hashPassword } from '../src/services/auth.js';
const BASE = process.env.BASE || 'http://localhost:3000';
async function req(method, path, { body, token } = {}) {
  const headers = { 'Content-Type': 'application/json', 'X-Forwarded-For': '10.99.7.2' };
  if (token) headers['Authorization'] = `Bearer ${token}`;
  const res = await fetch(BASE + path, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
  const text = await res.text(); let data; try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  return { status: res.status, data };
}
function expect(label, fn){ try{fn();console.log(`  ✓ ${label}`);}catch(e){console.log(`  ✗ ${label}`);console.error(e);process.exitCode=1;} }
console.log('[shift-admin-api test] start');

db.exec(`
  DELETE FROM shift_attendance WHERE coach_id IN (SELECT id FROM coaches WHERE user_id IN (SELECT id FROM users WHERE email LIKE 'sha-%'));
  DELETE FROM coach_shifts WHERE coach_id IN (SELECT id FROM coaches WHERE user_id IN (SELECT id FROM users WHERE email LIKE 'sha-%'));
  DELETE FROM auth_sessions WHERE user_id IN (SELECT id FROM users WHERE email LIKE 'sha-%');
  DELETE FROM coaches WHERE user_id IN (SELECT id FROM users WHERE email LIKE 'sha-%');
  DELETE FROM users WHERE email LIKE 'sha-%';
`);
const cUid = Number(db.prepare("INSERT INTO users (name,email,role,password_hash) VALUES ('SHA教練','sha-c@x.com','coach',?)").run(hashPassword('shapass123')).lastInsertRowid);
const cId = Number(db.prepare("INSERT INTO coaches (user_id, display_name, is_active) VALUES (?, 'SHA-C', 1)").run(cUid).lastInsertRowid);

const admin = (await req('POST', '/api/auth/login', { body: { email: 'admin@chinup.local', password: 'admin1234' } })).data?.token;
const coach = (await req('POST', '/api/auth/login', { body: { email: 'sha-c@x.com', password: 'shapass123' } })).data?.token;
expect('登入成功', () => { assert.ok(admin); assert.ok(coach); });

// ── 權限 ──
{
  const r = await req('POST', '/api/admin/shifts', { token: coach, body: { coach_id: cId, day_of_week: 3, start_time: '09:00', end_time: '11:00', effective_from: '2032-01-01' } });
  expect('非管理者 → 403', () => assert.equal(r.status, 403));
}
// ── 班表 CRUD ──
let shiftId;
{
  const r = await req('POST', '/api/admin/shifts', { token: admin, body: { coach_id: cId, day_of_week: 3, start_time: '09:00', end_time: '11:00', effective_from: '2032-01-01' } });
  expect('新增班表 → 200 完整列', () => { assert.equal(r.status, 200); assert.equal(r.data.day_of_week, 3); shiftId = r.data.id; });
  const bad = await req('POST', '/api/admin/shifts', { token: admin, body: { coach_id: cId, day_of_week: 3, start_time: '11:00', end_time: '09:00', effective_from: '2032-01-01' } });
  expect('起訖顛倒 → 400 invalid_time_range', () => { assert.equal(bad.status, 400); assert.equal(bad.data.error, 'invalid_time_range'); });
  const ghost = await req('POST', '/api/admin/shifts', { token: admin, body: { coach_id: 999999, day_of_week: 3, start_time: '09:00', end_time: '11:00', effective_from: '2032-01-01' } });
  expect('coach 不存在 → 404 coach_not_found', () => assert.equal(ghost.data.error, 'coach_not_found'));
  const list = await req('GET', `/api/admin/shifts?coachId=${cId}`, { token: admin });
  expect('列表含新列', () => { assert.equal(list.status, 200); assert.ok(list.data.some((s) => s.id === shiftId)); });
  const patch = await req('PATCH', `/api/admin/shifts/${shiftId}`, { token: admin, body: { effective_to: '2032-06-30' } });
  expect('PATCH 結束日 → 200', () => assert.equal(patch.data.effective_to, '2032-06-30'));
  const clear = await req('PATCH', `/api/admin/shifts/${shiftId}`, { token: admin, body: { effective_to: null } });
  expect('PATCH effective_to null 清空', () => assert.equal(clear.data.effective_to, null));
}
// ── 時薪 ──
{
  const bad = await req('PATCH', `/api/admin/coaches/${cId}/hourly-rate`, { token: admin, body: { hourly_rate: 'abc' } });
  expect('非整數時薪 → 400 invalid_hourly_rate', () => assert.equal(bad.data.error, 'invalid_hourly_rate'));
  const ok = await req('PATCH', `/api/admin/coaches/${cId}/hourly-rate`, { token: admin, body: { hourly_rate: 480 } });
  expect('設時薪 480 → 200 回 coach 列', () => { assert.equal(ok.status, 200); assert.equal(ok.data.hourly_rate, 480); });
  const clear = await req('PATCH', `/api/admin/coaches/${cId}/hourly-rate`, { token: admin, body: { hourly_rate: null } });
  expect('時薪 null 清空', () => assert.equal(clear.data.hourly_rate, null));
  const coaches = await req('GET', '/api/admin/coaches', { token: admin });
  expect('GET /api/admin/coaches 每列含 hourly_rate 鍵', () => assert.ok(coaches.data.every((c) => 'hourly_rate' in c)));
}
// ── 補登 / 註銷 ──
let attId;
{
  const m = await req('POST', '/api/admin/attendance', { token: admin, body: { coach_id: cId, work_date: '2032-03-03', shift_id: shiftId, note: '補' } });
  expect('套班表補登 → 200 快照 09:00–11:00/2h', () => {
    assert.equal(m.status, 200); assert.equal(m.data.hours, 2); assert.equal(m.data.source, 'manual'); attId = m.data.id;
  });
  const dup = await req('POST', '/api/admin/attendance', { token: admin, body: { coach_id: cId, work_date: '2032-03-03', shift_id: shiftId } });
  expect('重複補登 → 409 duplicate_attendance', () => assert.equal(dup.data.error, 'duplicate_attendance'));
  const v = await req('POST', `/api/admin/attendance/${attId}/void`, { token: admin });
  expect('註銷 → 200 voided_at 有值', () => assert.ok(v.data.voided_at));
  const v2 = await req('POST', `/api/admin/attendance/${attId}/void`, { token: admin });
  expect('再註銷 → 409 already_voided', () => assert.equal(v2.data.error, 'already_voided'));
  const restore = await req('POST', '/api/admin/attendance', { token: admin, body: { coach_id: cId, work_date: '2032-03-03', shift_id: shiftId, note: '復原' } });
  expect('已註銷補登 → 復原同列', () => { assert.equal(restore.data.id, attId); assert.equal(restore.data.voided_at, null); });
  const custom = await req('POST', '/api/admin/attendance', { token: admin, body: { coach_id: cId, work_date: '2032-03-04', start_time: '18:00', end_time: '19:30' } });
  expect('自訂起訖補登 → 1.5h、shift_id null', () => { assert.equal(custom.data.hours, 1.5); assert.equal(custom.data.shift_id, null); });
}
// ── settings ──
{
  const bad = await req('PATCH', '/api/admin/settings', { token: admin, body: { checkin_lat: 999 } });
  expect('lat 999 → 400 invalid_checkin_lat', () => assert.equal(bad.data.error, 'invalid_checkin_lat'));
  const bad2 = await req('PATCH', '/api/admin/settings', { token: admin, body: { checkin_radius_m: 5 } });
  expect('radius 5 → 400 invalid_checkin_radius_m', () => assert.equal(bad2.data.error, 'invalid_checkin_radius_m'));
  const prev = (await req('GET', '/api/admin/settings', { token: admin })).data;
  const ok = await req('PATCH', '/api/admin/settings', { token: admin, body: { checkin_lat: 25.0330, checkin_lng: 121.5654, checkin_radius_m: 200, checkin_window_before_min: 20 } });
  expect('合法 checkin 參數 → payload 回填', () => {
    assert.equal(ok.data.checkin_lat, '25.033'); assert.equal(ok.data.checkin_radius_m, 200); assert.equal(ok.data.checkin_window_before_min, 20);
  });
  // 還原，避免影響其他 API 測試
  await req('PATCH', '/api/admin/settings', { token: admin, body: {
    checkin_lat: prev.checkin_lat === '' ? '' : Number(prev.checkin_lat),
    checkin_lng: prev.checkin_lng === '' ? '' : Number(prev.checkin_lng),
    checkin_radius_m: prev.checkin_radius_m, checkin_window_before_min: prev.checkin_window_before_min } });
}
// ── 班表刪除殿後（attendance FK SET NULL）──
{
  const del = await req('DELETE', `/api/admin/shifts/${shiftId}`, { token: admin });
  expect('刪除班表 → 200 ok', () => assert.deepEqual(del.data, { ok: true }));
  const gone = await req('DELETE', `/api/admin/shifts/${shiftId}`, { token: admin });
  expect('再刪 → 404 shift_not_found', () => assert.equal(gone.data.error, 'shift_not_found'));
}
console.log('[shift-admin-api test] done');
