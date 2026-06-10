// Gmail 授權路由：start 需 admin、回授權 URL；callback 壞 state → 400。
// 注意：測試 server 啟動時需帶 GOOGLE_CLIENT_ID=test-client-id（假值即可，
// start 只組授權 URL、不會真的打 Google），否則 start 會回 500 google_not_configured。
import assert from 'node:assert/strict';
const BASE = process.env.BASE || 'http://localhost:3000';
async function req(method, path, { body, token } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers['Authorization'] = `Bearer ${token}`;
  const res = await fetch(BASE + path, { method, headers, body: body ? JSON.stringify(body) : undefined, redirect: 'manual' });
  const text = await res.text(); let data; try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  return { status: res.status, data };
}
function expect(label, fn){ try{fn();console.log(`  ✓ ${label}`);}catch(e){console.log(`  ✗ ${label}`);console.error(e);process.exitCode=1;} }
console.log('[gmail-auth-api test] start');

const login = await req('POST', '/api/auth/login', { body: { email: 'admin@chinup.local', password: 'admin1234' } });
const token = login.data?.token;
expect('admin login ok', () => assert.ok(token));

const noAuth = await req('POST', '/api/admin/gmail-auth/start');
expect('未登入 start → 401', () => assert.equal(noAuth.status, 401));

const start = await req('POST', '/api/admin/gmail-auth/start', { token });
expect('start 回授權 URL（gmail.send + offline + consent）', () => {
  assert.equal(start.status, 200);
  assert.ok(String(start.data.url).includes('accounts.google.com'));
  assert.ok(String(start.data.url).includes(encodeURIComponent('https://www.googleapis.com/auth/gmail.send')));
  assert.ok(String(start.data.url).includes('access_type=offline'));
  assert.ok(String(start.data.url).includes('prompt=consent'));
});

const badCb = await req('GET', '/api/admin/gmail-auth/callback?code=x&state=bogus');
expect('callback 壞 state → 400', () => assert.equal(badCb.status, 400));
console.log('[gmail-auth-api test] done');
