// 薪資設定四鍵：GET 預設值、PATCH 驗證與寫入、寫後還原。
import assert from 'node:assert/strict';
const BASE = process.env.BASE || 'http://localhost:3000';
async function req(method, path, { body, token } = {}) {
  // 獨立假 IP：避免整條 test:api 鏈共用預設 IP 撞 login 限流（比照 rate-limit.test.js 慣例）
  const headers = { 'Content-Type': 'application/json', 'X-Forwarded-For': '10.99.2.1' };
  if (token) headers['Authorization'] = `Bearer ${token}`;
  const res = await fetch(BASE + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text(); let data; try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  return { status: res.status, data };
}
function expect(label, fn){ try{fn();console.log(`  ✓ ${label}`);}catch(e){console.log(`  ✗ ${label}`);console.error(e);process.exitCode=1;} }
console.log('[payroll-settings-api test] start');
const login = await req('POST', '/api/auth/login', { body: { email: 'admin@chinup.local', password: 'admin1234' } });
const token = login.data?.token;

const g0 = await req('GET', '/api/admin/settings', { token });
expect('GET 含四個 payroll 鍵（預設 40/50/60/50）', () => {
  assert.equal(g0.status, 200);
  assert.equal(typeof g0.data.payroll_tier_threshold, 'number');
  assert.equal(typeof g0.data.payroll_pct_low, 'number');
  assert.equal(typeof g0.data.payroll_pct_high, 'number');
  assert.equal(typeof g0.data.payroll_group_pct, 'number');
});
const orig = { payroll_tier_threshold: g0.data.payroll_tier_threshold, payroll_pct_low: g0.data.payroll_pct_low,
  payroll_pct_high: g0.data.payroll_pct_high, payroll_group_pct: g0.data.payroll_group_pct };

const p1 = await req('PATCH', '/api/admin/settings', { token,
  body: { payroll_tier_threshold: 30, payroll_pct_low: 45, payroll_pct_high: 65, payroll_group_pct: 55 } });
expect('PATCH 四鍵寫入成功', () => {
  assert.equal(p1.status, 200);
  assert.equal(p1.data.payroll_tier_threshold, 30);
  assert.equal(p1.data.payroll_pct_low, 45);
  assert.equal(p1.data.payroll_pct_high, 65);
  assert.equal(p1.data.payroll_group_pct, 55);
});
for (const [k, bad] of [['payroll_tier_threshold', 1000], ['payroll_pct_low', -1], ['payroll_pct_high', 101], ['payroll_group_pct', 'x']]) {
  const r = await req('PATCH', '/api/admin/settings', { token, body: { [k]: bad } });
  expect(`${k}=${bad} → 400`, () => assert.equal(r.status, 400));
}
const noTok = await req('PATCH', '/api/admin/settings', { body: { payroll_pct_low: 10 } });
expect('未登入 PATCH → 401', () => assert.equal(noTok.status, 401));
await req('PATCH', '/api/admin/settings', { token, body: orig }); // 還原
console.log('[payroll-settings-api test] done');
