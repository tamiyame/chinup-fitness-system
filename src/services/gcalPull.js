// Google 日曆反向同步（拉回）：syncToken 增量輪詢，把日曆上對系統事件的人為異動套回系統。
// 政策：衝突 DB 贏（退回＋通知教練）；刪除＝自動取消（不分過去未來堂；回補、通知管理者、不通知客人）；
// 移動＝驗證後套用改期（過去堂亦連動；僅未來堂禁止移入過去）。
// 規格：docs/superpowers/specs/2026-07-04-gcal-pull-sync-design.md
//       docs/superpowers/specs/2026-08-12-gcal-past-session-sync-design.md（過去堂連動翻轉）
import { db, nowLocal } from '../db/connection.js';
import { getSetting, setSetting, getGcalCalendarId } from './discountService.js';
import { listEvents, updateEvent, deleteEvent } from './gcalClient.js';
import { isGcalEnabled, eventIdForBooking, buildEventBody } from './gcalSync.js';
import { rescheduleBooking, cancelBookingFromGcal } from './bookingService.js';
import { notify, notifyAdmins, fmtDateForLine } from './notifications.js';

const EV_ID_RE = /^chinupbk(\d{9})$/;
const TOKEN_KEY = 'gcal_sync_token';
const MAX_PAGES_PER_TICK = 10;

const getBookingForPull = db.prepare(`
  SELECT b.id, b.status, b.start_at, b.end_at, b.member_id, b.package_id,
         c.user_id AS coach_user_id, c.display_name AS coach_name, u.name AS member_name
  FROM bookings b JOIN coaches c ON c.id = b.coach_id JOIN users u ON u.id = b.member_id
  WHERE b.id = ?
`);

/** RFC3339 → 台北牆鐘 'YYYY-MM-DDTHH:MM:SS'（epoch+8h 取 UTC 分量；台灣無 DST）。無效回 null。 */
function isoToTaipei(iso) {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return null;
  const d = new Date(ms + 8 * 3600_000);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}T${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
}

// token 綁定日曆 ID：管理者換日曆 → token 自動失效、重建基準
function loadToken(calId) {
  try {
    const raw = getSetting(TOKEN_KEY);
    if (!raw) return null;
    const o = JSON.parse(raw);
    return o && o.calId === calId ? o.token : null;
  } catch { return null; }
}
const saveToken = (calId, token) => setSetting(TOKEN_KEY, JSON.stringify({ calId, token }));
const clearToken = () => setSetting(TOKEN_KEY, '');

function baselineTimeMin() {
  const d = new Date(Date.now() - 86_400_000 + 8 * 3600_000);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}T00:00:00+08:00`;
}

/** 退回：事件改回 DB 時間；成功才通知教練（失敗只 log，下個 tick 事件仍不一致會再試，不洗版）。 */
async function revertEvent(calId, b, reason) {
  const body = buildEventBody(b.id);
  if (!body) return;
  const r = await updateEvent(calId, eventIdForBooking(b.id), body);
  if (!r.ok) { console.error('[gcal-pull] revert failed:', b.id, r.error); return; }
  notify({ userId: b.coach_user_id, sessionId: null, type: 'gcal_move_rejected',
    vars: { member_name: b.member_name, start_at: fmtDateForLine(b.start_at), reason } });
}

/** 單一事件分類與套用（基準/增量共用；冪等）。exported 供測試。 */
export async function processEvent(ev, calId) {
  const m = EV_ID_RE.exec(ev?.id || '');
  if (!m) return;                                                  // 非系統事件 → 忽略
  const b = getBookingForPull.get(Number(m[1]));
  if (!b) return;
  const now = nowLocal();

  if (ev.status === 'cancelled') {                                 // 日曆上被刪
    if (b.status === 'cancelled') return;                          // 系統自刪的回聲
    const r = cancelBookingFromGcal(b.id);
    if (!r.ok) return;
    notifyAdmins({ type: 'gcal_delete_cancelled', vars: {
      coach_display_name: r.coachName, member_name: r.memberName,
      start_at: fmtDateForLine(r.startAt), refund_note: r.refunded ? '，方案已回補 1 堂' : '' } });
    return;
  }

  if (b.status === 'cancelled') {                                  // 已取消卻被「復原刪除」→ DB 贏，再刪
    await deleteEvent(calId, eventIdForBooking(b.id));
    return;
  }

  const evStart = ev.start?.dateTime ? isoToTaipei(ev.start.dateTime) : null;
  const evEnd = ev.end?.dateTime ? isoToTaipei(ev.end.dateTime) : null;
  if (!evStart || !evEnd) {                                        // 被改成全天/格式壞 → 退回
    await revertEvent(calId, b, '格式不支援（全天事件）');
    return;
  }
  if (evStart === b.start_at && evEnd === b.end_at) return;        // 與 DB 一致（回聲）

  if (b.start_at > now && evStart <= now) return revertEvent(calId, b, '不可移到過去'); // 僅未來堂禁止移入過去
  const startMs = Date.parse(ev.start.dateTime);
  const endMs = Date.parse(ev.end.dateTime);
  if (startMs % 3600_000 !== 0 || endMs - startMs !== 3600_000) {
    return revertEvent(calId, b, '需為整點起、60 分鐘');
  }
  try {
    rescheduleBooking({ bookingId: b.id, newStartAt: evStart, actorUserId: null, isAdmin: true });
    // 成功：rescheduleBooking 已通知客人；事件時間即新 DB 時間，無需回寫
  } catch (e) {
    const reason = e?.message === 'slot_taken' ? '時段衝突' : `無法套用（${e?.message || 'unknown'}）`;
    return revertEvent(calId, b, reason);
  }
}

let _pullRunning = false; // node-cron 不序列化重疊執行（單執行緒 boolean 即安全）

/** 每分鐘 cron 進入點：無 token → 基準同步（timeMin=昨天、showDeleted）；有 → 增量；410 → 重基準一次。 */
export async function pullChanges() {
  if (_pullRunning) return;
  _pullRunning = true;
  try {
    if (!isGcalEnabled()) return;
    const calId = getGcalCalendarId();
    let token = loadToken(calId);

    for (let attempt = 0; attempt < 2; attempt++) {
      const base = token
        ? { syncToken: token, maxResults: '250' }
        : { timeMin: baselineTimeMin(), showDeleted: 'true', maxResults: '250' };
      let pageToken = null;
      let newSyncToken = null;
      let gone = false;
      for (let page = 0; page < MAX_PAGES_PER_TICK; page++) {
        const r = await listEvents(calId, pageToken ? { ...base, pageToken } : base);
        if (!r.ok) {
          if (r.status === 410) { gone = true; break; }            // token 過期 → 重基準
          console.error('[gcal-pull] listEvents failed:', r.error);
          return;                                                  // 暫時性錯誤：下個 tick 重來
        }
        for (const ev of r.items || []) {
          try { await processEvent(ev, calId); }
          catch (e) { console.error('[gcal-pull] processEvent threw:', ev?.id, e); }
        }
        if (r.nextPageToken) { pageToken = r.nextPageToken; continue; }
        newSyncToken = r.nextSyncToken || null;
        break;                                                     // 末頁（或超頁保險）
      }
      if (gone) { clearToken(); token = null; continue; }          // 立刻重跑基準
      if (newSyncToken) saveToken(calId, newSyncToken);
      return;
    }
  } catch (e) { console.error('[gcal-pull] pullChanges threw:', e); }
  finally { _pullRunning = false; }
}
