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
