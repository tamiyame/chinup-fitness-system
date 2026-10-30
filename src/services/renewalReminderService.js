// 堂數即將用完自動提醒：方案「尚餘」≤1 → 帶課教練＋管理者；團課未來正取合計剩最後 1 堂 → 會員。
// 每日 9 點掃描；renewal_reminders 去重（每狀態一次）。
// 規格：docs/superpowers/specs/2026-07-04-renewal-reminders-design.md
import { db, nowLocal } from '../db/connection.js';
import { notify, notifyAdmins, fmtDateForLine } from './notifications.js';
import { isLineNotifyEnabled } from './lineNotifyPolicy.js';

const SESSION_LABELS = { '1on1': '1對1', '1on2': '1對2' };

// 尚餘（我的課表口徑）＝ 未來 confirmed 預約 ＋（未過期 ? 未登錄餘額 : 0）
// 帶課教練：方案本身沒記教練，取此方案最後一筆 confirmed 預約的在職教練（沒有就只發管理者）
const lowPackagesStmt = db.prepare(`
  SELECT p.id, p.member_id, p.session_type, p.total_sessions, u.name AS member_name,
         (SELECT c.user_id FROM bookings b JOIN coaches c ON c.id = b.coach_id
           WHERE b.package_id = p.id AND b.status = 'confirmed' AND c.is_active = 1
           ORDER BY b.start_at DESC, b.id DESC LIMIT 1) AS coach_user_id,
         COALESCE(up.cnt, 0) +
         (CASE WHEN p.expires_at IS NULL OR p.expires_at >= ? THEN p.remaining_sessions ELSE 0 END) AS still
  FROM customer_packages p
  JOIN users u ON u.id = p.member_id
  LEFT JOIN (SELECT package_id, COUNT(*) AS cnt FROM bookings
              WHERE status = 'confirmed' AND package_id IS NOT NULL AND start_at >= ?
              GROUP BY package_id) up ON up.package_id = p.id
  WHERE p.archived_at IS NULL AND u.archived_at IS NULL
`);
// 未來正取團課合計恰 1 堂者（cnt=1 時 MIN 即該唯一場次的值）
const lastGroupStmt = db.prepare(`
  SELECT r.user_id AS member_id, COUNT(*) AS cnt,
         MIN(s.start_at) AS start_at, MIN(s.id) AS session_id, MIN(t.name) AS course_name
  FROM registrations r
  JOIN course_sessions s ON s.id = r.session_id
  JOIN course_templates t ON t.id = s.template_id
  WHERE r.status = 'confirmed' AND s.status != 'cancelled' AND s.start_at >= ?
  GROUP BY r.user_id
  HAVING cnt = 1
`);
const hasMarker = db.prepare('SELECT 1 FROM renewal_reminders WHERE kind = ? AND member_id = ? AND ref_id = ? LIMIT 1');
const insertMarker = db.prepare('INSERT OR IGNORE INTO renewal_reminders (kind, member_id, ref_id) VALUES (?, ?, ?)');
const claimRecheck = db.prepare("INSERT OR IGNORE INTO app_settings (key, value) VALUES ('renewal_recheck_10_done', '1')");

const sessionLabel = (type) => SESSION_LABELS[type] || type;

/** 每日掃描（cron 9:00）。回 { packagesSent, groupSent } 供 log。 */
export function processRenewalReminders(now = nowLocal()) {
  const today = String(now).slice(0, 10);
  let packagesSent = 0, groupSent = 0;

  for (const p of lowPackagesStmt.all(today, now)) {
    if (!(p.still > 0 && p.still <= 1)) continue;
    if (hasMarker.get('package', p.member_id, p.id)) continue;
    if (!insertMarker.run('package', p.member_id, p.id).changes) continue;
    const vars = { member_name: p.member_name, session_type_label: sessionLabel(p.session_type), total: p.total_sessions, remaining: p.still };
    if (p.coach_user_id) notify({ userId: p.coach_user_id, sessionId: null, type: 'package_low_sessions', vars });
    notifyAdmins({ type: 'package_low_sessions', excludeUserIds: [p.member_id, p.coach_user_id].filter(Boolean), vars });
    packagesSent++;
  }

  for (const g of lastGroupStmt.all(now)) {
    if (hasMarker.get('group', g.member_id, g.session_id)) continue;
    if (!insertMarker.run('group', g.member_id, g.session_id).changes) continue;
    notify({ userId: g.member_id, sessionId: g.session_id, type: 'group_last_session',
      vars: { course_name: g.course_name, start_at: fmtDateForLine(g.start_at) } });
    groupSent++;
  }

  return { packagesSent, groupSent };
}

/**
 * 一次性：續購提醒改發員工時，重新檢查全部 10 堂方案，把尚餘 1 堂的客人列成一則發給管理者。
 * 不看 renewal_reminders（之前已提醒過會員的也要列入）。沒有符合者也發一則，管理者才知道檢查過了。
 * LINE 關閉時不發也不佔旗標，開啟後由開機或 9 點排程補上。回 { count }，沒執行回 null。
 */
export function recheckTenSessionPackagesOnce(now = nowLocal()) {
  if (!isLineNotifyEnabled('package_low_recheck')) return null;
  const hits = lowPackagesStmt.all(String(now).slice(0, 10), now)
    .filter((p) => p.total_sessions === 10 && p.still === 1);
  if (!claimRecheck.run().changes) return null;

  const count = new Set(hits.map((p) => p.member_id)).size;
  const summary = hits.length
    ? `目前有 ${count} 位客人的 10 堂方案只剩 1 堂：\n${hits.map((p) => `・${p.member_name}（${sessionLabel(p.session_type)}）`).join('\n')}`
    : '目前沒有客人的 10 堂方案只剩 1 堂。';
  notifyAdmins({ type: 'package_low_recheck', vars: { summary } });
  return { count };
}
