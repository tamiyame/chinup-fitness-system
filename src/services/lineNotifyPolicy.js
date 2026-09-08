// LINE 推播開關：總開關＋依事件分 3 組 16 項。所有 LINE 推播共用 notify() 一個入口，
// 本檔只回答「這個 type 現在可不可以推 LINE」（關閉時 notify() 走只記錄路徑）。
// 設定存 app_settings：line_notify_master（未設定＝OFF）、line_notify_<item>（未設定＝ON）。
// 不 import discountService.js：它經 registration.js → notifications.js 回頭 import 本檔會循環，
// 語句自備。ApiError 只在函式呼叫時取用，經 registration.js 的間接循環對此安全。
import { db, tx } from '../db/connection.js';
import { ApiError } from './registration.js';

export const LINE_NOTIFY_GROUPS = [
  { key: 'one_on_one', label: '一對一教練課', items: [
    { key: 'booking_new', label: '新預約', recipients: '教練＋管理者', types: ['booking_created'] },
    { key: 'booking_confirmed_member', label: '預約成功', recipients: '會員', types: ['booking_confirmed'] },
    { key: 'booking_recurring', label: '循環登錄排定', recipients: '會員摘要＋教練', types: ['booking_recurring_created', 'booking_recurring_created_coach'] },
    { key: 'booking_payment', label: '款項已確認', recipients: '會員', types: ['booking_payment_received'] },
    { key: 'booking_reschedule', label: '改期', recipients: '會員＋教練', types: ['booking_rescheduled', 'booking_rescheduled_coach'] },
    { key: 'booking_cancel_member', label: '預約取消／退款', recipients: '會員', types: ['booking_cancelled_by_coach', 'booking_cancelled_by_shop', 'booking_refunded'] },
    { key: 'booking_cancel_coach', label: '預約取消', recipients: '教練', types: ['booking_cancelled_by_member', 'booking_cancelled_by_shop_coach'] },
  ] },
  { key: 'group', label: '團體課程', items: [
    { key: 'group_payment', label: '匯款已收到', recipients: '會員', types: ['payment_received'] },
    { key: 'group_registered_staff', label: '新報名', recipients: '教練＋管理者', types: ['course_registered_coach', 'course_registered_coach_batch', 'course_registered_admin', 'course_registered_admin_batch'] },
    { key: 'group_waitlist', label: '候補與遞補', recipients: '候補會員＋教練', types: ['group_promoted', 'course_waitlisted_coach', 'course_promoted_coach'] },
    { key: 'group_member_cancel_coach', label: '會員取消／請假', recipients: '教練', types: ['course_member_cancelled_coach', 'course_member_leave_coach'] },
    { key: 'group_session_outcome', label: '成班／未開課判定', recipients: '教練＋未開課會員', types: ['course_confirmed_coach', 'course_cancelled_coach', 'course_cancelled'] },
    { key: 'group_refund', label: '訂單退款', recipients: '會員', types: ['group_order_refunded'] },
  ] },
  { key: 'system', label: '排程與系統', items: [
    { key: 'renewal_reminder', label: '續購提醒', recipients: '會員', types: ['package_low_sessions', 'group_last_session'] },
    { key: 'gcal_sync', label: 'Google 日曆同步', recipients: '教練退回＋管理者取消', types: ['gcal_move_rejected', 'gcal_delete_cancelled'] },
    { key: 'period_rollover', label: '期課續期', recipients: '管理者', types: ['period_rollover_admin'] },
  ] },
];

const MASTER_KEY = 'line_notify_master';
const itemSettingKey = (itemKey) => `line_notify_${itemKey}`;

const TYPE_TO_ITEM = new Map();
const ITEM_KEYS = new Set();
for (const g of LINE_NOTIFY_GROUPS) {
  for (const it of g.items) {
    ITEM_KEYS.add(it.key);
    for (const t of it.types) TYPE_TO_ITEM.set(t, it.key);
  }
}

const getStmt = db.prepare('SELECT value FROM app_settings WHERE key = ?');
const setStmt = db.prepare('INSERT INTO app_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');

function readFlag(key, fallback) {
  const row = getStmt.get(key);
  return row ? row.value === '1' : fallback;
}
const isMasterOn = () => readFlag(MASTER_KEY, false);
const isItemOn = (itemKey) => readFlag(itemSettingKey(itemKey), true);

/** 該通知 type 現在可否推 LINE。不在目錄的 type（legacy／已停用模板）只受總開關管。 */
export function isLineNotifyEnabled(type) {
  if (!isMasterOn()) return false;
  const itemKey = TYPE_TO_ITEM.get(type);
  return itemKey ? isItemOn(itemKey) : true;
}

export function getLineNotifyState() {
  return {
    master: isMasterOn(),
    groups: LINE_NOTIFY_GROUPS.map((g) => ({
      key: g.key,
      label: g.label,
      items: g.items.map((it) => ({ key: it.key, label: it.label, recipients: it.recipients, enabled: isItemOn(it.key) })),
    })),
  };
}

/** 先全部驗證再一次寫入（同 /api/admin/settings 的「全通過才寫」原則）。 */
export function setLineNotifyState({ master, items } = {}) {
  const writes = [];
  if (master !== undefined) {
    if (typeof master !== 'boolean') throw new ApiError(400, 'invalid_line_notify_master');
    writes.push([MASTER_KEY, master ? '1' : '0']);
  }
  if (items !== undefined) {
    if (!items || typeof items !== 'object' || Array.isArray(items)) throw new ApiError(400, 'invalid_line_notify_item');
    for (const [key, value] of Object.entries(items)) {
      if (!ITEM_KEYS.has(key)) throw new ApiError(400, 'invalid_line_notify_item');
      if (typeof value !== 'boolean') throw new ApiError(400, 'invalid_line_notify_value');
      writes.push([itemSettingKey(key), value ? '1' : '0']);
    }
  }
  tx(() => { for (const [k, v] of writes) setStmt.run(k, v); });
  return getLineNotifyState();
}
