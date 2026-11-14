// 開機一次性補登：把既有「沒有方案的未取消預約」各補一張線上單堂方案。
// 先快照、再單一交易寫入；任何失敗都不往外丟（不能擋住伺服器開機），回 { ran: false, reason }。
// 交易失敗會刪掉剛做的快照；失敗原因寫進 app_settings，summary 端點看得到。
import { db, tx, nowLocal } from '../db/connection.js';
import { getSetting, setSetting } from './discountService.js';
import { createOnlineSingleForBooking } from './packageService.js';
import { runNamedSnapshot, removeNamedSnapshot, listNamedSnapshots } from './backupService.js';

const LOCAL_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/;
const UTC_RE = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2})$/;
const pad = (n) => String(n).padStart(2, '0');

/** 預約的 created_at（SQLite datetime('now')＝UTC）→ 本地 'YYYY-MM-DDTHH:MM:SS'。
 *  已是本地格式原樣回傳；壞資料退回當下時間（不能讓整批補登失敗）。 */
export function utcToLocal(s) {
  if (typeof s === 'string') {
    if (LOCAL_RE.test(s)) return s;
    const m = UTC_RE.exec(s);
    if (m) {
      const d = new Date(`${m[1]}T${m[2]}Z`);
      if (!Number.isNaN(d.getTime())) {
        return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
      }
    }
  }
  return nowLocal();
}

const SNAP_NAME = 'pre-online-single';
const ERROR_KEY = 'online_single_backfill_error';
// 快照資料夾裡已有這麼多份補登快照就不再做新的、也不補登（交易失敗又刪不掉快照時，磁碟最多多這幾份）。
const MAX_SNAPSHOTS = 2;

/** 例外 → 錯誤訊息字串；本身絕不丟例外（會在 catch 裡呼叫）。 */
function errMsg(e) {
  try { return e && e.message ? String(e.message) : String(e); } catch { return 'unknown error'; }
}

/** 失敗原因寫進 app_settings，讓 GET /api/admin/packages/summary 看得到。在交易外寫；寫不進去就算了，絕不丟例外。 */
function recordFailure(result) {
  try {
    setSetting(ERROR_KEY, JSON.stringify({
      at: nowLocal(), reason: result.reason, error: result.error ?? null, snapshotLeft: result.snapshotLeft ?? null,
    }));
  } catch { /* 記錄失敗不理會：不能擋開機 */ }
}

/** 補登本體；可能丟例外，由 backfillOnlineSingles 接住。 */
function runBackfill({ snapshot, removeSnapshot, listSnapshots }) {
  if (getSetting('online_single_backfill_done') === '1') return { ran: false, reason: 'done' };

  const rows = db.prepare("SELECT id, member_id, created_at FROM bookings WHERE status = 'confirmed' AND package_id IS NULL ORDER BY id").all();

  let snapFile = null;
  if (rows.length > 0) {
    // 先前失敗留下的快照已達上限 → 不再做新的、也不補登（不自動刪舊的：可能刪到上線前那份真正有用的快照）。
    const files = listSnapshots();
    if (files.length >= MAX_SNAPSHOTS) return { ran: false, reason: 'snapshot_leftover', files };
    // 快照在交易之前；失敗就什麼都不寫，下次開機重試。
    const snap = snapshot();
    if (!snap || snap.ok !== true) return { ran: false, reason: 'snapshot_failed' };
    snapFile = snap.file || null;
  }

  const at = nowLocal();
  const members = new Set(rows.map((r) => r.member_id));
  const summary = { created: rows.length, members: members.size, at, snapshot: snapFile };
  // 方案、旗標、摘要、清掉上次的失敗原因同一個交易：中途失敗全部回滾，沒有旗標，下次開機重跑。
  try {
    tx(() => {
      for (const r of rows) {
        try { createOnlineSingleForBooking(r.id, { createdAt: utcToLocal(r.created_at) }); }
        catch (e) { throw new Error(`booking ${r.id}: ${errMsg(e)}`); }   // 說出是哪一筆讓整批失敗
      }
      setSetting('online_single_backfill_summary', JSON.stringify(summary));
      setSetting(ERROR_KEY, '');
      setSetting('online_single_backfill_done', '1');
    });
  } catch (e) {
    const out = { ran: false, reason: 'error', error: errMsg(e) };
    // 交易失敗 → 剛做的快照沒有用了，刪掉（否則每次開機多一份整庫複本）。刪除本身失敗不能蓋掉原本的錯誤。
    if (snapFile) {
      let removed = false;
      try { removed = removeSnapshot(snapFile) === true; } catch { removed = false; }
      if (!removed) out.snapshotLeft = snapFile;
    }
    return out;
  }
  return { ran: true, ...summary };
}

/** 開機一次性補登。snapshot／removeSnapshot／listSnapshots 可注入（測試用）。
 *  任何失敗都不往外丟（不能擋住伺服器開機），回 { ran: false, reason, ... }；
 *  除了 reason 'done'，失敗原因另寫進 app_settings（online_single_backfill_error）。 */
export function backfillOnlineSingles({
  snapshot = () => runNamedSnapshot(SNAP_NAME),
  removeSnapshot = (file) => removeNamedSnapshot(file, SNAP_NAME),
  listSnapshots = () => listNamedSnapshots(SNAP_NAME),
} = {}) {
  let result;
  try {
    result = runBackfill({ snapshot, removeSnapshot, listSnapshots });
  } catch (e) {
    result = { ran: false, reason: 'error', error: errMsg(e) };
  }
  if (!result.ran && result.reason !== 'done') recordFailure(result);
  return result;
}
