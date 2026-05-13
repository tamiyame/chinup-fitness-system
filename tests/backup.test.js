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

// --- Task 3: listBackups + safeBackupPath ---
console.log('[6] listBackups returns newest-first with size + createdAt');
{
  const dir = makeTmpDir();
  // Create 3 files with different timestamps; mtime order = creation order here
  writeFileSync(resolve(dir, 'app-20260101-000000.db'), 'a');
  writeFileSync(resolve(dir, 'app-20260201-000000.db'), 'bb');
  writeFileSync(resolve(dir, 'app-20260301-000000.db'), 'ccc');
  const r = listBackups(dir);
  expect('returns 3 files', () => assert.equal(r.files.length, 3));
  expect('newest first by filename', () => assert.equal(r.files[0].file, 'app-20260301-000000.db'));
  expect('oldest last', () => assert.equal(r.files[2].file, 'app-20260101-000000.db'));
  expect('size populated', () => assert.equal(r.files[0].size, 3));
  expect('createdAt is ISO string', () => assert.match(r.files[0].createdAt, /^\d{4}-\d{2}-\d{2}T/));
  expect('lastError null when no error file', () => assert.equal(r.lastError, null));
  rmSync(dir, { recursive: true, force: true });
}

console.log('[7] listBackups surfaces .last-error.txt content');
{
  const dir = makeTmpDir();
  writeFileSync(resolve(dir, '.last-error.txt'), '[2026-05-13T10:00:00.000Z] disk full\n');
  const r = listBackups(dir);
  expect('lastError populated', () => assert.match(r.lastError, /disk full/));
  rmSync(dir, { recursive: true, force: true });
}

console.log('[8] listBackups ignores non-matching files');
{
  const dir = makeTmpDir();
  writeFileSync(resolve(dir, 'app-20260101-000000.db'), 'a');
  writeFileSync(resolve(dir, 'README.txt'), 'noise');
  writeFileSync(resolve(dir, 'app-bad-name.db'), 'noise');
  const r = listBackups(dir);
  expect('only matching file counted', () => assert.equal(r.files.length, 1));
  rmSync(dir, { recursive: true, force: true });
}

console.log('[9] listBackups returns empty when dir missing');
{
  const dir = resolve(tmpdir(), 'chinup-backup-nonexistent-' + Date.now());
  const r = listBackups(dir);
  expect('files empty', () => assert.deepEqual(r.files, []));
  expect('lastError null', () => assert.equal(r.lastError, null));
}

console.log('[10] safeBackupPath rejects traversal + bad names');
{
  const dir = makeTmpDir();
  writeFileSync(resolve(dir, 'app-20260101-000000.db'), 'a');
  expect('rejects ../../../etc/passwd', () => assert.equal(safeBackupPath('../../../etc/passwd', dir), null));
  expect('rejects path with /', () => assert.equal(safeBackupPath('foo/app-20260101-000000.db', dir), null));
  expect('rejects bad regex', () => assert.equal(safeBackupPath('app-bad.txt', dir), null));
  expect('rejects nonexistent valid name', () => assert.equal(safeBackupPath('app-20260101-999999.db', dir), null));
  const ok = safeBackupPath('app-20260101-000000.db', dir);
  expect('accepts valid existing file', () => assert.ok(ok && ok.endsWith('app-20260101-000000.db')));
  rmSync(dir, { recursive: true, force: true });
}

console.log('[backup test] done');
