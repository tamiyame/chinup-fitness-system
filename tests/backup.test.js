// backupService 服務層單元測試
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, statSync, existsSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { runBackup, listBackups, safeBackupPath } from '../src/services/backupService.js';

function expect(label, fn) {
  try { fn(); console.log(`  ✓ ${label}`); }
  catch (e) { console.log(`  ✗ ${label}`); console.error(e); process.exitCode = 1; }
}

function makeTmpDir() {
  return mkdtempSync(resolve(tmpdir(), 'chinup-backup-test-'));
}

function tsForFileFixture() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${pad(d.getMonth()+1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

console.log('[backup test] start');

// --- Task 1: runBackup happy path + prune ---
console.log('[1] runBackup creates .db file matching FILE_RE');
{
  const dir = makeTmpDir();
  const r = runBackup(dir);
  expect('returns ok=true', () => assert.equal(r.ok, true));
  expect('returns file in expected format', () => assert.match(r.file, /^app-\d{8}-\d{6}\.db$/));
  expect('file exists on disk', () => assert.ok(existsSync(resolve(dir, r.file))));
  expect('file size > 0 (real SQLite snapshot)', () => assert.ok(r.size > 0));
  rmSync(dir, { recursive: true, force: true });
}

console.log('[2] runBackup prunes to KEEP=8');
{
  const dir = makeTmpDir();
  // Pre-create 10 fake backup files with valid names (older timestamps)
  for (let i = 0; i < 10; i++) {
    const ts = `2026010${i}-000000`;  // 20260100-000000 .. 20260109-000000
    writeFileSync(resolve(dir, `app-${ts}.db`), 'fake');
  }
  const r = runBackup(dir);
  expect('runBackup succeeded', () => assert.equal(r.ok, true));
  const remaining = readdirSync(dir).filter(f => /^app-\d{8}-\d{6}\.db$/.test(f));
  expect('exactly 8 files remain', () => assert.equal(remaining.length, 8));
  // Sorted: 10 fakes (oldest) + 1 new (newest) = 11 → keep 8 newest → 3 oldest dropped
  expect('oldest fake removed', () => assert.ok(!remaining.includes('app-20260100-000000.db')));
  expect('newest snapshot retained', () => assert.ok(remaining.includes(r.file)));
  rmSync(dir, { recursive: true, force: true });
}

// --- Task 2: error path + last-error.txt lifecycle ---
console.log('[3] runBackup writes .last-error.txt on failure');
{
  const dir = makeTmpDir();
  // Make the backup target unwritable: create a file at the path runBackup will try to mkdir
  // Trick: pass a dir path that has a non-directory file at the SAME path.
  const blocked = resolve(dir, 'not-a-dir');
  writeFileSync(blocked, 'I am a file, not a directory');
  const r = runBackup(blocked);
  expect('returns ok=false', () => assert.equal(r.ok, false));
  expect('returns error string', () => assert.equal(typeof r.error, 'string'));
  // .last-error.txt should NOT exist in `blocked` because mkdir failed; this test
  // verifies the API contract (ok:false + error). The next test covers the file write.
  rmSync(dir, { recursive: true, force: true });
}

console.log('[4] runBackup writes .last-error.txt when VACUUM INTO fails after mkdir succeeds');
{
  const dir = makeTmpDir();
  // Pre-create a directory at the path where VACUUM INTO wants to write its file
  // → SQLite cannot write a regular file over an existing directory → throws
  const ts = tsForFileFixture();  // helper below
  const targetName = `app-${ts}.db`;
  mkdirSync(resolve(dir, targetName));   // dir in the way
  const r = runBackup(dir, () => ts);    // inject ts override (see Task 2 impl)
  expect('returns ok=false', () => assert.equal(r.ok, false));
  expect('.last-error.txt exists', () => assert.ok(existsSync(resolve(dir, '.last-error.txt'))));
  const content = readFileSync(resolve(dir, '.last-error.txt'), 'utf8');
  expect('error file has ISO timestamp', () => assert.match(content, /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/));
  expect('error file has error message', () => assert.ok(content.length > 30));
  rmSync(dir, { recursive: true, force: true });
}

console.log('[5] runBackup clears .last-error.txt on success');
{
  const dir = makeTmpDir();
  writeFileSync(resolve(dir, '.last-error.txt'), '[stale]');
  const r = runBackup(dir);
  expect('runBackup succeeded', () => assert.equal(r.ok, true));
  expect('.last-error.txt removed', () => assert.ok(!existsSync(resolve(dir, '.last-error.txt'))));
  rmSync(dir, { recursive: true, force: true });
}

console.log('[backup test] done');
