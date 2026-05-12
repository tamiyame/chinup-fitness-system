// Phase 3C · HTTP integration tests for LINE webhook + binding endpoints.
// Runs against the live server on :3000. Server must have LINE_MOCK=1
// in env to make this test deterministic.
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { db } from '../src/db/connection.js';

const BASE = process.env.BASE || 'http://localhost:3000';

async function req(method, path, { body, token, raw = false, headers: extraHeaders } = {}) {
  const headers = { 'Content-Type': 'application/json', ...(extraHeaders || {}) };
  if (token) headers['Authorization'] = `Bearer ${token}`;
  const res = await fetch(BASE + path, {
    method,
    headers,
    body: raw ? body : (body ? JSON.stringify(body) : undefined),
  });
  const text = await res.text();
  let data;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  return { status: res.status, data, location: res.headers.get('location') };
}

async function loginAs(email, password) {
  const r = await req('POST', '/api/auth/login', { body: { email, password } });
  if (r.status !== 200) throw new Error(`login failed: ${JSON.stringify(r.data)}`);
  return r.data;
}

function expect(label, fn) {
  try { fn(); console.log(`  ✓ ${label}`); }
  catch (e) { console.log(`  ✗ ${label}`); console.error(e); process.exitCode = 1; }
}
async function expectAsync(label, fn) {
  try { await fn(); console.log(`  ✓ ${label}`); }
  catch (e) { console.log(`  ✗ ${label}`); console.error(e); process.exitCode = 1; }
}

console.log('[line-webhook-api test] start');

// Use user1 as our test subject. Clear any prior binding state.
db.prepare(`
  UPDATE users SET line_user_id = NULL, line_bind_code = NULL, line_bind_expires_at = NULL
  WHERE email = 'user1@chinup.local'
`).run();
db.prepare(`
  UPDATE users SET line_user_id = NULL WHERE line_user_id LIKE 'Utest-%'
`).run();

const user1 = await loginAs('user1@chinup.local', 'pass1234');

// --- GET /api/my/line/binding (unbound) ---
const b1 = await req('GET', '/api/my/line/binding', { token: user1.token });
expect('GET binding (unbound) → 200', () => assert.equal(b1.status, 200));
expect('bound=false', () => assert.equal(b1.data.bound, false));
expect('code is 6-digit', () => assert(/^\d{6}$/.test(b1.data.code)));
expect('expires_at present', () => assert(b1.data.expires_at));
const firstCode = b1.data.code;

// --- POST /api/my/line/regenerate ---
const reg = await req('POST', '/api/my/line/regenerate', { token: user1.token });
expect('regenerate → 200', () => assert.equal(reg.status, 200));
expect('new code differs', () => assert.notEqual(reg.data.code, firstCode));
const newCode = reg.data.code;

// --- POST /api/line/webhook with valid event (binding) ---
const wb = await req('POST', '/api/line/webhook', {
  body: {
    events: [{
      type: 'message',
      message: { type: 'text', text: newCode },
      source: { type: 'user', userId: 'Utest-user1' },
      replyToken: 'reply-token-fake',
    }],
  },
  headers: { 'X-Line-Signature': 'mock-sig-bypassed' },
});
expect('webhook → 200', () => assert.equal(wb.status, 200));

// Verify DB updated
const u1 = db.prepare(
  "SELECT line_user_id, line_bind_code FROM users WHERE email = 'user1@chinup.local'"
).get();
expect('line_user_id set after webhook', () => assert.equal(u1.line_user_id, 'Utest-user1'));
expect('line_bind_code cleared', () => assert.equal(u1.line_bind_code, null));

// --- GET /api/my/line/binding (now bound) ---
const b2 = await req('GET', '/api/my/line/binding', { token: user1.token });
expect('bound=true after binding', () => assert.equal(b2.data.bound, true));
expect('no code returned when bound', () => assert.equal(b2.data.code, undefined));

// --- DELETE /api/my/line ---
const del = await req('DELETE', '/api/my/line', { token: user1.token });
expect('delete → 200', () => assert.equal(del.status, 200));
const u1After = db.prepare(
  "SELECT line_user_id FROM users WHERE email = 'user1@chinup.local'"
).get();
expect('line_user_id cleared after delete', () => assert.equal(u1After.line_user_id, null));

// --- webhook: invalid code → no error, no binding ---
const u1Pre = db.prepare(
  "SELECT line_user_id FROM users WHERE email = 'user1@chinup.local'"
).get();
const wbBad = await req('POST', '/api/line/webhook', {
  body: {
    events: [{
      type: 'message',
      message: { type: 'text', text: '000000' },
      source: { type: 'user', userId: 'Utest-bad' },
      replyToken: 'rtok-bad',
    }],
  },
  headers: { 'X-Line-Signature': 'mock-sig' },
});
expect('webhook invalid code → 200', () => assert.equal(wbBad.status, 200));
const u1NoChange = db.prepare(
  "SELECT line_user_id FROM users WHERE email = 'user1@chinup.local'"
).get();
expect('invalid code did not bind', () => assert.equal(u1NoChange.line_user_id, u1Pre.line_user_id));

// --- webhook: unfollow event → unbind ---
// First, bind user1 again to test unbind
const b3 = await req('GET', '/api/my/line/binding', { token: user1.token });
const codeForUnfollow = b3.data.code;
await req('POST', '/api/line/webhook', {
  body: {
    events: [{
      type: 'message',
      message: { type: 'text', text: codeForUnfollow },
      source: { type: 'user', userId: 'Utest-followtest' },
      replyToken: 'rtok-1',
    }],
  },
  headers: { 'X-Line-Signature': 'mock-sig' },
});
const beforeUnfollow = db.prepare(
  "SELECT line_user_id FROM users WHERE email = 'user1@chinup.local'"
).get();
expect('rebound for unfollow test', () => assert.equal(beforeUnfollow.line_user_id, 'Utest-followtest'));

await req('POST', '/api/line/webhook', {
  body: {
    events: [{
      type: 'unfollow',
      source: { type: 'user', userId: 'Utest-followtest' },
    }],
  },
  headers: { 'X-Line-Signature': 'mock-sig' },
});
const afterUnfollow = db.prepare(
  "SELECT line_user_id FROM users WHERE email = 'user1@chinup.local'"
).get();
expect('unfollow cleared line_user_id', () => assert.equal(afterUnfollow.line_user_id, null));

console.log('[line-webhook-api test] done');
