// settings 新 key：gcal_calendar_id / booking_hourly_capacity 驗證與寫入。
import assert from 'node:assert/strict';
const BASE = process.env.BASE || 'http://localhost:3000';
async function req(method, path, { body, token } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers['Authorization'] = `Bearer ${token}`;
  const res = await fetch(BASE + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text(); let data; try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  return { status: res.status, data };
}
function expect(label, fn){ try{fn();console.log(`  ✓ ${label}`);}catch(e){console.log(`  ✗ ${label}`);console.error(e);process.exitCode=1;} }
console.log('[settings-gcal-api test] start');
const login = await req('POST', '/api/auth/login', { body: { email: 'admin@chinup.local', password: 'admin1234' } });
const token = login.data?.token;

const g0 = await req('GET', '/api/admin/settings', { token });
expect('GET 含 gcal_calendar_id 與 booking_hourly_capacity', () => {
  assert.equal(g0.status, 200);
  assert.ok('gcal_calendar_id' in g0.data);
  assert.ok('booking_hourly_capacity' in g0.data);
});
const p1 = await req('PATCH', '/api/admin/settings', { token, body: { gcal_calendar_id: 'abc@group.calendar.google.com', booking_hourly_capacity: 4 } });
expect('PATCH 寫入成功', () => {
  assert.equal(p1.status, 200);
  assert.equal(p1.data.gcal_calendar_id, 'abc@group.calendar.google.com');
  assert.equal(p1.data.booking_hourly_capacity, 4);
});
const pBad = await req('PATCH', '/api/admin/settings', { token, body: { booking_hourly_capacity: 0 } });
expect('容量 0 → 400', () => assert.equal(pBad.status, 400));
// 還原（避免影響其他測試/環境）
await req('PATCH', '/api/admin/settings', { token, body: { gcal_calendar_id: '', booking_hourly_capacity: 3 } });
console.log('[settings-gcal-api test] done');
