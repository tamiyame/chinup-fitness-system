// Unit-style: HMAC signature verification + MOCK behavior of lineClient
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { sendMessage, verifySignature, replyOrLog } from '../src/services/lineClient.js';

function expect(label, fn) {
  try { fn(); console.log(`  ✓ ${label}`); }
  catch (e) { console.log(`  ✗ ${label}`); console.error(e); process.exitCode = 1; }
}

async function expectAsync(label, fn) {
  try { await fn(); console.log(`  ✓ ${label}`); }
  catch (e) { console.log(`  ✗ ${label}`); console.error(e); process.exitCode = 1; }
}

console.log('[lineClient test] start');

// --- verifySignature ---
const SECRET = 'test-secret-1234';
const RAW = Buffer.from('{"events":[]}');
const validSig = createHmac('sha256', SECRET).update(RAW).digest('base64');

process.env.LINE_CHANNEL_SECRET = SECRET;
delete process.env.LINE_MOCK;

expect('valid signature → true', () => assert.equal(verifySignature(RAW, validSig), true));
expect('wrong signature → false', () => assert.equal(verifySignature(RAW, 'invalid-base64'), false));
expect('null signature → false', () => assert.equal(verifySignature(RAW, null), false));
expect('empty body + valid sig → true', () => {
  const emptyBody = Buffer.from('');
  const sig = createHmac('sha256', SECRET).update(emptyBody).digest('base64');
  assert.equal(verifySignature(emptyBody, sig), true);
});

process.env.LINE_MOCK = '1';
expect('LINE_MOCK=1 bypasses signature check', () => assert.equal(verifySignature(RAW, 'whatever'), true));
delete process.env.LINE_MOCK;

// Missing secret env → false (even with valid-looking sig)
const origSecret = process.env.LINE_CHANNEL_SECRET;
delete process.env.LINE_CHANNEL_SECRET;
expect('missing LINE_CHANNEL_SECRET → false', () => assert.equal(verifySignature(RAW, validSig), false));
process.env.LINE_CHANNEL_SECRET = origSecret;

// --- sendMessage MOCK behavior ---
process.env.LINE_MOCK = '1';
await expectAsync('LINE_MOCK=1 → { ok: true }', async () => {
  const r = await sendMessage('Ufake', 'hello');
  assert.deepEqual(r, { ok: true });
});

process.env.LINE_MOCK = 'fail';
await expectAsync('LINE_MOCK=fail → { ok: false, error: mock_fail }', async () => {
  const r = await sendMessage('Ufake', 'hello');
  assert.equal(r.ok, false);
  assert.equal(r.error, 'mock_fail');
});

delete process.env.LINE_MOCK;
const origToken = process.env.LINE_CHANNEL_ACCESS_TOKEN;
delete process.env.LINE_CHANNEL_ACCESS_TOKEN;
await expectAsync('missing access token → { ok: false, error: line_not_configured }', async () => {
  const r = await sendMessage('Ufake', 'hello');
  assert.equal(r.ok, false);
  assert.equal(r.error, 'line_not_configured');
});
if (origToken) process.env.LINE_CHANNEL_ACCESS_TOKEN = origToken;

// --- replyOrLog: 失敗時 console.error 並回 {ok:false}；成功時不吵 ---
process.env.LINE_MOCK = 'fail';
await expectAsync('replyOrLog 失敗 → 回 {ok:false} 且 console.error 一次（含 context + error）', async () => {
  const orig = console.error; const calls = [];
  console.error = (...a) => calls.push(a);
  let r;
  try { r = await replyOrLog('tok', 'hi', 'bind'); } finally { console.error = orig; }
  assert.equal(r.ok, false);
  assert.equal(calls.length, 1);
  assert.ok(String(calls[0][0]).includes('bind'), 'log 應含 context');
  assert.equal(calls[0][1], 'mock_fail');
});

process.env.LINE_MOCK = '1';
await expectAsync('replyOrLog 成功 → 回 {ok:true} 且不 console.error', async () => {
  const orig = console.error; const calls = [];
  console.error = (...a) => calls.push(a);
  let r;
  try { r = await replyOrLog('tok', 'hi', 'bind'); } finally { console.error = orig; }
  assert.deepEqual(r, { ok: true });
  assert.equal(calls.length, 0);
});
delete process.env.LINE_MOCK;

console.log('[lineClient test] done');
