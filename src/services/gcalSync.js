// Google 日曆同步層：事件生命週期（冪等）、freebusy busy → 台北牆鐘、reconcile 兜底。
// DB 是唯一事實來源；日曆寫入失敗不影響預約（cron 補齊）。
import { db } from '../db/connection.js';
import { getGcalCalendarId } from './discountService.js';
import { freeBusy, insertEvent, deleteEvent } from './gcalClient.js';

const SESSION_LABELS = { '1on1': '1對1', '1on2': '1對2' };

export function isGcalEnabled() {
  if (!getGcalCalendarId()) return false;
  return !!process.env.GCAL_MOCK || !!process.env.GCAL_SERVICE_ACCOUNT_JSON;
}

/** 決定性事件 ID（Calendar id 限 base32hex：a-v0-9、長度≥5）。'chinupbk' 全字元合法。 */
export function eventIdForBooking(bookingId) {
  return 'chinupbk' + String(bookingId).padStart(9, '0');
}

const getBookingFull = db.prepare(`
  SELECT b.*, c.display_name AS coach_name, u.name AS member_name, u.phone AS member_phone
  FROM bookings b JOIN coaches c ON c.id = b.coach_id JOIN users u ON u.id = b.member_id
  WHERE b.id = ?
`);
const setEventId = db.prepare('UPDATE bookings SET gcal_event_id = ? WHERE id = ?');

/** 組事件 body。transparency='transparent'（顯示「有空」）是關鍵：freebusy 只會
 *  抓到店家手動建立（預設忙碌）的活動，系統自己的預約不會誤鎖其他教練的同時段。 */
export function buildEventBody(bookingId) {
  const b = getBookingFull.get(bookingId);
  if (!b) return null;
  const label = SESSION_LABELS[b.session_type] || '1對1';
  const amount = b.original_amount != null
    ? (b.discount_amount ? b.original_amount - b.discount_amount : b.original_amount)
    : null;
  const lines = [
    `電話：${b.member_phone || '-'}`,
    `方案：${label}`,
    amount != null ? `金額：$${amount}${b.discount_code ? `（折扣碼 ${b.discount_code}）` : ''}` : null,
    `預約編號：#${b.id}`,
    '（chinup 系統自動建立。可直接拖動改時段：需整點起、60 分鐘、未來時段；刪除事件＝取消預約並回補堂數）',
  ].filter(Boolean);
  return {
    id: eventIdForBooking(b.id),
    summary: `${label}教練課 ${b.coach_name}×${b.member_name}`,
    description: lines.join('\n'),
    start: { dateTime: `${b.start_at}+08:00`, timeZone: 'Asia/Taipei' },
    end: { dateTime: `${b.end_at}+08:00`, timeZone: 'Asia/Taipei' },
    transparency: 'transparent',
  };
}

/** 預約成立後呼叫（commit 後、不 await）。失敗交給 reconcile cron。 */
export async function syncBookingCreate(bookingId) {
  try {
    if (!isGcalEnabled()) return;
    const body = buildEventBody(bookingId);
    if (!body) return;
    const r = await insertEvent(getGcalCalendarId(), body);
    if (r.ok) setEventId.run(body.id, bookingId);
    else console.error('[gcal] insertEvent failed:', bookingId, r.error);
  } catch (e) { console.error('[gcal] syncBookingCreate threw:', e); }
}

/** 取消後呼叫（commit 後、不 await）。用決定性 ID，gcal_event_id 遺失也刪得掉。 */
export async function syncBookingCancel(bookingId) {
  try {
    if (!isGcalEnabled()) return;
    const r = await deleteEvent(getGcalCalendarId(), eventIdForBooking(bookingId));
    if (r.ok) setEventId.run(null, bookingId);
    else console.error('[gcal] deleteEvent failed:', bookingId, r.error);
  } catch (e) { console.error('[gcal] syncBookingCancel threw:', e); }
}

// ── freebusy → 台北牆鐘區間 ───────────────────────────────────────────
// 不依賴伺服器 TZ：epoch + 8h 後取 UTC 分量 = 台北牆鐘（台灣無 DST）。
function taipeiParts(iso) {
  const d = new Date(new Date(iso).getTime() + 8 * 3600_000);
  const pad = (n) => String(n).padStart(2, '0');
  return {
    date: `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`,
    hhmm: `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`,
    ms: d.getTime(),
  };
}

/** RFC3339 busy 區間 → Map<'YYYY-MM-DD', [{start:'HH:MM', end:'HH:MM'}]>（跨日切割；
 *  迄於翌日 00:00 的段落以 end='24:00' 表示，與 slot 過濾的 toMin 相容）。 */
export function busyToWallClockMap(busyList) {
  const map = new Map();
  const push = (date, start, end) => {
    if (start === end) return;
    if (!map.has(date)) map.set(date, []);
    map.get(date).push({ start, end });
  };
  for (const b of busyList || []) {
    let s = taipeiParts(b.start);
    const e = taipeiParts(b.end);
    while (s.date < e.date) {
      push(s.date, s.hhmm, '24:00');
      const next = new Date(s.ms);
      next.setUTCDate(next.getUTCDate() + 1);
      next.setUTCHours(0, 0, 0, 0);
      const pad = (n) => String(n).padStart(2, '0');
      s = { date: `${next.getUTCFullYear()}-${pad(next.getUTCMonth() + 1)}-${pad(next.getUTCDate())}`, hhmm: '00:00', ms: next.getTime() };
    }
    push(e.date, s.hhmm, e.hhmm);
  }
  return map;
}

// 60 秒 freebusy 快取（單副本假設）
const _fbCache = new Map(); // key → { at, value }
const FB_TTL_MS = 60_000;

/** 路由層用：取 [fromDate, toDate]（含）之外部忙碌區間。停用或失敗 → null（fail-open）。 */
export async function getExternalBusySafe(fromDate, toDate) {
  try {
    if (!isGcalEnabled()) return null;
    const calId = getGcalCalendarId();
    const key = `${calId}|${fromDate}|${toDate}`;
    const hit = _fbCache.get(key);
    if (hit && Date.now() - hit.at < FB_TTL_MS) return hit.value;
    // timeMax 用 toDate 翌日 00:00（+08:00）
    const d = new Date(toDate + 'T00:00:00');
    d.setDate(d.getDate() + 1);
    const pad = (n) => String(n).padStart(2, '0');
    const nextDate = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
    const r = await freeBusy(calId, `${fromDate}T00:00:00+08:00`, `${nextDate}T00:00:00+08:00`);
    if (!r.ok) { console.error('[gcal] freebusy failed (fail-open):', r.error); return null; }
    const value = busyToWallClockMap(r.busy);
    _fbCache.set(key, { at: Date.now(), value });
    return value;
  } catch (e) { console.error('[gcal] getExternalBusySafe threw (fail-open):', e); return null; }
}

// ── reconcile cron ────────────────────────────────────────────────────
const selToCreate = db.prepare(`
  SELECT id FROM bookings
  WHERE status = 'confirmed' AND gcal_event_id IS NULL AND start_at >= ?
  ORDER BY start_at ASC LIMIT 20
`);
const selToDelete = db.prepare(`
  SELECT id FROM bookings
  WHERE status = 'cancelled' AND gcal_event_id IS NOT NULL
  ORDER BY id ASC LIMIT 20
`);

let _reconcileRunning = false; // node-cron 不序列化重疊執行（單執行緒 boolean 即安全）

export async function reconcile() {
  if (_reconcileRunning) return;
  _reconcileRunning = true;
  try {
    if (!isGcalEnabled()) return;
    const pad = (n) => String(n).padStart(2, '0');
    const now = new Date();
    const nowStr = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}T${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
    for (const row of selToCreate.all(nowStr)) await syncBookingCreate(row.id);
    for (const row of selToDelete.all()) await syncBookingCancel(row.id);
  } finally { _reconcileRunning = false; }
}

/** 長區間（循環預約）用：以 30 天分段查 freebusy 後合併（freebusy 對長區間有限制）。
 *  停用或任一段失敗 → null（fail-open，與單筆行為一致）。 */
export async function getExternalBusyChunkedSafe(fromDate, toDate) {
  if (!isGcalEnabled()) return null;
  const out = new Map();
  const pad = (n) => String(n).padStart(2, '0');
  const fmt = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  let cur = new Date(fromDate + 'T00:00:00');
  const end = new Date(toDate + 'T00:00:00');
  while (cur <= end) {
    const chunkEnd = new Date(Math.min(cur.getTime() + 29 * 86400_000, end.getTime()));
    const m = await getExternalBusySafe(fmt(cur), fmt(chunkEnd));
    if (m === null) return null;
    for (const [k, v] of m) out.set(k, (out.get(k) || []).concat(v));
    cur = new Date(chunkEnd.getTime() + 86400_000);
  }
  return out;
}
