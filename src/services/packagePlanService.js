import { db, tx } from '../db/connection.js';
import { ApiError } from './registration.js';

// 套裝方案：一列一個可以賣的套裝（類型、堂數、每堂單價、名稱、啟用與否）。
// 同類型同堂數可以有好幾筆；只有四項完全相同才算重複。
const MAX_PLANS = 100;
const MAX_SESSIONS = 200;
const MAX_UNIT_PRICE = 1000000;
const MAX_NAME_LENGTH = 20;
const SESSION_TYPES = ['1on1', '1on2'];

const COLS = 'id, session_type, total_sessions, unit_price, name, is_active';
// 一對一在前（'1on1' < '1on2'）、堂數少到多、同堂數價格高的在前、再依建立先後
const ORDER = 'ORDER BY session_type, total_sessions, unit_price DESC, id';

const listAllStmt = db.prepare(`SELECT ${COLS} FROM package_plans ${ORDER}`);
const listActiveStmt = db.prepare(`SELECT ${COLS} FROM package_plans WHERE is_active = 1 ${ORDER}`);
const getStmt = db.prepare(`SELECT ${COLS} FROM package_plans WHERE id = ?`);
const matchStmt = db.prepare(
  `SELECT ${COLS} FROM package_plans WHERE is_active = 1 AND session_type = ? AND total_sessions = ? ${ORDER}`
);
const countStmt = db.prepare('SELECT COUNT(*) AS c FROM package_plans');
const dupStmt = db.prepare(
  `SELECT id FROM package_plans
    WHERE session_type = ? AND total_sessions = ? AND unit_price = ? AND COALESCE(name, '') = ? AND id <> ?`
);
const insertStmt = db.prepare(
  'INSERT INTO package_plans (session_type, total_sessions, unit_price, name, is_active) VALUES (?, ?, ?, ?, ?)'
);
const updateStmt = db.prepare(
  'UPDATE package_plans SET session_type = ?, total_sessions = ?, unit_price = ?, name = ?, is_active = ? WHERE id = ?'
);
const deleteStmt = db.prepare('DELETE FROM package_plans WHERE id = ?');

const toPlan = (r) => ({
  id: r.id,
  sessionType: r.session_type,
  totalSessions: r.total_sessions,
  unitPrice: r.unit_price,
  name: r.name ?? null,
  isActive: r.is_active === 1,
});
const isInt = (n, max) => typeof n === 'number' && Number.isInteger(n) && n >= 1 && n <= max;
const isId = (id) => typeof id === 'number' && Number.isInteger(id) && id > 0;
const isObject = (v) => !!v && typeof v === 'object' && !Array.isArray(v);

export function listPlans({ activeOnly = false } = {}) {
  return (activeOnly ? listActiveStmt : listAllStmt).all().map(toPlan);
}

export function getPlan(id) {
  if (!isId(id)) return null;
  const r = getStmt.get(id);
  return r ? toPlan(r) : null;
}

// 開會員方案時核價用：只認啟用中的
export function findActivePlan(id) {
  const p = getPlan(id);
  return p && p.isActive ? p : null;
}

// 還沒重新整理的舊畫面不會帶套裝編號，只能用類型＋堂數找
export function matchActivePlans(sessionType, totalSessions) {
  return matchStmt.all(sessionType, totalSessions).map(toPlan);
}

// 驗證並整理成要寫進資料庫的樣子；任何一項不合格就丟錯
function normalize({ sessionType, totalSessions, unitPrice, name, isActive }) {
  if (!SESSION_TYPES.includes(sessionType)) throw new ApiError(400, 'invalid_session_type');
  if (!isInt(totalSessions, MAX_SESSIONS)) throw new ApiError(400, 'invalid_total');
  if (!isInt(unitPrice, MAX_UNIT_PRICE)) throw new ApiError(400, 'invalid_unit_price');
  let cleanName = null;
  if (name != null) {
    if (typeof name !== 'string') throw new ApiError(400, 'invalid_name');
    const t = name.trim();
    if ([...t].length > MAX_NAME_LENGTH) throw new ApiError(400, 'invalid_name');
    cleanName = t === '' ? null : t;
  }
  if (typeof isActive !== 'boolean') throw new ApiError(400, 'invalid_active');
  return { sessionType, totalSessions, unitPrice, name: cleanName, isActive };
}

function assertNotDuplicate(p, selfId) {
  if (dupStmt.get(p.sessionType, p.totalSessions, p.unitPrice, p.name ?? '', selfId)) {
    throw new ApiError(409, 'duplicate_plan');
  }
}

export function createPlan(fields) {
  if (!isObject(fields)) throw new ApiError(400, 'invalid_plan');
  return tx(() => {
    const p = normalize({ ...fields, isActive: fields.isActive === undefined ? true : fields.isActive });
    if (countStmt.get().c >= MAX_PLANS) throw new ApiError(400, 'too_many_plans');
    assertNotDuplicate(p, 0);
    const info = insertStmt.run(p.sessionType, p.totalSessions, p.unitPrice, p.name, p.isActive ? 1 : 0);
    return getPlan(Number(info.lastInsertRowid));
  });
}

// 沒送（undefined）的欄位維持原值；name 送 null 或空字串＝清掉名稱
export function updatePlan(id, fields) {
  if (!isObject(fields)) throw new ApiError(400, 'invalid_plan');
  return tx(() => {
    const cur = getPlan(id);
    if (!cur) throw new ApiError(404, 'plan_not_found');
    const pick = (k) => (fields[k] === undefined ? cur[k] : fields[k]);
    const p = normalize({
      sessionType: pick('sessionType'),
      totalSessions: pick('totalSessions'),
      unitPrice: pick('unitPrice'),
      name: pick('name'),
      isActive: pick('isActive'),
    });
    assertNotDuplicate(p, id);
    updateStmt.run(p.sessionType, p.totalSessions, p.unitPrice, p.name, p.isActive ? 1 : 0, id);
    return getPlan(id);
  });
}

export function deletePlan(id) {
  return tx(() => {
    if (!getPlan(id)) throw new ApiError(404, 'plan_not_found');
    deleteStmt.run(id);
    return { ok: true };
  });
}
