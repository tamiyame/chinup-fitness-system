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
// 具名快照：名稱只允許英數與 -（所以可以直接放進正規式）；檔名 `${name}-YYYYMMDD-HHMMSS.db`。
const SNAPSHOT_NAME_RE = /^[A-Za-z0-9-]+$/;
const namedSnapshotRe = (name) => new RegExp(`^${name}-\\d{8}-\\d{6}\\.db$`);

function pad(n) { return String(n).padStart(2, '0'); }
function tsForFile(d = new Date()) {
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

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

/** 具名快照（例如上線補登前）：同樣用 VACUUM INTO 取得一致的複本，
 *  檔名 `${name}-YYYYMMDD-HHMMSS.db` 不符合 FILE_RE，所以不受輪替刪除、也不會出現在備份清單。
 *  不寫 .last-error.txt（那是每週備份的狀態）。 */
export function runNamedSnapshot(name, dir = DEFAULT_DIR, tsFn = tsForFile) {
  try {
    if (!SNAPSHOT_NAME_RE.test(name)) throw new Error('invalid snapshot name');
    mkdirSync(dir, { recursive: true });
    const file = `${name}-${tsFn()}.db`;
    const fullPath = resolve(dir, file);
    if (existsSync(fullPath)) throw new Error(`snapshot exists: ${file}`);
    try {
      db.exec(`VACUUM INTO '${fullPath.replace(/'/g, "''")}'`);
    } catch (e) {
      // 失敗時可能留下寫到一半的檔案：順手刪掉（刪不掉、本來就沒有都不理會）。只在 VACUUM INTO 失敗時刪，不碰既有的快照。
      try { unlinkSync(fullPath); } catch { /* 忽略 */ }
      throw e;
    }
    return { ok: true, file, size: statSync(fullPath).size };
  } catch (e) {
    console.error('[backup] named snapshot failed:', e.message);
    return { ok: false, error: e.message };
  }
}

/** 刪除一份具名快照（例如補登失敗後收回剛做的快照）。回 true＝已刪掉或本來就不在。
 *  檔名必須是 `${name}-YYYYMMDD-HHMMSS.db` 才刪，不合 → 什麼都不做、回 false；
 *  其他錯誤只記錄檔名、回 false。絕不丟例外（開機時呼叫，不能擋住伺服器）。 */
export function removeNamedSnapshot(file, name, dir = DEFAULT_DIR) {
  try {
    if (typeof file !== 'string' || typeof name !== 'string' || !SNAPSHOT_NAME_RE.test(name)) return false;
    if (!namedSnapshotRe(name).test(file)) return false;
    unlinkSync(resolve(dir, file));
    return true;
  } catch (e) {
    if (e && e.code === 'ENOENT') return true;
    try { console.error('[backup] named snapshot remove failed:', file, e && e.message); } catch { /* 忽略 */ }
    return false;
  }
}

/** 列出資料夾裡的具名快照檔名（`${name}-YYYYMMDD-HHMMSS.db`，由舊到新）；資料夾不存在 → []。 */
export function listNamedSnapshots(name, dir = DEFAULT_DIR) {
  if (!SNAPSHOT_NAME_RE.test(name)) throw new Error('invalid snapshot name');
  if (!existsSync(dir)) return [];
  const re = namedSnapshotRe(name);
  return readdirSync(dir).filter((f) => re.test(f)).sort();
}

export function pruneOldBackups(dir = DEFAULT_DIR, keep = KEEP) {
  if (!existsSync(dir)) return;
  const files = readdirSync(dir).filter((f) => FILE_RE.test(f)).sort();
  while (files.length > keep) {
    const oldest = files.shift();
    try { unlinkSync(resolve(dir, oldest)); } catch (e) { console.warn('[backup] prune unlink failed:', oldest, e.message); }
  }
}

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
