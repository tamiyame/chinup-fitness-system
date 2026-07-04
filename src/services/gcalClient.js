// Google Calendar API v3 thin wrapper（零 npm 依賴）。
// never-throws、回傳 { ok, ... }。GCAL_MOCK=1 → 成功並記錄到 __mockCalls（測試檢查用）；
// GCAL_MOCK='fail' → { ok:false }。
import { getCalendarToken } from './googleAuth.js';

const BASE = 'https://www.googleapis.com/calendar/v3';
export const __mockCalls = []; // 測試專用：GCAL_MOCK=1 時記錄 { fn, args }
export const __mockListQueue = []; // 測試專用：GCAL_MOCK=1 時 listEvents 依序 shift 假回應
export const __mockUpdateQueue = []; // 測試專用：GCAL_MOCK=1 時 updateEvent 依序 shift 假回應（空 → {ok:true}）

async function authedFetch(url, options = {}) {
  const t = await getCalendarToken();
  if (!t.ok) return { ok: false, status: 0, error: t.error };
  try {
    const res = await fetch(url, {
      ...options,
      headers: { Authorization: `Bearer ${t.token}`, 'Content-Type': 'application/json', ...(options.headers || {}) },
    });
    const text = await res.text().catch(() => '');
    let data = null; try { data = text ? JSON.parse(text) : null; } catch { data = text; }
    if (res.ok) return { ok: true, status: res.status, data };
    return { ok: false, status: res.status, error: `HTTP ${res.status}: ${String(text).slice(0, 200)}`, data };
  } catch (e) {
    return { ok: false, status: 0, error: `network: ${e.message}` };
  }
}

function mock(fn, args, result = { ok: true }) {
  __mockCalls.push({ fn, args });
  return result;
}

/** freebusy 查詢。timeMin/timeMax 為 RFC3339（含 +08:00）。回 { ok, busy: [{start,end}] }（RFC3339）。 */
export async function freeBusy(calendarId, timeMin, timeMax) {
  if (process.env.GCAL_MOCK === '1') return mock('freeBusy', { calendarId, timeMin, timeMax }, { ok: true, busy: [] });
  if (process.env.GCAL_MOCK === 'fail') return { ok: false, error: 'mock_fail' };
  const r = await authedFetch(`${BASE}/freeBusy`, {
    method: 'POST',
    body: JSON.stringify({ timeMin, timeMax, timeZone: 'Asia/Taipei', items: [{ id: calendarId }] }),
  });
  if (!r.ok) return r;
  const cal = r.data?.calendars?.[calendarId];
  if (cal?.errors?.length) return { ok: false, error: `freebusy: ${JSON.stringify(cal.errors).slice(0, 200)}` };
  return { ok: true, busy: cal?.busy || [] };
}

/** 建立事件（冪等：body.id 為決定性 ID）。409（ID 已存在/曾被刪）→ 改走 update 復活。 */
export async function insertEvent(calendarId, event) {
  if (process.env.GCAL_MOCK === '1') return mock('insertEvent', { calendarId, event });
  if (process.env.GCAL_MOCK === 'fail') return { ok: false, error: 'mock_fail' };
  const cal = encodeURIComponent(calendarId);
  const r = await authedFetch(`${BASE}/calendars/${cal}/events`, { method: 'POST', body: JSON.stringify(event) });
  if (r.ok) return { ok: true };
  if (r.status === 409) {
    const u = await authedFetch(`${BASE}/calendars/${cal}/events/${encodeURIComponent(event.id)}`, {
      method: 'PUT',
      body: JSON.stringify({ ...event, status: 'confirmed' }),
    });
    return u.ok ? { ok: true } : u;
  }
  return r;
}

/** 刪除事件。404/410（已不存在）視為成功。 */
export async function deleteEvent(calendarId, eventId) {
  if (process.env.GCAL_MOCK === '1') return mock('deleteEvent', { calendarId, eventId });
  if (process.env.GCAL_MOCK === 'fail') return { ok: false, error: 'mock_fail' };
  const r = await authedFetch(
    `${BASE}/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`,
    { method: 'DELETE' }
  );
  if (r.ok || r.status === 404 || r.status === 410) return { ok: true };
  return r;
}

/** 列事件（反向同步用）。params 為 query 物件（syncToken/pageToken/timeMin/showDeleted/maxResults…）。
 *  回 { ok, items, nextPageToken, nextSyncToken }；410（syncToken 過期）由 status 辨識。 */
export async function listEvents(calendarId, params = {}) {
  if (process.env.GCAL_MOCK === '1') {
    const result = __mockListQueue.length
      ? __mockListQueue.shift()
      : { ok: true, items: [], nextPageToken: null, nextSyncToken: 'mock-token' };
    return mock('listEvents', { calendarId, params }, result);
  }
  if (process.env.GCAL_MOCK === 'fail') return { ok: false, error: 'mock_fail' };
  const qs = new URLSearchParams(params).toString();
  const r = await authedFetch(`${BASE}/calendars/${encodeURIComponent(calendarId)}/events?${qs}`);
  if (!r.ok) return r;
  return {
    ok: true,
    items: r.data?.items || [],
    nextPageToken: r.data?.nextPageToken || null,
    nextSyncToken: r.data?.nextSyncToken || null,
  };
}

/** 更新事件（退回移動／理論復活用）。body 併 status:'confirmed'。 */
export async function updateEvent(calendarId, eventId, event) {
  if (process.env.GCAL_MOCK === '1') {
    const result = __mockUpdateQueue.length ? __mockUpdateQueue.shift() : { ok: true };
    return mock('updateEvent', { calendarId, eventId, event }, result);
  }
  if (process.env.GCAL_MOCK === 'fail') return { ok: false, error: 'mock_fail' };
  const r = await authedFetch(
    `${BASE}/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`,
    { method: 'PUT', body: JSON.stringify({ ...event, status: 'confirmed' }) }
  );
  return r.ok ? { ok: true } : r;
}
