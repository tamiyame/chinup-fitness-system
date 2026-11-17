import { db, tx } from '../db/connection.js';
import { ApiError } from './registration.js';
import { getSetting, setSetting } from './discountService.js';

// 套裝方案價目表：整張讀取／整張取代，用 app_settings 的版本號做樂觀鎖。
const MAX_PLANS = 60;
const MAX_SESSIONS = 200;
const MAX_UNIT_PRICE = 1000000;
const SESSION_TYPES = ['1on1', '1on2'];
const VERSION_KEY = 'package_plans_version';

// 堂數小到大、同堂數 1on1 在前（'1on1' < '1on2'）
const listStmt = db.prepare(
  `SELECT session_type, total_sessions, unit_price FROM package_plans
    ORDER BY total_sessions, session_type`
);
const findStmt = db.prepare(
  `SELECT session_type, total_sessions, unit_price FROM package_plans
    WHERE session_type = ? AND total_sessions = ?`
);
const deleteAllStmt = db.prepare('DELETE FROM package_plans');
const insertStmt = db.prepare(
  'INSERT INTO package_plans (session_type, total_sessions, unit_price) VALUES (?, ?, ?)'
);

const toPlan = (r) => ({ sessionType: r.session_type, totalSessions: r.total_sessions, unitPrice: r.unit_price });
const currentVersion = () => getSetting(VERSION_KEY) ?? '0';
const isInt = (n, max) => typeof n === 'number' && Number.isInteger(n) && n >= 1 && n <= max;

export function getPlanTable() {
  return { version: currentVersion(), plans: listStmt.all().map(toPlan) };
}

export function findPlan(sessionType, totalSessions) {
  const r = findStmt.get(sessionType, totalSessions);
  return r ? toPlan(r) : null;
}

function validate(plans) {
  if (!Array.isArray(plans) || plans.length > MAX_PLANS) throw new ApiError(400, 'invalid_plans');
  const seen = new Set();
  for (const p of plans) {
    if (!p || typeof p !== 'object' || Array.isArray(p)) throw new ApiError(400, 'invalid_plans');
    if (!SESSION_TYPES.includes(p.sessionType)) throw new ApiError(400, 'invalid_session_type');
    if (!isInt(p.totalSessions, MAX_SESSIONS)) throw new ApiError(400, 'invalid_total');
    if (!isInt(p.unitPrice, MAX_UNIT_PRICE)) throw new ApiError(400, 'invalid_unit_price');
    const key = `${p.sessionType}:${p.totalSessions}`;
    if (seen.has(key)) throw new ApiError(400, 'duplicate_plan');
    seen.add(key);
  }
}

// 順序：核版本 → 驗證 → 寫入 → 版本加 1；任何一步丟錯整個回滾
export function replacePlanTable({ version, plans } = {}) {
  return tx(() => {
    const okType = typeof version === 'string' || typeof version === 'number';
    if (!okType || String(version) !== currentVersion()) throw new ApiError(409, 'plans_changed');
    validate(plans);
    deleteAllStmt.run();
    for (const p of plans) insertStmt.run(p.sessionType, p.totalSessions, p.unitPrice);
    setSetting(VERSION_KEY, String(Number(currentVersion()) + 1));
    return getPlanTable();
  });
}
