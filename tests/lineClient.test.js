// Unit-style: HMAC signature verification + MOCK behavior of lineClient
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { sendMessage, verifySignature } from '../src/services/lineClient.js';

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

console.log('[lineClient test] done');
