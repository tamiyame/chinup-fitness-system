# SQLite Backup Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 對 production SQLite DB 每週自動產生原子快照、保留 8 份、admin 在 `/admin.html` 列表+下載+手動觸發；防的是邏輯資料損壞而不是 volume 整毀。

**Architecture:** 新檔 `src/services/backupService.js` 用 SQLite `VACUUM INTO` 寫原子快照到 `<DB_PATH 同層>/backups/`；node-cron 週日 03:00 Asia/Taipei 觸發；3 個 `requireAdmin` HTTP endpoints；admin 頁加 card section，下載用 fetch+blob 攜帶 Authorization header；零 schema 變動、零新 npm 依賴。

**Tech Stack:** Node 24 ESM + Express + `node:sqlite` + `node-cron` + Vanilla JS + Tailwind CDN + `node:assert/strict` test runner（既有 codebase 約定）

**Spec:** `docs/superpowers/specs/2026-05-13-sqlite-backup-design.md` (commit `5306b00`)

---

## Pre-flight

- [ ] **Confirm working on `feature/sqlite-backup` branch**

```bash
git branch --show-current
```
Expected: `feature/sqlite-backup`

If not on this branch:
```bash
git checkout feature/sqlite-backup
```

The branch should already exist with the spec committed (`5306b00`).

---

## Task 1: backupService.runBackup() happy path + pruneOldBackups

**Files:**
- Create: `src/services/backupService.js`
- Create: `tests/backup.test.js`

設計考量：所有公開函式接受 `dir` 參數（預設 `BACKUP_DIR`），方便測試傳入 tmpdir 而不污染 `data/backups/`。

### Step 1: Write the failing tests

Create `tests/backup.test.js`:

```js
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
```

### Step 2: Run test to verify it fails

```bash
node tests/backup.test.js
```
Expected: FAIL with `Cannot find module '../src/services/backupService.js'` or similar.

### Step 3: Write minimal implementation

Create `src/services/backupService.js`:

```js
import { db } from '../db/connection.js';
import {
  mkdirSync, readdirSync, statSync, existsSync, writeFileSync, readFileSync, unlinkSync,
} from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DB_PATH = process.env.DB_PATH || resolve(__dirname, '../../data/app.db');
const DEFAULT_DIR = resolve(dirname(DB_PATH), 'backups');
const LAST_ERROR_NAME = '.last-error.txt';
const KEEP = 8;
const FILE_RE = /^app-\d{8}-\d{6}\.db$/;

function pad(n) { return String(n).padStart(2, '0'); }
function tsForFile(d = new Date()) {
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

export function runBackup(dir = DEFAULT_DIR) {
  mkdirSync(dir, { recursive: true });
  const file = `app-${tsForFile()}.db`;
  const fullPath = resolve(dir, file);
  const sqlPath = fullPath.replace(/'/g, "''");
  db.exec(`VACUUM INTO '${sqlPath}'`);
  const errorFile = resolve(dir, LAST_ERROR_NAME);
  if (existsSync(errorFile)) unlinkSync(errorFile);
  pruneOldBackups(dir, KEEP);
  return { ok: true, file, size: statSync(fullPath).size };
}

export function pruneOldBackups(dir = DEFAULT_DIR, keep = KEEP) {
  if (!existsSync(dir)) return;
  const files = readdirSync(dir).filter((f) => FILE_RE.test(f)).sort();
  while (files.length > keep) {
    const oldest = files.shift();
    try { unlinkSync(resolve(dir, oldest)); } catch (e) { console.warn('[backup] prune unlink failed:', oldest, e.message); }
  }
}

// Placeholders for Tasks 3+5 — keep exports importable now to avoid breaking test imports
export function listBackups(dir = DEFAULT_DIR) { throw new Error('not implemented'); }
export function safeBackupPath(file, dir = DEFAULT_DIR) { throw new Error('not implemented'); }
```

### Step 4: Run test to verify it passes

```bash
node tests/backup.test.js
```
Expected: PASS — `[1] runBackup creates .db file matching FILE_RE` 4 checks ✓, `[2] runBackup prunes to KEEP=8` 4 checks ✓.

### Step 5: Commit

```bash
git add src/services/backupService.js tests/backup.test.js
git commit -m "$(cat <<'EOF'
feat(backup): add runBackup happy path + pruneOldBackups

VACUUM INTO writes atomic snapshot to <DB_PATH>/backups/ with
filename app-YYYYMMDD-HHmmss.db. Keeps newest 8, deletes older
via lexical sort (== chronological by name format).

Public funcs accept optional dir param so tests can use tmpdir
without polluting data/backups/. listBackups + safeBackupPath
stubbed pending Task 3+5.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: runBackup error path → writes `.last-error.txt`

**Files:**
- Modify: `src/services/backupService.js`
- Modify: `tests/backup.test.js`

### Step 1: Add the failing tests

Append to `tests/backup.test.js` before `console.log('[backup test] done');`:

```js
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
```

Also add `readFileSync` to the imports at top of the test file (alongside other `node:fs` imports), and add this helper near `makeTmpDir`:

```js
function tsForFileFixture() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${pad(d.getMonth()+1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}
```

### Step 2: Run test to verify it fails

```bash
node tests/backup.test.js
```
Expected: FAIL — runBackup currently throws on failure instead of returning `{ ok: false, error }`; `.last-error.txt` not written; success path also throws on no-arg `tsOverride`.

### Step 3: Modify `runBackup` to catch + write error file + accept optional ts override

Replace the existing `runBackup` in `src/services/backupService.js` with:

```js
export function runBackup(dir = DEFAULT_DIR, tsFn = tsForFile) {
  const errorFile = resolve(dir, LAST_ERROR_NAME);
  let file, fullPath;
  try {
    mkdirSync(dir, { recursive: true });
    file = `app-${tsFn()}.db`;
    fullPath = resolve(dir, file);
    const sqlPath = fullPath.replace(/'/g, "''");
    db.exec(`VACUUM INTO '${sqlPath}'`);
    if (existsSync(errorFile)) unlinkSync(errorFile);
    pruneOldBackups(dir, KEEP);
    return { ok: true, file, size: statSync(fullPath).size };
  } catch (e) {
    const msg = `[${new Date().toISOString()}] ${e.message}\n`;
    try {
      if (existsSync(dir)) writeFileSync(errorFile, msg);
    } catch (writeErr) {
      // If we can't even write the error file (e.g., dir is a file), there's nothing more to do.
    }
    console.error('[backup] failed:', e.message);
    return { ok: false, error: e.message };
  }
}
```

### Step 4: Run tests to verify they pass

```bash
node tests/backup.test.js
```
Expected: PASS — all 5 test groups, including the 4 new error-path checks.

### Step 5: Commit

```bash
git add src/services/backupService.js tests/backup.test.js
git commit -m "$(cat <<'EOF'
feat(backup): wrap runBackup in try/catch, write .last-error.txt

On VACUUM INTO failure, writes ISO-timestamped error to
<dir>/.last-error.txt and returns { ok: false, error }. On
success, removes any stale .last-error.txt. Adds tsFn injection
arg so tests can pin filename for failure-mode tests (dir in
the way of target file path).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: listBackups + safeBackupPath

**Files:**
- Modify: `src/services/backupService.js`
- Modify: `tests/backup.test.js`

### Step 1: Add the failing tests

Append to `tests/backup.test.js` before `console.log('[backup test] done');`:

```js
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
```

### Step 2: Run tests to verify they fail

```bash
node tests/backup.test.js
```
Expected: FAIL — `not implemented` thrown from the stubs added in Task 1.

### Step 3: Replace the stubs with real implementations

In `src/services/backupService.js`, replace the two `throw new Error('not implemented')` stubs with:

```js
export function listBackups(dir = DEFAULT_DIR) {
  if (!existsSync(dir)) return { files: [], lastError: null };
  const files = readdirSync(dir)
    .filter((f) => FILE_RE.test(f))
    .map((f) => {
      const s = statSync(resolve(dir, f));
      return { file: f, createdAt: s.mtime.toISOString(), size: s.size };
    })
    .sort((a, b) => b.file.localeCompare(a.file));
  const errorFile = resolve(dir, LAST_ERROR_NAME);
  const lastError = existsSync(errorFile) ? readFileSync(errorFile, 'utf8').trim() : null;
  return { files, lastError };
}

export function safeBackupPath(file, dir = DEFAULT_DIR) {
  if (typeof file !== 'string') return null;
  if (!FILE_RE.test(file)) return null;
  const full = resolve(dir, file);
  if (dirname(full) !== resolve(dir)) return null;
  if (!existsSync(full)) return null;
  return full;
}
```

### Step 4: Run tests to verify they pass

```bash
node tests/backup.test.js
```
Expected: PASS — all 10 test groups green.

### Step 5: Commit

```bash
git add src/services/backupService.js tests/backup.test.js
git commit -m "$(cat <<'EOF'
feat(backup): add listBackups + safeBackupPath

listBackups: scans dir, filters by FILE_RE, returns newest-first
with size + createdAt (mtime ISO), surfaces .last-error.txt
content as lastError. Empty/missing dir returns empty list.

safeBackupPath: regex whitelist + resolved-dirname equality
check + existence check. Three independent guards against path
traversal.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: Wire weekly cron in `scheduler.js`

**Files:**
- Modify: `src/scheduler.js`

cron API contracts aren't worth a TDD test (would test node-cron, not our code). Just inspect that startup doesn't throw.

### Step 1: Modify `src/scheduler.js`

Open the file. After the existing `processFailedNotifications` cron block (around line 30, before the `console.log('[scheduler] cron jobs registered');` line), add the import at top:

```js
import { runBackup } from './services/backupService.js';
```

And insert this cron block before the final `console.log`:

```js
// 每週日 03:00 (Asia/Taipei) 跑 SQLite VACUUM INTO 快照
cron.schedule('0 3 * * 0', () => {
  try {
    const r = runBackup();
    if (r.ok) console.log('[scheduler] backup ok:', r.file, r.size, 'bytes');
    // 失敗時 backupService 內部已 console.error + 寫 .last-error.txt
  } catch (e) {
    console.error('[scheduler] backup throw:', e);
  }
}, { timezone: 'Asia/Taipei' });
```

### Step 2: Smoke test — register schedulers directly via node -e (no GNU `timeout` needed on macOS)

```bash
node -e "import('./src/scheduler.js').then(m => { m.startScheduler(); console.log('SMOKE_OK'); setTimeout(() => process.exit(0), 100); })"
```
Expected: prints `[scheduler] cron jobs registered` followed by `SMOKE_OK`. No throws / unhandled rejections.

### Step 3: Commit

```bash
git add src/scheduler.js
git commit -m "$(cat <<'EOF'
feat(backup): wire weekly cron (Sun 03:00 Asia/Taipei)

Uses node-cron's timezone option explicitly so the schedule
doesn't depend on Railway TZ env or process locale. Failures
in runBackup() are already handled inside the service (writes
.last-error.txt + console.error); the wrapping try/catch here
is just belt-and-suspenders for an unexpected throw.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 5: Admin HTTP endpoints + integration test file

**Files:**
- Modify: `src/server.js`
- Create: `tests/backup-api.test.js`
- Modify: `package.json` (add to `test:api` script)

### Step 1: Write the failing HTTP tests

Create `tests/backup-api.test.js`:

```js
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
const member = await loginAs('user1@chinup.local', 'pass1234');

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
```

### Step 2: Run test to verify it fails (server must be running but endpoints not yet defined)

In one terminal, start the server:
```bash
node src/server.js
```
In another:
```bash
node tests/backup-api.test.js
```
Expected: every `200`/`ok` expectation fails because Express returns 404 (no route).

### Step 3: Add 3 endpoints to `src/server.js`

Add imports near other service imports (around line 14-25, alongside `notifications`, `bookingService` etc.):

```js
import { runBackup, listBackups, safeBackupPath } from './services/backupService.js';
import { createReadStream } from 'node:fs';
import { basename } from 'node:path';
```

(If `basename` is already imported above, don't duplicate.)

Then add the 3 endpoints somewhere in the admin section (e.g., right after `app.post('/api/admin/jobs/send-reminders', ...)` around line 806):

```js
app.get('/api/admin/backups', requireAdmin, asyncHandler((req, res) => {
  res.json(listBackups());
}));

app.post('/api/admin/backups/run', requireAdmin, asyncHandler((req, res) => {
  const r = runBackup();
  res.status(r.ok ? 200 : 500).json(r);
}));

app.get('/api/admin/backups/:file', requireAdmin, asyncHandler((req, res) => {
  const full = safeBackupPath(req.params.file);
  if (!full) return res.status(404).json({ error: 'not_found' });
  res.setHeader('Content-Type', 'application/octet-stream');
  res.setHeader('Content-Disposition', `attachment; filename="${basename(full)}"`);
  createReadStream(full).pipe(res);
}));
```

### Step 4: Run test to verify it passes

Restart server (Ctrl+C and re-run `node src/server.js`), then:
```bash
node tests/backup-api.test.js
```
Expected: PASS — all 6 test groups green.

### Step 5: Add new test file to `test:api` script

Open `package.json`. Modify `scripts.test:api` from:
```json
"test:api": "node tests/api.test.js && node tests/booking-api.test.js",
```
To:
```json
"test:api": "node tests/api.test.js && node tests/booking-api.test.js && node tests/backup-api.test.js",
```

### Step 6: Commit

```bash
git add src/server.js tests/backup-api.test.js package.json
git commit -m "$(cat <<'EOF'
feat(backup): add 3 admin HTTP endpoints

GET    /api/admin/backups          list + lastError
POST   /api/admin/backups/run      manual trigger
GET    /api/admin/backups/:file    streaming download with
                                   safeBackupPath path-traversal guard

Endpoints all require admin; download endpoint returns 404 on
bad/traversal/non-existent filename to avoid existence-leak.
Adds tests/backup-api.test.js to npm run test:api.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 6: Admin UI section — list, manual trigger, download

**Files:**
- Modify: `public/admin.html`
- Modify: `public/admin.js`

UI testing is human-only per workflow_preferences (manual mobile smoke at 390px viewport is the merge gate). This task delivers the working UI for that smoke.

### Step 1: Modify `public/admin.html`

Find the existing 「通知紀錄」 section (search for `通知紀錄` in admin.html). Add this new section **immediately after** it:

```html
<section class="card mt-6">
  <div class="flex items-center justify-between mb-4">
    <h2 class="text-xl font-bold">資料備份</h2>
    <button id="btn-backup-now" class="btn">立即備份</button>
  </div>
  <div id="backup-last-error" class="hidden mb-3 text-sm text-red-700 bg-red-50 border border-red-200 rounded px-3 py-2"></div>
  <div class="overflow-x-auto">
    <table class="w-full text-sm">
      <thead>
        <tr class="text-left border-b">
          <th class="py-2">檔名</th>
          <th class="py-2">建立時間</th>
          <th class="py-2 text-right">大小</th>
          <th class="py-2 text-right"></th>
        </tr>
      </thead>
      <tbody id="backup-list">
        <tr><td colspan="4" class="py-4 text-center text-gray-400">載入中…</td></tr>
      </tbody>
    </table>
  </div>
  <p class="mt-3 text-xs text-gray-500">每週日 03:00 自動備份；保留最近 8 份。建議每週一上班時下載最新一份到本機保管。</p>
</section>
```

### Step 2: Modify `public/admin.js`

Add these functions to the file (place near `loadNotifications`, around line 250-270 depending on existing structure):

```js
function fmtSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

async function downloadBackup(file) {
  try {
    const { getToken } = await import('/app.js');
    const res = await fetch(`/api/admin/backups/${encodeURIComponent(file)}`, {
      headers: { Authorization: `Bearer ${getToken()}` },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = file;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  } catch (e) {
    toast(`下載失敗：${e.message}`, 'error');
  }
}

async function loadBackups() {
  const tbody = document.getElementById('backup-list');
  const errBox = document.getElementById('backup-last-error');
  try {
    const r = await api('/api/admin/backups');
    if (r.lastError) {
      errBox.textContent = `上次備份失敗：${r.lastError}`;
      errBox.classList.remove('hidden');
    } else {
      errBox.classList.add('hidden');
      errBox.textContent = '';
    }
    if (!r.files.length) {
      tbody.innerHTML = '<tr><td colspan="4" class="py-4 text-center text-gray-400">尚無備份</td></tr>';
      return;
    }
    tbody.innerHTML = r.files.map((f) => `
      <tr class="border-b">
        <td class="py-2 font-mono text-xs">${f.file}</td>
        <td class="py-2">${fmtDate(f.createdAt)}</td>
        <td class="py-2 text-right">${fmtSize(f.size)}</td>
        <td class="py-2 text-right"><button class="link" data-dl="${f.file}">下載</button></td>
      </tr>
    `).join('');
    tbody.querySelectorAll('[data-dl]').forEach((btn) => {
      btn.addEventListener('click', () => downloadBackup(btn.dataset.dl));
    });
  } catch (e) {
    tbody.innerHTML = `<tr><td colspan="4" class="py-4 text-center text-red-600">載入失敗：${e.message}</td></tr>`;
  }
}

function bindBackupButton() {
  const btn = document.getElementById('btn-backup-now');
  if (!btn) return;
  btn.addEventListener('click', async () => {
    btn.disabled = true;
    btn.textContent = '備份中…';
    try {
      const r = await api('/api/admin/backups/run', { method: 'POST' });
      if (r.ok) {
        toast(`備份完成：${r.file}`, 'success');
        loadBackups();
      } else {
        toast(`備份失敗：${r.error}`, 'error');
      }
    } catch (e) {
      toast(`備份失敗：${e.message}`, 'error');
    } finally {
      btn.disabled = false;
      btn.textContent = '立即備份';
    }
  });
}
```

Find the existing "module top-level boot" area where other `load*()` functions are called on page load (search for `loadTemplates(); loadNotif*()` or similar pattern, likely at the bottom of the file). Add to that boot block:

```js
loadBackups();
bindBackupButton();
```

### Step 3: Manual smoke (human)

Start dev server, open `/admin.html` as admin in browser:

```bash
node src/server.js
```

Visit `http://localhost:3000/admin.html` → login as `admin@chinup.local / admin1234`. Scroll to bottom; the new section should:

- Show "尚無備份" initially (or existing files if previous tasks created any)
- Clicking 「立即備份」 → button disables, says "備份中…", then toast「備份完成」appears and the table re-renders with the new file at top
- Click 「下載」 → browser downloads `app-YYYYMMDD-HHmmss.db` file
- If you `rm data/backups/.last-error.txt` doesn't exist but manually create one with text content, reload page → red error box appears

Also smoke at mobile viewport (390px): table should be horizontally scrollable (the `overflow-x-auto` wrapper), buttons accessible.

If smoke passes, continue. If not, fix and re-smoke.

### Step 4: Commit

```bash
git add public/admin.html public/admin.js
git commit -m "$(cat <<'EOF'
feat(backup): add 「資料備份」 admin UI section

List + 「立即備份」 button + per-row download. Download uses
fetch + blob URL because <a href> won't carry Authorization
header. lastError surfaced as red banner above table. Mobile-
friendly via overflow-x-auto wrapper.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 7: `.gitignore` data/backups/ + verification

**Files:**
- Modify: `.gitignore`

### Step 1: Add backups dir to `.gitignore`

Check current `.gitignore`:
```bash
cat .gitignore
```

If `data/backups/` (or a parent that covers it) is not already listed, append:
```bash
echo "data/backups/" >> .gitignore
```

### Step 2: Confirm `data/backups/` is untracked

```bash
git status data/backups/
```
Expected: empty output (ignored). If files inside are listed as untracked, the .gitignore line didn't take effect — adjust the pattern.

### Step 3: Run full test suite

```bash
node tests/backup.test.js
```
Expected: PASS — 10 groups, all ✓.

```bash
# In one terminal:
node src/server.js
# In another:
npm run test:api
```
Expected: PASS — including the new backup-api.test.js block (6 groups). Note: existing api.test.js has 8 pre-existing failures (per project memory, stale seed dates) — those are not regressions.

### Step 4: Commit

```bash
git add .gitignore
git commit -m "$(cat <<'EOF'
chore: gitignore data/backups/

Local backup snapshots are dev/prod data, never source.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 8: Push branch + open draft PR

**Files:**
- (no file changes) GitHub API via curl

### Step 1: Push branch

```bash
git push -u origin feature/sqlite-backup
```
Expected: branch created on remote, output shows `feature/sqlite-backup -> feature/sqlite-backup`.

### Step 2: Open draft PR via GitHub API

```bash
PAT=$(printf "protocol=https\nhost=github.com\n\n" | git credential fill 2>/dev/null | awk -F= '/^password/{print $2}')

curl -s -X POST \
  -H "Authorization: token $PAT" \
  -H "Accept: application/vnd.github+json" \
  https://api.github.com/repos/tamiyame/chinup-fitness-system/pulls \
  -d "$(cat <<'EOF'
{
  "title": "SQLite weekly backup + admin download UI",
  "head": "feature/sqlite-backup",
  "base": "main",
  "draft": true,
  "body": "## Summary\n\n- 每週日 03:00 (Asia/Taipei) 自動 `VACUUM INTO` 一份原子快照到 `<DB_PATH>/backups/`\n- 保留最新 8 份（兩個月）\n- Admin 在 `/admin.html` 新區塊可看列表、手動觸發、下載任一份\n- 零 schema 變動、零新 npm 依賴\n\n## Threat model\n\n防的是邏輯資料損壞 / 誤刪 / migration bug。**不防** Railway volume 整毀 — 那需要 admin 養成定期下載最新一份到本機保管的習慣（UI 上有提示文字）。\n\n## Test plan\n\n- [x] `node tests/backup.test.js` — 10 service-level test groups\n- [x] `npm run test:api` 含新增的 `tests/backup-api.test.js` — 6 個 HTTP 整合測試\n- [ ] Manual mobile smoke (390px viewport) — 列表 / 立即備份 / 下載 / 錯誤橫條\n- [ ] 確認 `.gitignore` 排除 `data/backups/`\n\n## Design refs\n\n- Spec: `docs/superpowers/specs/2026-05-13-sqlite-backup-design.md`\n- Plan: `docs/superpowers/plans/2026-05-13-sqlite-backup.md`\n\n## Deviations\n\n（執行時若有偏離 plan 的地方寫在這裡）"
}
EOF
)"
```

### Step 3: Capture PR URL and verify draft state

The curl response includes `html_url`. Open it in browser to verify:
- PR is draft
- All Task 1–7 commits visible
- Test plan checklist renders

User then does manual smoke (390px viewport) following the spec §9 expectations. Reports any bugs found.

### Step 4: After smoke passes + final review subagent

(Out of plan scope — covered by user's workflow_preferences steps 6–8: manual smoke gate → final holistic review subagent → merge via API → cleanup branch.)

---

## Self-Review Notes

**Spec coverage:**
- §3 In Scope items 1–7: all covered by Tasks 1–7
- §6 core logic: Tasks 1, 2, 3
- §7 cron: Task 4
- §8 API: Task 5
- §9 UI: Task 6
- §10 error handling: Tasks 2 + 5 (404 path) + 6 (UI surfacing)
- §11 security: Tasks 3 (safeBackupPath) + 5 (requireAdmin + 404 on bad name)
- §12 testing: distributed across Tasks 1–5
- §13 deploy notes: covered in Task 4 commit message + Task 6 UI hint text

**No placeholders**: every step has explicit code or commands.

**Type consistency**: `runBackup(dir, tsFn)`, `listBackups(dir)`, `pruneOldBackups(dir, keep)`, `safeBackupPath(file, dir)` — signatures used consistently across Tasks 1–5.

**Open issues**: none — all 8 tasks have green-path verifications.
