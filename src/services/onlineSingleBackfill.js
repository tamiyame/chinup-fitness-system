// 開機一次性補登：把既有「沒有方案的未取消預約」各補一張線上單堂方案。
// 先快照、再單一交易寫入；任何失敗都不往外丟（不能擋住伺服器開機），回 { ran: false, reason }。
import { db, tx, nowLocal } from '../db/connection.js';
import { getSetting, setSetting } from './discountService.js';
import { createOnlineSingleForBooking } from './packageService.js';
import { runNamedSnapshot } from './backupService.js';

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

export function backfillOnlineSingles({ snapshot = () => runNamedSnapshot('pre-online-single') } = {}) {
  try {
    if (getSetting('online_single_backfill_done') === '1') return { ran: false, reason: 'done' };

    const rows = db.prepare("SELECT id, member_id, created_at FROM bookings WHERE status = 'confirmed' AND package_id IS NULL ORDER BY id").all();

    let snapFile = null;
    if (rows.length > 0) {
      // 快照在交易之前；失敗就什麼都不寫，下次開機重試。
      const snap = snapshot();
      if (!snap || snap.ok !== true) return { ran: false, reason: 'snapshot_failed' };
      snapFile = snap.file;
    }

    const at = nowLocal();
    const members = new Set(rows.map((r) => r.member_id));
    const summary = { created: rows.length, members: members.size, at, snapshot: snapFile };
    // 方案、旗標、摘要同一個交易：中途失敗全部回滾，沒有旗標，下次開機重跑。
    tx(() => {
      for (const r of rows) createOnlineSingleForBooking(r.id, { createdAt: utcToLocal(r.created_at) });
      setSetting('online_single_backfill_summary', JSON.stringify(summary));
      setSetting('online_single_backfill_done', '1');
    });
    return { ran: true, ...summary };
  } catch (e) {
    return { ran: false, reason: 'error', error: e && e.message ? e.message : String(e) };
  }
}
