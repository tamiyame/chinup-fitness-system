// 時段＋指派 API：權限/CRUD/指派/錯誤碼。server 需帶 LINE_MOCK=1 GCAL_MOCK=1 GMAIL_MOCK=1 GOOGLE_CLIENT_ID=test-client-id。
import assert from 'node:assert/strict';
import { db } from '../src/db/connection.js';
import { hashPassword } from '../src/services/auth.js';
const BASE = process.env.BASE || 'http://localhost:3000';
async function req(method, path, { body, token } = {}) {
  const headers = { 'Content-Type': 'application/json', 'X-Forwarded-For': '10.99.7.3' };
  if (token) headers['Authorization'] = `Bearer ${token}`;
  const res = await fetch(BASE + path, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
  const text = await res.text(); let data; try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  return { status: res.status, data };
}
function expect(label, fn){ try{fn();console.log(`  ✓ ${label}`);}catch(e){console.log(`  ✗ ${label}`);console.error(e);process.exitCode=1;} }
console.log('[slot-admin-api test] start');

db.exec(`
  DELETE FROM shift_attendance WHERE coach_id IN (SELECT id FROM coaches WHERE user_id IN (SELECT id FROM users WHERE email LIKE 'sla-%'));
  DELETE FROM coach_shifts WHERE coach_id IN (SELECT id FROM coaches WHERE user_id IN (SELECT id FROM users WHERE email LIKE 'sla-%'));
  DELETE FROM gym_slots WHERE effective_from LIKE '2033-%';   -- 只掃本測試年份，勿全域掃孤兒時段（無教練時段是合法狀態）
  DELETE FROM auth_sessions WHERE user_id IN (SELECT id FROM users WHERE email LIKE 'sla-%');
  DELETE FROM coaches WHERE user_id IN (SELECT id FROM users WHERE email LIKE 'sla-%');
  DELETE FROM users WHERE email LIKE 'sla-%';
`);
const cUid = Number(db.prepare("INSERT INTO users (name,email,role,password_hash) VALUES ('SLA教練','sla-c@x.com','coach',?)").run(hashPassword('slapass123')).lastInsertRowid);
const cId = Number(db.prepare("INSERT INTO coaches (user_id, display_name, is_active) VALUES (?, 'SLA-C', 1)").run(cUid).lastInsertRowid);

const admin = (await req('POST', '/api/auth/login', { body: { email: 'admin@chinup.local', password: 'admin1234' } })).data?.token;
const coach = (await req('POST', '/api/auth/login', { body: { email: 'sla-c@x.com', password: 'slapass123' } })).data?.token;
expect('登入成功', () => { assert.ok(admin); assert.ok(coach); });

{
  const r = await req('POST', '/api/admin/slots', { token: coach, body: { day_of_week: 2, start_time: '09:00', end_time: '11:00', effective_from: '2033-03-01' } });
  expect('非管理者 → 403', () => assert.equal(r.status, 403));
}
let slotId;
{
  const r = await req('POST', '/api/admin/slots', { token: admin, body: { day_of_week: 2, start_time: '09:00', end_time: '11:00', effective_from: '2033-03-01' } });
  expect('新增時段 → 200 完整列', () => { assert.equal(r.status, 200); assert.equal(r.data.day_of_week, 2); slotId = r.data.id; });
  const bad = await req('POST', '/api/admin/slots', { token: admin, body: { day_of_week: 2, start_time: '11:00', end_time: '09:00', effective_from: '2033-03-01' } });
  expect('起訖顛倒 → 400 invalid_time_range', () => assert.equal(bad.data.error, 'invalid_time_range'));
}
{
  const ghost = await req('POST', `/api/admin/slots/${slotId}/coaches`, { token: admin, body: { coach_id: 999999 } });
  expect('教練不存在 → 404 coach_not_found', () => assert.equal(ghost.data.error, 'coach_not_found'));
  const ok = await req('POST', `/api/admin/slots/${slotId}/coaches`, { token: admin, body: { coach_id: cId } });
  expect('指派 → 200 展開列（slot_id/參數複製）', () => {
    assert.equal(ok.status, 200); assert.equal(ok.data.slot_id, slotId);
    assert.equal(ok.data.coach_id, cId); assert.equal(ok.data.start_time, '09:00');
  });
  const dup = await req('POST', `/api/admin/slots/${slotId}/coaches`, { token: admin, body: { coach_id: cId } });
  expect('重複指派 → 409 coach_already_in_slot', () => assert.equal(dup.data.error, 'coach_already_in_slot'));
  const list = await req('GET', '/api/admin/slots', { token: admin });
  expect('列表內嵌教練', () => {
    const mine = list.data.find((s) => s.id === slotId);
    assert.deepEqual(mine.coaches.map((c) => c.coachId), [cId]);
  });
}
{
  const patch = await req('PATCH', `/api/admin/slots/${slotId}`, { token: admin, body: { start_time: '10:00', end_time: '12:00', effective_to: '2033-06-30' } });
  expect('PATCH 連動 → 200，教練列同步', () => {
    assert.equal(patch.data.start_time, '10:00'); assert.equal(patch.data.effective_to, '2033-06-30');
    const row = db.prepare('SELECT * FROM coach_shifts WHERE slot_id = ? AND coach_id = ?').get(slotId, cId);
    assert.equal(row.start_time, '10:00'); assert.equal(row.effective_to, '2033-06-30');
  });
  const clear = await req('PATCH', `/api/admin/slots/${slotId}`, { token: admin, body: { effective_to: null } });
  expect('effective_to null 清空', () => assert.equal(clear.data.effective_to, null));
}
{
  const un = await req('DELETE', `/api/admin/slots/${slotId}/coaches/${cId}`, { token: admin });
  expect('移除指派 → 200 ok', () => assert.deepEqual(un.data, { ok: true }));
  const un2 = await req('DELETE', `/api/admin/slots/${slotId}/coaches/${cId}`, { token: admin });
  expect('再移除 → 404 coach_not_in_slot', () => assert.equal(un2.data.error, 'coach_not_in_slot'));
  const del = await req('DELETE', `/api/admin/slots/${slotId}`, { token: admin });
  expect('刪除時段 → 200 ok', () => assert.deepEqual(del.data, { ok: true }));
  const del2 = await req('DELETE', `/api/admin/slots/${slotId}`, { token: admin });
  expect('再刪 → 404 slot_not_found', () => assert.equal(del2.data.error, 'slot_not_found'));
}
console.log('[slot-admin-api test] done');
