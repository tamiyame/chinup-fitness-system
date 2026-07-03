// 薪資 API：權限、period 驗證、回傳形狀。
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
console.log('[payroll-api test] start');
const login = await req('POST', '/api/auth/login', { body: { email: 'admin@chinup.local', password: 'admin1234' } });
const token = login.data?.token;

const noTok = await req('GET', '/api/admin/payroll');
expect('未登入 → 401', () => assert.equal(noTok.status, 401));

const bad = await req('GET', '/api/admin/payroll?period=2026-13', { token });
expect('period 格式不合 → 400 invalid_period', () => {
  assert.equal(bad.status, 400);
  assert.equal(bad.data.error, 'invalid_period');
});

const r0 = await req('GET', '/api/admin/payroll', { token });
expect('缺省 period → 200，回預設期與完整形狀', () => {
  assert.equal(r0.status, 200);
  assert.match(r0.data.period, /^\d{4}-\d{2}$/);
  assert.ok(r0.data.range?.start && r0.data.range?.end);
  for (const k of ['threshold', 'pctLow', 'pctHigh', 'groupPct']) assert.equal(typeof r0.data.settings[k], 'number');
  assert.ok(Array.isArray(r0.data.coaches));
  assert.equal(typeof r0.data.totals.total, 'number');
});

const r1 = await req('GET', '/api/admin/payroll?period=2031-02', { token });
expect('指定 period → 200 且 range 正確', () => {
  assert.equal(r1.status, 200);
  assert.equal(r1.data.period, '2031-02');
  assert.equal(r1.data.range.start, '2031-01-06');
  assert.equal(r1.data.range.end, '2031-02-05');
});
expect('coaches 元素形狀（若有教練）', () => {
  const c = r0.data.coaches[0];
  if (!c) return; // 空庫允許
  assert.ok('coachId' in c && 'displayName' in c && 'total' in c);
  assert.ok(Array.isArray(c.oneOnOne.details) && Array.isArray(c.group.details));
});
console.log('[payroll-api test] done');
