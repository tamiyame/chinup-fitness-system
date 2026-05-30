// HTTP API 整合測試：backup 端點。需要 running server。
import assert from 'node:assert/strict';
import { readdirSync, unlinkSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const BASE = process.env.BASE || 'http://localhost:3000';
const __testDir = dirname(fileURLToPath(import.meta.url));
const BACKUP_DIR = resolve(__testDir, '../data/backups');

async function req(method, path, { body, token } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers['Authorization'] = `Bearer ${token}`;
  const res = await fetch(BASE + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const ct = res.headers.get('content-type') || '';
  if (ct.includes('application/json')) return { status: res.status, data: await res.json() };
  return { status: res.status, headers: res.headers, body: await res.arrayBuffer() };
}

async function loginAs(email, password) {
  const r = await req('POST', '/api/auth/login', { body: { email, password } });
  if (r.status !== 200) throw new Error(`login failed for ${email}`);
  return r.data;
}

function expect(label, fn) {
  try { fn(); console.log(`  ✓ ${label}`); }
  catch (e) { console.log(`  ✗ ${label}`); console.error(e); process.exitCode = 1; }
}

console.log('[backup-api test] start');

// Clean dev backups so tests have predictable state
if (existsSync(BACKUP_DIR)) {
  for (const f of readdirSync(BACKUP_DIR)) {
    try { unlinkSync(resolve(BACKUP_DIR, f)); } catch {}
  }
}

const admin = await loginAs('admin@chinup.local', 'admin1234');
// role=user login is disabled; use the seeded coach (non-admin) to exercise the 403 path.
const member = await loginAs('coach1@chinup.local', 'coachpass1234');

console.log('[1] GET /api/admin/backups requires admin');
{
  const noToken = await req('GET', '/api/admin/backups');
  expect('401 without token', () => assert.equal(noToken.status, 401));
  const asUser = await req('GET', '/api/admin/backups', { token: member.token });
  expect('403 as non-admin', () => assert.equal(asUser.status, 403));
  const asAdmin = await req('GET', '/api/admin/backups', { token: admin.token });
  expect('200 as admin', () => assert.equal(asAdmin.status, 200));
  expect('has files array', () => assert.ok(Array.isArray(asAdmin.data.files)));
  expect('has lastError key', () => assert.ok('lastError' in asAdmin.data));
}

console.log('[2] POST /api/admin/backups/run creates real file');
{
  const r = await req('POST', '/api/admin/backups/run', { token: admin.token });
  expect('200', () => assert.equal(r.status, 200));
  expect('ok=true', () => assert.equal(r.data.ok, true));
  expect('returns file name', () => assert.match(r.data.file, /^app-\d{8}-\d{6}\.db$/));
  expect('file exists on disk', () => assert.ok(existsSync(resolve(BACKUP_DIR, r.data.file))));
}

console.log('[3] POST /api/admin/backups/run requires admin');
{
  const asUser = await req('POST', '/api/admin/backups/run', { token: member.token });
  expect('403 as non-admin', () => assert.equal(asUser.status, 403));
}

console.log('[4] GET /api/admin/backups/:file streams real file');
{
  // Use the file we just created
  const list = await req('GET', '/api/admin/backups', { token: admin.token });
  const file = list.data.files[0].file;
  const dl = await req('GET', `/api/admin/backups/${file}`, { token: admin.token });
  expect('200', () => assert.equal(dl.status, 200));
  expect('content-type octet-stream', () => assert.match(dl.headers.get('content-type') || '', /octet-stream/));
  expect('content-disposition attachment', () => assert.match(dl.headers.get('content-disposition') || '', /attachment/));
  expect('body has size matching list', () => assert.equal(dl.body.byteLength, list.data.files[0].size));
}

console.log('[5] GET /api/admin/backups/:file 404 on bad name');
{
  const r = await req('GET', '/api/admin/backups/app-bad-name.txt', { token: admin.token });
  expect('404', () => assert.equal(r.status, 404));
}

console.log('[6] GET /api/admin/backups/:file 404 on traversal attempt');
{
  const r = await req('GET', '/api/admin/backups/' + encodeURIComponent('../../../etc/passwd'), { token: admin.token });
  expect('404 (encoded traversal)', () => assert.equal(r.status, 404));
}

console.log('[backup-api test] done');
