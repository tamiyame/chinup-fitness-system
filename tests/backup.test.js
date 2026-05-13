// backupService 服務層單元測試
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readdirSync, statSync, existsSync, rmSync } from 'node:fs';
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

console.log('[backup test] done');
