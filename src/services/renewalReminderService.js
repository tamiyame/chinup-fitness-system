// 堂數即將用完自動提醒：方案「尚餘」≤1、團課未來正取合計剩最後 1 堂 → notify（LINE 優先）。
// 每日 9 點掃描；renewal_reminders 去重（每狀態一次）。
// 規格：docs/superpowers/specs/2026-07-04-renewal-reminders-design.md
import { db, nowLocal } from '../db/connection.js';
import { notify, fmtDateForLine } from './notifications.js';

const SESSION_LABELS = { '1on1': '1對1', '1on2': '1對2' };

// 尚餘（我的課表口徑）＝ 未來 confirmed 預約 ＋（未過期 ? 未登錄餘額 : 0）
const lowPackagesStmt = db.prepare(`
  SELECT p.id, p.member_id, p.session_type,
         COALESCE(up.cnt, 0) +
         (CASE WHEN p.expires_at IS NULL OR p.expires_at >= ? THEN p.remaining_sessions ELSE 0 END) AS still
  FROM customer_packages p
  LEFT JOIN (SELECT package_id, COUNT(*) AS cnt FROM bookings
              WHERE status = 'confirmed' AND package_id IS NOT NULL AND start_at >= ?
              GROUP BY package_id) up ON up.package_id = p.id
  WHERE p.archived_at IS NULL
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

/** 每日掃描（cron 9:00）。回 { packagesSent, groupSent } 供 log。 */
export function processRenewalReminders(now = nowLocal()) {
  const today = String(now).slice(0, 10);
  let packagesSent = 0, groupSent = 0;

  for (const p of lowPackagesStmt.all(today, now)) {
    if (!(p.still > 0 && p.still <= 1)) continue;
    if (hasMarker.get('package', p.member_id, p.id)) continue;
    if (!insertMarker.run('package', p.member_id, p.id).changes) continue;
    notify({ userId: p.member_id, sessionId: null, type: 'package_low_sessions',
      vars: { session_type_label: SESSION_LABELS[p.session_type] || p.session_type, remaining: p.still } });
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
