// Phase 3C notifications dispatcher.
// Single entry point notify({ userId, type, vars }) — internally picks
// a delivery channel based on the user's binding state:
//   user.line_user_id present → LINE Push (via lineClient.sendMessage)
//   otherwise                  → console.log fallback (dev / unbound user)
//
// Failed LINE pushes are stored with status='failed' + a backoff schedule
// and retried by processFailedNotifications() (called from scheduler cron).
import { db, nowLocal, offsetLocal } from '../db/connection.js';
import { sendMessage } from './lineClient.js';
import { sendMail as sendGmail } from './gmailClient.js';

// ─────────────────────────────────────────────────────────────────────
// Templates
// ─────────────────────────────────────────────────────────────────────

const TEMPLATES = {
  // === existing 7 (group class) ===
  registered_confirmed: {
    subject: '報名成功 - {{course_name}}',
    body: '您已成功報名 {{course_name}}（{{start_at}}），期待與您相見！',
  },
  registered_waitlisted: {
    subject: '已進候補 - {{course_name}}',
    body: '您報名的 {{course_name}} 目前已額滿，您為候補第 {{position}} 位。如有正取取消將自動遞補並另行通知。',
  },
  promoted: {
    subject: '恭喜遞補成功 - {{course_name}}',
    body: '您候補的 {{course_name}}（{{start_at}}）有人取消，您已遞補為正取。',
  },
  course_confirmed: {
    subject: '課程成立 - {{course_name}}',
    body: '{{course_name}}（{{start_at}}）已達開課人數，課程確認開課。',
  },
  course_cancelled: {
    subject: '課程取消 - {{course_name}}',
    body: '很抱歉，{{course_name}}（{{start_at}}）因未達開課人數，本次取消。',
  },
  reminder: {
    subject: '上課提醒 - {{course_name}}',
    body: '提醒您，{{course_name}} 將於 {{start_at}} 開始，請準時抵達。',
  },
  registration_cancelled: {
    subject: '報名已取消 - {{course_name}}',
    body: '您已成功取消 {{course_name}}（{{start_at}}）的報名。',
  },

  // === new 4 (Phase 3C, 1-on-1 booking) ===
  booking_created: {  // 寄給教練
    subject: '新一對一預約 - {{member_name}}',
    body: '🏋️ {{member_name}} 預約了 {{start_at}} 的一對一課程。',
  },
  booking_confirmed: {  // 寄給會員
    subject: '一對一預約成功 - {{coach_display_name}}',
    body: '✅ 已成功預約 {{coach_display_name}} 教練的 {{start_at}} 課程。',
  },
  booking_rescheduled: {  // 寄給會員（教練/管理者改期）
    subject: '預約時間已更新 - {{coach_display_name}}',
    body: '🔄 您與 {{coach_display_name}} 教練的課程已改至 {{start_at}}，請留意新的上課時間。',
  },
  booking_rescheduled_coach: {  // 寄給教練（改期成功；系統內改期排除操作者本人、gcal 拖拉一律發）
    subject: '預約時間已更新 - {{member_name}}',
    body: '🔄 {{member_name}} 的一對一預約已從 {{old_start_at}} 改至 {{start_at}}。',
  },
  booking_cancelled_by_member: {  // 寄給教練
    subject: '會員取消預約 - {{member_name}}',
    body: '⚠️ {{member_name}} 取消了 {{start_at}} 的一對一預約。',
  },
  booking_cancelled_by_coach: {  // 寄給會員
    subject: '教練取消預約 - {{coach_display_name}}',
    body: '⚠️ {{coach_display_name}} 教練取消了你 {{start_at}} 的預約，點數已退回。',
  },
  booking_payment_received: {  // 寄給會員（admin 核對教練課款項後）
    subject: '款項已確認 - {{coach_display_name}}',
    body: '✅ 已收到您的款項，{{coach_display_name}} 教練 {{start_at}} 的課程預約確認成立，期待見到您！',
  },
  booking_cancelled_by_shop: {  // 寄給會員（店家於後台取消教練課預約）
    subject: '預約已取消 - {{coach_display_name}}',
    body: '⚠️ 很抱歉，您 {{start_at}} 與 {{coach_display_name}} 教練的課程預約已由店家取消{{reason_suffix}}，如有疑問請與我們聯繫。',
  },
  booking_cancelled_by_shop_coach: {  // 寄給教練（店家於後台取消其教練課預約）
    subject: '預約已取消 - {{member_name}}',
    body: '⚠️ {{member_name}} {{start_at}} 的一對一預約已由店家取消。',
  },
  booking_refunded: {  // 寄給會員（店家取消已收款的教練課預約並退款）
    subject: '預約取消與退款 - {{coach_display_name}}',
    body: '✅ 您 {{start_at}} 與 {{coach_display_name}} 教練的課程預約已取消，款項{{amount_text}}將退還給您，請留意帳戶；若有疑問請與我們聯繫。',
  },
  group_order_refunded: {  // 寄給會員（店家取消已收款的團課訂單並退款）
    subject: '訂單取消與退款通知',
    body: '✅ 您的團課訂單{{amount_text}}已取消，款項將退還給您，請留意帳戶；若有疑問請與我們聯繫。',
  },
  booking_recurring_created: {  // 寄給會員（教練/管理者建立循環預約）
    subject: '已為您安排 {{count}} 堂課程 - {{coach_display_name}}',
    body: '✅ 已為您安排 {{count}} 堂 {{coach_display_name}} 教練課（{{freq_text}}），第一堂 {{first_at}}。可至「我的課表」查看全部場次。',
  },
  booking_recurring_created_coach: {  // 寄給教練/管理者（中性第三人稱）
    subject: '循環課程已排定 - {{member_name}}',
    body: '🏋️ {{member_name}} 的 {{count}} 堂循環課程已排定（{{freq_text}}），第一堂 {{first_at}}。',
  },

  // === new 2 (anon paid-group redesign) ===
  payment_received: {
    subject: '匯款已收到 - {{course_name}}',
    body: '✅ 已收到您的匯款，{{course_name}}（{{start_at}}）報名確認，期待見到您！',
  },
  group_promoted: {
    subject: '候補遞補成功 - {{course_name}}',
    body: '🎉 您候補的 {{course_name}}（{{start_at}}）有名額了！請於 24 小時內完成匯款以保留名額，並至「我的課表」查看。',
  },

  // === new 6 (團體課程事件 — 寄給該堂課教練) ===
  course_registered_coach: {
    subject: '新報名 - {{course_name}}',
    body: '🏋️ {{member_name}} 報名了你帶的「{{course_name}}」（{{start_at}}）。',
  },
  course_waitlisted_coach: {
    subject: '新候補 - {{course_name}}',
    body: '📋 {{member_name}} 候補了你帶的「{{course_name}}」（{{start_at}}）。',
  },
  course_promoted_coach: {
    subject: '候補遞補 - {{course_name}}',
    body: '⬆️ {{member_name}} 從候補遞補進你帶的「{{course_name}}」（{{start_at}}）。',
  },
  course_member_cancelled_coach: {
    subject: '會員取消報名 - {{course_name}}',
    body: '🚫 {{member_name}} 取消了你帶的「{{course_name}}」（{{start_at}}）報名。',
  },
  course_member_leave_coach: {
    subject: '會員請假 - {{course_name}}',
    body: '🏖️ {{member_name}} 請假，不會出席你帶的「{{course_name}}」（{{start_at}}）。',
  },
  course_confirmed_coach: {
    subject: '課程成班 - {{course_name}}',
    body: '✅ 你帶的「{{course_name}}」（{{start_at}}）已成班，共 {{count}} 人。',
  },
  course_cancelled_coach: {
    subject: '課程未開成 - {{course_name}}',
    body: '⚠️ 你帶的「{{course_name}}」（{{start_at}}）未達最低人數，未開成。',
  },

  // === new (團體課程 — 寄給店家管理者；中性第三人稱，不含「你帶的」) ===
  course_registered_admin: {
    subject: '新報名 - {{course_name}}',
    body: '🏋️ {{member_name}} 報名了「{{course_name}}」（{{start_at}}）。',
  },
  course_registered_coach_batch: {  // 寄給教練（一張訂單多堂彙整）
    subject: '新報名 - {{course_name}}',
    body: '🏋️ {{member_name}} 報名了你帶的「{{course_name}}」共 {{count}} 堂（{{date_list}}）。',
  },
  course_registered_admin_batch: {  // 寄給管理者（一張訂單多堂彙整、中性）
    subject: '新報名 - {{course_name}}',
    body: '🏋️ {{member_name}} 報名了「{{course_name}}」共 {{count}} 堂（{{date_list}}）。',
  },

  // === new 2（Google 日曆反向同步） ===
  gcal_move_rejected: {
    subject: 'Google 日曆移動已退回',
    body: '您在 Google 日曆上移動的預約已退回：{{member_name}} {{start_at}}。原因：{{reason}}。如需改期請於系統內操作。',
  },
  gcal_delete_cancelled: {
    subject: 'Google 日曆刪除 → 預約已取消',
    body: 'Google 日曆上的事件被刪除，系統已自動取消預約：{{coach_display_name}} × {{member_name}}（{{start_at}}）{{refund_note}}。',
  },

  // === new 2（堂數即將用完自動提醒） ===
  package_low_sessions: {
    subject: '方案堂數提醒',
    body: '提醒您：您的{{session_type_label}}方案還剩 {{remaining}} 堂課。歡迎向教練預約續購，讓訓練不中斷！',
  },
  group_last_session: {
    subject: '團體課報名提醒',
    body: '提醒您：您報名的團體課只剩最後一堂（{{course_name}}，{{start_at}}）。歡迎繼續報名之後的場次，我們課堂上見！',
  },
};

function render(template, vars) {
  return template.replace(/\{\{(\w+)\}\}/g, (_, k) => vars[k] ?? '');
}

// ─────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────

const DOW_SHORT = ['日', '一', '二', '三', '四', '五', '六'];

/**
 * Format a local-wall-clock datetime ('2026-05-20T14:30:00') for LINE:
 * "5/20（週三）14:30"
 */
export function fmtDateForLine(localStr) {
  // localStr is "YYYY-MM-DDTHH:MM:SS" — parse manually (don't rely on Date
  // timezone behavior since the stored value is wall-clock).
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(localStr || '');
  if (!m) return localStr || '';
  const [, , month, day, hh, mm] = m;
  // Compute day-of-week via UTC midnight (matches schedule.js convention)
  const dt = new Date(`${m[1]}-${month}-${day}T00:00:00Z`);
  const dow = DOW_SHORT[dt.getUTCDay()];
  return `${Number(month)}/${Number(day)}（週${dow}）${hh}:${mm}`;
}

// ─────────────────────────────────────────────────────────────────────
// Prepared statements
// ─────────────────────────────────────────────────────────────────────

const getUserById = db.prepare('SELECT id, line_user_id FROM users WHERE id = ?');
const getCoachUserId = db.prepare('SELECT user_id FROM coaches WHERE id = ?');
const getAdminUserIds = db.prepare('SELECT id FROM users WHERE is_admin = 1');

const insertNotif = db.prepare(`
  INSERT INTO notifications
    (user_id, session_id, type, channel, subject, body, status, retry_count, next_retry_at, last_error)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);

const selectDueFailed = db.prepare(`
  SELECT id, user_id, session_id, type, body, retry_count, channel, subject, recipient
  FROM notifications
  WHERE status = 'failed' AND next_retry_at <= ?
  ORDER BY next_retry_at ASC
  LIMIT 100
`);

const updateSent = db.prepare(`
  UPDATE notifications
  SET status = 'sent', next_retry_at = NULL, last_error = NULL
  WHERE id = ?
`);

const updateFailedAgain = db.prepare(`
  UPDATE notifications
  SET retry_count = ?, next_retry_at = ?, last_error = ?
  WHERE id = ?
`);

const updateFailedPermanent = db.prepare(`
  UPDATE notifications
  SET status = 'failed_permanent', next_retry_at = NULL, last_error = ?
  WHERE id = ?
`);

// ─────────────────────────────────────────────────────────────────────
// Retry policy
// ─────────────────────────────────────────────────────────────────────

const BACKOFF_MINUTES = [5, 15, 45];  // for retry_count 1, 2, 3
const MAX_RETRIES = 3;

function nextBackoffAt(newRetryCount) {
  const minutes = BACKOFF_MINUTES[newRetryCount - 1];
  return offsetLocal(minutes * 60 * 1000);
}

// ─────────────────────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────────────────────

// Re-entrancy guard: node-cron does NOT serialize overlapping invocations.
// Single Node process is single-threaded so a plain boolean is safe.
let _retryRunning = false;

/**
 * notify — single entry point used by all callers.
 * Fire-and-forget: returns undefined synchronously, async delivery
 * happens in background. Errors are swallowed (recorded in DB).
 *
 * @note For LINE-bound users, deliverLine runs OUTSIDE the caller's
 * transaction (so HTTP latency doesn't hold a DB lock). The notification
 * row INSERT therefore commits independently of the caller's tx. For
 * console fallback, the INSERT runs inside the caller's tx. Callers
 * should treat notify() as fire-after-commit semantically — invoke it
 * at the end of the tx (or after commit) to avoid sending a LINE
 * message for a transaction that later rolls back.
 */
export function notify({ userId, sessionId, type, vars = {} }) {
  const tpl = TEMPLATES[type];
  if (!tpl) throw new Error(`unknown notification type: ${type}`);

  const subject = render(tpl.subject, vars);
  const body = render(tpl.body, vars);

  const user = getUserById.get(userId);
  if (!user) return;  // deleted user → silent skip

  if (user.line_user_id) {
    // async — don't block caller. Caller (e.g. registration.js) is already
    // in a tx; we don't await so the tx isn't held open during the HTTP call.
    deliverLine({ userId, sessionId, type, subject, body, lineUserId: user.line_user_id })
      .catch((e) => console.error('[notify deliverLine threw]', e));
  } else {
    deliverConsole({ userId, sessionId, type, subject, body });
  }
}

/**
 * notifyCourseCoach — 通知某團體課程場次的「帶課教練」。
 * coachId 為 course_sessions.coach_id（= coaches.id）；解析出教練的 user 帳號後
 * 沿用 notify()（有綁 LINE 推 LINE，否則 console）。會員端通知不受影響。
 * 場次未指定教練（coachId 為空）或教練不存在時，靜默略過。
 */
export function notifyCourseCoach({ coachId, sessionId, type, vars = {} }) {
  if (!coachId) return;
  const row = getCoachUserId.get(coachId);
  if (!row) return;
  notify({ userId: row.user_id, sessionId, type, vars });
}

/**
 * notifyAdmins — 把同一則（第三人稱）通知廣播給所有店家管理者（admin / owner），
 * 讓店家掌握所有預約。沿用 notify()（各管理者有綁 LINE 推 LINE，否則 console）。
 * 無管理者時靜默略過。請傳「中性第三人稱」模板（勿用教練專屬「你帶的」文案）。
 */
export function notifyAdmins({ sessionId = null, type, vars = {}, excludeUserId = null, excludeUserIds = [] }) {
  const exclude = new Set(excludeUserIds);
  if (excludeUserId != null) exclude.add(excludeUserId);
  for (const row of getAdminUserIds.all()) {
    // 不把第三人稱訊息發給報名本人或已收到教練版的教練（即使本人剛好是管理者）。
    if (exclude.has(row.id)) continue;
    notify({ userId: row.id, sessionId, type, vars });
  }
}

async function deliverLine({ userId, sessionId, type, subject, body, lineUserId }) {
  const result = await sendMessage(lineUserId, body);
  if (result.ok) {
    insertNotif.run(userId, sessionId, type, 'line', subject, body, 'sent', 0, null, null);
  } else {
    insertNotif.run(
      userId, sessionId, type, 'line', subject, body,
      'failed', 0, offsetLocal(BACKOFF_MINUTES[0] * 60 * 1000), result.error
    );
  }
}

function deliverConsole({ userId, sessionId, type, subject, body }) {
  insertNotif.run(userId, sessionId, type, 'console', subject, body, 'sent', 0, null, null);
  console.log(`[notify→console] user=${userId} type=${type} ${subject}`);
}

/**
 * Cron worker. Picks failed rows whose next_retry_at is past, attempts
 * delivery via LINE, then updates status.
 */
export async function processFailedNotifications() {
  if (_retryRunning) return;
  _retryRunning = true;
  try {
    const due = selectDueFailed.all(nowLocal());

    for (const row of due) {
      let result;
      if (row.channel === 'email') {
        if (!row.recipient) { updateFailedPermanent.run('no_recipient', row.id); continue; }
        result = await sendGmail({ to: row.recipient, subject: row.subject || '通知', html: row.body || '' });
      } else {
        const user = getUserById.get(row.user_id);
        if (!user?.line_user_id) {
          // user removed binding (or was deleted) → no point retrying
          updateFailedPermanent.run('user_not_bound', row.id);
          continue;
        }
        result = await sendMessage(user.line_user_id, row.body);
      }

      if (result.ok) {
        updateSent.run(row.id);
      } else {
        const newRetryCount = row.retry_count + 1;
        if (newRetryCount > MAX_RETRIES) {
          updateFailedPermanent.run(result.error, row.id);
        } else {
          updateFailedAgain.run(newRetryCount, nextBackoffAt(newRetryCount), result.error, row.id);
        }
      }
    }
  } finally {
    _retryRunning = false;
  }
}
