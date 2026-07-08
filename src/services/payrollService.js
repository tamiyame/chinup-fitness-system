// 薪資計算：期別（上月6號～當月5號）內各教練一對一級距抽成 + 團課固定比例抽成。
// 純即時計算（不存快照）；規則見 docs/superpowers/specs/2026-07-03-admin-payroll-tab-design.md。
import { db, nowLocal } from '../db/connection.js';
import { ApiError } from './registration.js';
import { getSetting } from './discountService.js';
import { shiftSummaryByCoach } from './shiftService.js';

const PERIOD_RE = /^\d{4}-(0[1-9]|1[0-2])$/;
const pad = (n) => String(n).padStart(2, '0');

/** 結算月 YYYY-MM → 範圍：前月06T00:00:00（含）～當月06T00:00:00（不含）。display* 為含端點的顯示日期。 */
export function periodRange(period) {
  if (!PERIOD_RE.test(period || '')) throw new ApiError(400, 'invalid_period');
  const [y, m] = period.split('-').map(Number);
  const py = m === 1 ? y - 1 : y;
  const pm = m === 1 ? 12 : m - 1;
  return {
    lo: `${py}-${pad(pm)}-06T00:00:00`,
    hi: `${y}-${pad(m)}-06T00:00:00`,
    displayStart: `${py}-${pad(pm)}-06`,
    displayEnd: `${y}-${pad(m)}-05`,
  };
}

/** 今天所屬期別：日 ≤5 → 當月；≥6 → 次月。 */
export function defaultPeriod(now = nowLocal()) {
  const y = Number(now.slice(0, 4)), m = Number(now.slice(5, 7)), d = Number(now.slice(8, 10));
  if (d <= 5) return `${y}-${pad(m)}`;
  return m === 12 ? `${y + 1}-01` : `${y}-${pad(m + 1)}`;
}

function intSetting(key, dflt) {
  const raw = getSetting(key);
  const n = raw == null || raw === '' ? NaN : Number(raw);
  return Number.isInteger(n) ? n : dflt;
}

const coachesStmt = db.prepare('SELECT id, display_name, is_active, hourly_rate FROM coaches ORDER BY created_at ASC, id ASC');
const bookingsStmt = db.prepare(`
  SELECT b.id, b.coach_id, b.start_at, b.session_type, b.package_id,
         b.original_amount, b.discount_amount, u.name AS member_name
  FROM bookings b JOIN users u ON u.id = b.member_id
  WHERE b.status = 'confirmed' AND b.start_at >= ? AND b.start_at < ?
  ORDER BY b.coach_id ASC, b.start_at ASC
`);
const groupSessionsStmt = db.prepare(`
  SELECT s.id, s.coach_id, s.start_at, t.name AS course_name,
         COUNT(r.id) AS headcount,
         COALESCE(SUM(CASE WHEN r.id IS NULL THEN 0 ELSE COALESCE(r.amount_due, t.price_per_session) END), 0) AS revenue
  FROM course_sessions s
  JOIN course_templates t ON t.id = s.template_id
  LEFT JOIN registrations r ON r.session_id = s.id AND r.status = 'confirmed' AND r.on_leave = 0
  WHERE s.coach_id IS NOT NULL AND s.status != 'cancelled' AND s.start_at >= ? AND s.start_at < ?
  GROUP BY s.id
  ORDER BY s.coach_id ASC, s.start_at ASC
`);

/** 全教練當期薪資彙總＋逐堂明細。教練清單：啟用者全列（含0堂）；停用者僅期內有資料時列出。 */
export function computePayroll({ period } = {}) {
  const p = period || defaultPeriod();
  const { lo, hi, displayStart, displayEnd } = periodRange(p);
  const settings = {
    threshold: intSetting('payroll_tier_threshold', 40),
    pctLow: intSetting('payroll_pct_low', 50),
    pctHigh: intSetting('payroll_pct_high', 60),
    groupPct: intSetting('payroll_group_pct', 50),
  };
  const now = nowLocal();

  const byCoach = new Map(coachesStmt.all().map((c) => [c.id, {
    coachId: c.id, displayName: c.display_name, isActive: c.is_active,
    oneOnOne: { sessions: 0, revenue: 0, unpriced: 0, future: 0, pct: settings.pctLow, salary: 0, details: [] },
    group: { headcount: 0, revenue: 0, pct: settings.groupPct, salary: 0, details: [] },
    shift: { hours: 0, rate: c.hourly_rate ?? null, salary: 0, details: [] },
    total: 0,
  }]));

  for (const b of bookingsStmt.all(lo, hi)) {
    const c = byCoach.get(b.coach_id);
    if (!c) continue;
    const unpriced = b.original_amount == null;
    const amount = Math.max(0, (b.original_amount || 0) - (b.discount_amount || 0));
    const future = b.start_at > now;
    c.oneOnOne.sessions += 1;
    c.oneOnOne.revenue += amount;
    if (unpriced) c.oneOnOne.unpriced += 1;
    if (future) c.oneOnOne.future += 1;
    c.oneOnOne.details.push({
      bookingId: b.id, startAt: b.start_at, memberName: b.member_name, sessionType: b.session_type,
      source: b.package_id ? 'package' : 'walkin', amount, unpriced, future,
    });
  }

  for (const s of groupSessionsStmt.all(lo, hi)) {
    const c = byCoach.get(s.coach_id);
    if (!c) continue;
    c.group.headcount += s.headcount;
    c.group.revenue += s.revenue;
    c.group.details.push({ sessionId: s.id, startAt: s.start_at, courseName: s.course_name,
      headcount: s.headcount, revenue: s.revenue });
  }

  const shiftMap = shiftSummaryByCoach(displayStart, displayEnd);
  for (const [coachId, s] of shiftMap) {
    const c = byCoach.get(coachId);
    if (!c) continue;
    c.shift.hours = s.hours;
    c.shift.details = s.details;
  }

  const coaches = [];
  for (const c of byCoach.values()) {
    const o = c.oneOnOne;
    o.pct = o.sessions > settings.threshold ? settings.pctHigh : settings.pctLow;
    o.salary = Math.round(o.revenue * o.pct / 100);
    c.group.salary = Math.round(c.group.revenue * settings.groupPct / 100);
    c.shift.salary = c.shift.rate != null ? Math.round(c.shift.hours * c.shift.rate) : 0;
    c.total = o.salary + c.group.salary + c.shift.salary;
    if (c.isActive || o.sessions > 0 || c.group.details.length > 0 || c.shift.details.length > 0) coaches.push(c);
  }

  const totals = coaches.reduce((t, c) => ({
    oneOnOneSessions: t.oneOnOneSessions + c.oneOnOne.sessions,
    oneOnOneRevenue: t.oneOnOneRevenue + c.oneOnOne.revenue,
    oneOnOneSalary: t.oneOnOneSalary + c.oneOnOne.salary,
    groupHeadcount: t.groupHeadcount + c.group.headcount,
    groupRevenue: t.groupRevenue + c.group.revenue,
    groupSalary: t.groupSalary + c.group.salary,
    shiftHours: t.shiftHours + c.shift.hours,
    shiftSalary: t.shiftSalary + c.shift.salary,
    total: t.total + c.total,
  }), { oneOnOneSessions: 0, oneOnOneRevenue: 0, oneOnOneSalary: 0, groupHeadcount: 0, groupRevenue: 0, groupSalary: 0, shiftHours: 0, shiftSalary: 0, total: 0 });

  return { period: p, range: { start: displayStart, end: displayEnd }, settings, coaches, totals };
}
