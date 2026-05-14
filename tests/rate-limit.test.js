// HTTP API 測試：rate limiter 防 brute force。需要 running server。
// 用 X-Forwarded-For 設定獨立的假 IP，避免汙染其他 test file 的 bucket 狀態。
import assert from 'node:assert/strict';

const BASE = process.env.BASE || 'http://localhost:3000';

async function req(method, path, { body, headers = {} } = {}) {
  const h = { 'Content-Type': 'application/json', ...headers };
  const res = await fetch(BASE + path, { method, headers: h, body: body ? JSON.stringify(body) : undefined });
  const ct = res.headers.get('content-type') || '';
  if (ct.includes('application/json')) return { status: res.status, data: await res.json(), headers: res.headers };
  return { status: res.status, body: await res.text(), headers: res.headers };
}

function expect(label, fn) {
  try { fn(); console.log(`  ✓ ${label}`); }
  catch (e) { console.log(`  ✗ ${label}`); console.error(e); process.exitCode = 1; }
}

console.log('[rate-limit test] start');

const LOGIN_IP = '10.99.0.1';
const REGISTER_IP = '10.99.0.2';

console.log('[1] login: 30 attempts allowed within 15-min window, 31st rate-limited');
{
  let last;
  for (let i = 1; i <= 30; i++) {
    last = await req('POST', '/api/auth/login', {
      body: { email: 'nobody@example.com', password: 'wrong' },
      headers: { 'X-Forwarded-For': LOGIN_IP },
    });
  }
  expect('attempt #30 is 401 (still allowed, wrong creds)', () => assert.equal(last.status, 401));

  const overLimit = await req('POST', '/api/auth/login', {
    body: { email: 'nobody@example.com', password: 'wrong' },
    headers: { 'X-Forwarded-For': LOGIN_IP },
  });
  expect('attempt #31 is 429', () => assert.equal(overLimit.status, 429));
  expect('429 body has rate_limited error', () => assert.equal(overLimit.data.error, 'rate_limited'));
  expect('429 body has retry_after_seconds', () => assert.ok(typeof overLimit.data.retry_after_seconds === 'number' && overLimit.data.retry_after_seconds > 0));
  expect('Retry-After header set', () => assert.ok(overLimit.headers.get('Retry-After')));
}

console.log('[2] register: 5 attempts allowed within 1-hr window, 6th rate-limited');
{
  // 用不同 email 確保每次都是新註冊（避免 email_exists 干擾流程，但即使失敗也會計數）
  const ts = Date.now();
  let last;
  for (let i = 1; i <= 5; i++) {
    last = await req('POST', '/api/auth/register', {
      body: {
        email: `rl-test-${ts}-${i}@chinup.local`,
        password: 'testpass1234',
        name: `RL Test ${i}`,
        notification_preference: 'email',
      },
      headers: { 'X-Forwarded-For': REGISTER_IP },
    });
  }
  expect('attempt #5 is 201 (allowed, created)', () => assert.equal(last.status, 201));

  const sixth = await req('POST', '/api/auth/register', {
    body: {
      email: `rl-test-${ts}-6@chinup.local`,
      password: 'testpass1234',
      name: 'RL Test 6',
      notification_preference: 'email',
    },
    headers: { 'X-Forwarded-For': REGISTER_IP },
  });
  expect('attempt #6 is 429', () => assert.equal(sixth.status, 429));
  expect('429 body has rate_limited error', () => assert.equal(sixth.data.error, 'rate_limited'));
}

console.log('[3] different IP has its own bucket (isolation)');
{
  const OTHER_IP = '10.99.0.99';
  const r = await req('POST', '/api/auth/login', {
    body: { email: 'nobody@example.com', password: 'wrong' },
    headers: { 'X-Forwarded-For': OTHER_IP },
  });
  expect('different IP not rate-limited', () => assert.equal(r.status, 401));
}

// Cleanup: 把這次 test 建出來的 RL test user 從 DB 砍掉，避免汙染 demo data
console.log('[cleanup] removing test users created by [2]');
{
  const { db } = await import('../src/db/connection.js');
  const n = db.prepare("DELETE FROM users WHERE email LIKE 'rl-test-%@chinup.local'").run();
  console.log(`  removed ${n.changes} test users`);
}

console.log('[rate-limit test] done');
