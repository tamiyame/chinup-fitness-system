// 堂數即將用完自動提醒：10 堂方案「尚餘」剩 1 堂 → 帶課教練＋管理者；團課未來正取合計剩最後 1 堂 → 會員。
// 方案只提醒 10 堂的（單堂、其他堂數不提醒）；客人已經買了新方案（較晚買、還有堂數）的舊方案也不提醒。
// 每日 9 點掃描；renewal_reminders 去重（每狀態一次）。
// 規格：docs/superpowers/specs/2026-07-04-renewal-reminders-design.md
import { db, nowLocal } from '../db/connection.js';
import { notify, notifyAdmins, fmtDateForLine } from './notifications.js';

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

const sessionLabel = (type) => SESSION_LABELS[type] || type;

const REMIND_TOTAL = 10;   // 只提醒 10 堂方案（業主 2026-11 指定：單堂、其他堂數都不用）
/**
 * 需要續購提醒的方案：10 堂、尚餘剛好 1 堂，而且客人名下沒有「較晚買、還有堂數」的方案（已續購就不提醒）。
 * 較晚買＝id 較大（AUTOINCREMENT；created_at 建立後不會改，兩者順序一致）。新方案作廢、上完或過期（尚餘 0）不算已續購。
 */
function dueLowPackages(now) {
  const rows = lowPackagesStmt.all(String(now).slice(0, 10), now);
  const newestUsable = new Map();   // member_id → 還有堂數的方案中最大的 id
  for (const p of rows) if (p.still >= 1 && p.id > (newestUsable.get(p.member_id) ?? 0)) newestUsable.set(p.member_id, p.id);
  return rows.filter((p) => p.total_sessions === REMIND_TOTAL && p.still === 1 && newestUsable.get(p.member_id) === p.id);
}

/** 每日掃描（cron 9:00）。回 { packagesSent, groupSent } 供 log。 */
export function processRenewalReminders(now = nowLocal()) {
  let packagesSent = 0, groupSent = 0;

  for (const p of dueLowPackages(now)) {
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
