import { db, tx, nowLocal } from '../db/connection.js';
import { ApiError } from './registration.js';
import { quoteDiscount, releaseRedemption } from './discountService.js';

const SESSION_TYPES = ['1on1', '1on2'];
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function todayLocal() { return nowLocal().slice(0, 10); }

// is_valid：未作廢 + 有剩 + 未過期（? = 今天）
const VALID_EXPR = `(cp.archived_at IS NULL AND cp.remaining_sessions > 0 AND (cp.expires_at IS NULL OR cp.expires_at >= ?))`;

// 舊方案先用（業主 2026-11 指定）：同一位客人、同類型（1對1／1對2）裡，還可用的方案要從最早買的那筆開始登錄。
// 最早買＝id 最小（AUTOINCREMENT；created_at 建立後不會改，兩者順序一致）。
// use_first_id＝要先用完的那筆方案 id；這筆自己就是該用的那筆，或自己已不可用 → null。
const olderValidStmt = db.prepare(
  `SELECT MIN(cp.id) AS id FROM customer_packages cp
    WHERE cp.member_id = ? AND cp.session_type = ? AND cp.id < ? AND ${VALID_EXPR}`
);

export function getPackage(id) {
  const row = db.prepare(`SELECT cp.*, ${VALID_EXPR} AS is_valid FROM customer_packages cp WHERE cp.id = ?`)
    .get(todayLocal(), id);
  if (!row) return null;
  row.is_valid = !!row.is_valid;
  row.use_first_id = row.is_valid
    ? (olderValidStmt.get(row.member_id, row.session_type, row.id, todayLocal()).id ?? null)
    : null;
  return row;
}

export function createPackage({ memberId, sessionType, totalSessions, amount = null, expiresAt = null, note = null, createdBy = null, discountCode = null }) {
  if (!memberId) throw new ApiError(400, 'missing_member');
  if (!SESSION_TYPES.includes(sessionType)) throw new ApiError(400, 'invalid_session_type');
  const total = Number(totalSessions);
  if (!Number.isInteger(total) || total <= 0) throw new ApiError(400, 'invalid_total');
  let amt = null;
  if (amount != null && amount !== '') {
    amt = Number(amount);
    if (!Number.isInteger(amt) || amt < 0) throw new ApiError(400, 'invalid_amount');
  }
  let exp = null;
  if (expiresAt != null && expiresAt !== '') {
    if (!DATE_RE.test(expiresAt)) throw new ApiError(400, 'invalid_expires_at');
    // regex 擋不掉不存在的日期（如 2026-13-45 / 2026-02-30）→ 用 Date round-trip 驗真實日期。
    const d = new Date(`${expiresAt}T00:00:00`);
    if (Number.isNaN(d.getTime())
      || `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}` !== expiresAt) {
      throw new ApiError(400, 'invalid_expires_at');
    }
    exp = expiresAt;
  }
  const member = db.prepare('SELECT id FROM users WHERE id = ?').get(memberId);
  if (!member) throw new ApiError(404, 'member_not_found');
  let discountCodeStored = null;
  // 僅在「有填金額」時才套折扣：amt==null（金額留空）→ 略過，不存碼、不把金額變成 0。
  if (discountCode != null && String(discountCode).trim() !== '' && amt != null) {
    const q = quoteDiscount({ code: discountCode, amount: amt, qty: total });
    if (q) { amt = q.finalTotal; discountCodeStored = q.code; }
  }
  // created_at 用 nowLocal()（本地 wall-clock，與全站一致；不用 DEFAULT 的 UTC datetime('now')）。
  const info = db.prepare(
    `INSERT INTO customer_packages (member_id, session_type, total_sessions, remaining_sessions, amount, expires_at, note, created_by, created_at, discount_code)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(memberId, sessionType, total, total, amt, exp, (note && note.trim()) || null, createdBy, nowLocal(), discountCodeStored);
  return getPackage(Number(info.lastInsertRowid));
}

export function listPackagesForMember(memberId, { includeArchived = false } = {}) {
  const now = nowLocal();
  const rows = db.prepare(
    `SELECT cp.*, ${VALID_EXPR} AS is_valid,
            COALESCE(bc.completed, 0) AS completed_sessions,
            COALESCE(bc.upcoming, 0) AS upcoming_sessions
       FROM customer_packages cp
       LEFT JOIN (SELECT package_id,
                         SUM(CASE WHEN start_at <  ? THEN 1 ELSE 0 END) AS completed,
                         SUM(CASE WHEN start_at >= ? THEN 1 ELSE 0 END) AS upcoming
                    FROM bookings
                   WHERE status = 'confirmed' AND package_id IS NOT NULL
                   GROUP BY package_id) bc ON bc.package_id = cp.id
      WHERE cp.member_id = ? ${includeArchived ? '' : 'AND cp.archived_at IS NULL'}
      ORDER BY (cp.archived_at IS NOT NULL) ASC,
               (cp.remaining_sessions > 0) DESC,
               (cp.expires_at IS NULL) ASC, cp.expires_at ASC, cp.created_at ASC`
  ).all(todayLocal(), now, now, memberId);
  const firstByType = new Map();   // session_type → 還可用的方案中最早買的那筆 id
  for (const r of rows) {
    r.is_valid = !!r.is_valid;
    if (r.is_valid && r.id < (firstByType.get(r.session_type) ?? Infinity)) firstByType.set(r.session_type, r.id);
  }
  for (const r of rows) {
    const first = firstByType.get(r.session_type);
    r.use_first_id = r.is_valid && first !== r.id ? first : null;
  }
  attachSingle(rows, now);
  return rows;
}

// 線上單堂方案附 single（卡片顯示用）；教練開立的列不動。名下預約一次查回，不逐張方案查。
function attachSingle(rows, now) {
  const online = rows.filter((r) => r.source === 'online');
  if (!online.length) return;
  const ids = online.map((r) => r.id);
  const bks = db.prepare(
    `SELECT b.id, b.package_id, b.start_at, b.status, b.paid_at, b.refunded_at, c.display_name AS coach_name
       FROM bookings b JOIN coaches c ON c.id = b.coach_id
      WHERE b.package_id IN (${ids.map(() => '?').join(',')})
      ORDER BY b.id`
  ).all(...ids);
  const byPkg = new Map();
  for (const b of bks) { if (!byPkg.has(b.package_id)) byPkg.set(b.package_id, []); byPkg.get(b.package_id).push(b); }
  for (const r of online) {
    const list = byPkg.get(r.id) || [];   // 依 id 由小到大；名下可能沒有預約（被改掛走）
    const confirmed = list.filter((b) => b.status === 'confirmed');
    const rep = confirmed.length ? confirmed[confirmed.length - 1] : (list[list.length - 1] || null);
    const payStatus = list.some((b) => b.refunded_at) ? 'refunded' : list.some((b) => b.paid_at) ? 'paid' : 'pending';
    let state;
    if (r.archived_at) state = payStatus === 'paid' ? 'void' : 'cancelled';
    else if (confirmed.length) state = rep.start_at >= now ? 'booked' : 'done';
    else state = 'credit';
    let refundable = null;
    if (!r.archived_at && payStatus === 'paid') {
      if (rep && rep.paid_at && !rep.refunded_at) refundable = rep.id;
      else { const hit = list.filter((b) => b.paid_at && !b.refunded_at); refundable = hit.length ? hit[hit.length - 1].id : null; }
    }
    r.single = {
      booking_id: rep?.id ?? null, start_at: rep?.start_at ?? null, coach_name: rep?.coach_name ?? null, booking_status: rep?.status ?? null,
      pay_status: payStatus, amount: r.amount, state, refundable_booking_id: refundable,
    };
  }
}

/** 後台方案總覽：各來源方案數、沒有方案的未取消預約數、補登結果（沒補登過 → null）、
 *  上次補登失敗的原因（{ at, reason, error, snapshotLeft }；沒有、空字串、壞資料 → null；補登成功時會清成空字串）。 */
export function getPackagesSummary() {
  const n = (sql) => db.prepare(sql).get().c;
  const raw = db.prepare("SELECT value FROM app_settings WHERE key = 'online_single_backfill_summary'").get()?.value;
  let backfill = null;
  if (raw) { try { backfill = JSON.parse(raw); } catch { backfill = null; } }
  const rawErr = db.prepare("SELECT value FROM app_settings WHERE key = 'online_single_backfill_error'").get()?.value;
  let backfillError = null;
  if (rawErr) {
    try { const v = JSON.parse(rawErr); backfillError = v && typeof v === 'object' && !Array.isArray(v) ? v : null; } catch { backfillError = null; }
  }
  return {
    packages: {
      staff: n("SELECT COUNT(*) AS c FROM customer_packages WHERE source = 'staff'"),
      online: n("SELECT COUNT(*) AS c FROM customer_packages WHERE source = 'online'"),
    },
    confirmedWithoutPackage: n("SELECT COUNT(*) AS c FROM bookings WHERE status = 'confirmed' AND package_id IS NULL"),
    backfill,
    backfillError,
  };
}

export function listValidPackagesForMember(memberId, sessionType = null) {
  const today = todayLocal();
  const params = sessionType ? [memberId, today, sessionType] : [memberId, today];
  return db.prepare(
    `SELECT cp.* FROM customer_packages cp
      WHERE cp.member_id = ?
        AND cp.archived_at IS NULL
        AND cp.remaining_sessions > 0
        AND (cp.expires_at IS NULL OR cp.expires_at >= ?)
        ${sessionType ? 'AND cp.session_type = ?' : ''}
      ORDER BY (cp.expires_at IS NULL) ASC, cp.expires_at ASC, cp.created_at ASC`
  ).all(...params);
}

/**
 * 我的課表顯示用：方案持續顯示直到所有課上完(已結束)。
 * now = 'YYYY-MM-DDTHH:MM:SS'。completed=該方案 confirmed 且 start_at<now；upcoming=confirmed 且 start_at>=now。
 * 顯示條件：upcoming>0 或 (remaining_sessions>0 且未過期)。
 * 投影 remaining_sessions(尚餘) = upcoming + (未過期 ? 未登錄remaining : 0)；永遠 ≥0，正常流程下＝共−已上完。
 */
export function listScheduleViewPackages(memberId, now) {
  const today = String(now).slice(0, 10);
  const pkgs = db.prepare(
    `SELECT * FROM customer_packages
      WHERE member_id = ? AND archived_at IS NULL AND source <> 'online'
      ORDER BY (expires_at IS NULL) ASC, expires_at ASC, created_at ASC`
  ).all(memberId);
  if (!pkgs.length) return [];
  const counts = db.prepare(
    `SELECT package_id,
            SUM(CASE WHEN start_at <  ? THEN 1 ELSE 0 END) AS completed,
            SUM(CASE WHEN start_at >= ? THEN 1 ELSE 0 END) AS upcoming
       FROM bookings
      WHERE member_id = ? AND status = 'confirmed' AND package_id IS NOT NULL
      GROUP BY package_id`
  ).all(now, now, memberId);
  const byPkg = new Map(counts.map((c) => [c.package_id, c]));
  const out = [];
  for (const p of pkgs) {
    const c = byPkg.get(p.id) || { completed: 0, upcoming: 0 };
    const expired = !!(p.expires_at && p.expires_at < today);
    if (!(c.upcoming > 0 || (p.remaining_sessions > 0 && !expired))) continue;
    out.push({
      session_type: p.session_type,
      total_sessions: p.total_sessions,
      completed_sessions: c.completed,
      remaining_sessions: c.upcoming + (expired ? 0 : p.remaining_sessions),
      expires_at: p.expires_at,
    });
  }
  return out;
}

export function adjustRemaining({ packageId, remaining, note = null }) {
  return tx(() => {
    const p = db.prepare('SELECT * FROM customer_packages WHERE id = ?').get(packageId);
    if (!p) throw new ApiError(404, 'package_not_found');
    if (p.source === 'online') throw new ApiError(409, 'online_single_readonly');
    const r = Number(remaining);
    if (!Number.isInteger(r) || r < 0 || r > p.total_sessions) throw new ApiError(400, 'invalid_remaining');
    const newNote = note && note.trim() ? note.trim() : null;
    db.prepare('UPDATE customer_packages SET remaining_sessions = ?, note = COALESCE(?, note) WHERE id = ?')
      .run(r, newNote, packageId);
    return getPackage(packageId);
  });
}

/** 修正單價（管理者）：amount 改為 unitPrice×total、清除方案的折扣碼註記，並回寫名下預約：
 *  定價改成新單價、折扣欄位清成 NULL、釋放它們的折扣碼用量（含已上完；薪資口徑從根修正——
 *  舊期別薪資頁重開會依新單價重算，屬修正目的）。rewrittenBookings＝實際改到的預約筆數。
 *  回寫哪些預約：
 *    教練開立的方案、已作廢的線上單堂 → 只回寫未取消（confirmed）的預約
 *    未作廢的線上單堂 → 名下所有還沒退款的預約（不分狀態，含「保留 1 堂」背後已取消、已付款的原筆）。
 *      規格對改單價的意思是「管理者指定的單價就是最後的金額」，所以卡片、已核對匯款清單、
 *      退款通知三處要顯示同一個數字；只改未取消的那筆，保留 1 堂之後退款時通知會寫舊的實付金額。 */
export function updateUnitPrice({ packageId, unitPrice }) {
  const u = Number(unitPrice);
  if (!Number.isInteger(u) || u < 0) throw new ApiError(400, 'invalid_unit_price');
  return tx(() => {
    const p = db.prepare('SELECT * FROM customer_packages WHERE id = ?').get(packageId);
    if (!p) throw new ApiError(404, 'package_not_found');
    const amount = u * p.total_sessions;
    db.prepare('UPDATE customer_packages SET amount = ?, discount_code = NULL WHERE id = ?').run(amount, packageId);
    const which = p.source === 'online' && !p.archived_at
      ? 'package_id = ? AND refunded_at IS NULL'
      : "package_id = ? AND status = 'confirmed'";
    // 同一批預約：改定價、折扣欄位清成 NULL，並釋放它們的折扣碼用量（避免折扣被重複套用或用量殘留）。
    const ids = db.prepare(`SELECT id FROM bookings WHERE ${which}`).all(packageId);
    const r = db.prepare(
      `UPDATE bookings SET original_amount = ?, discount_amount = NULL, discount_code = NULL WHERE ${which}`
    ).run(u, packageId);
    for (const row of ids) releaseRedemption({ kind: 'booking', refId: row.id });
    return { ok: true, amount, unitPrice: u, rewrittenBookings: r.changes };
  });
}

// 作廢連動取消：列出/取消該方案名下所有 confirmed 預約（inline SQL，不 import bookingService 以免循環依賴）。
const listConfirmedBookingsByPackageStmt = db.prepare(
  `SELECT id FROM bookings WHERE package_id = ? AND status = 'confirmed' ORDER BY id ASC`
);
const cancelBookingsByPackageStmt = db.prepare(
  `UPDATE bookings SET status='cancelled', cancelled_at=?, cancelled_by=?, cancel_reason=?
   WHERE package_id = ? AND status = 'confirmed'`
);

// 作廢方案：
//   教練開立的方案 → 連動取消名下所有未取消預約（含過去；靜默、不回補堂數）。
//   線上單堂 → 名下還有未取消的預約就擋（has_active_booking）；否則只關閉方案（釋放折扣碼用量），不取消任何預約。
// 回傳含 cancelledBookingIds 供 route 端逐筆刪 Google 日曆事件。天然冪等（再作廢→空陣列）。
export function archivePackage(packageId, actorId = null) {
  return tx(() => {
    const p = db.prepare('SELECT id, source FROM customer_packages WHERE id = ?').get(packageId);
    if (!p) throw new ApiError(404, 'package_not_found');
    if (p.source === 'online') {
      // 線上單堂：還有未取消的預約要先取消；否則只關閉方案（釋放折扣碼用量），不連動取消。
      if (listConfirmedBookingsByPackageStmt.all(packageId).length) throw new ApiError(409, 'has_active_booking');
      closeOnlineSinglePackage(packageId);
      return { ...getPackage(packageId), cancelledBookingIds: [] };
    }
    db.prepare('UPDATE customer_packages SET archived_at = ? WHERE id = ? AND archived_at IS NULL').run(nowLocal(), packageId);
    const cancelledBookingIds = listConfirmedBookingsByPackageStmt.all(packageId).map((r) => r.id);
    if (cancelledBookingIds.length) {
      cancelBookingsByPackageStmt.run(nowLocal(), actorId, '方案作廢連動取消', packageId);
    }
    return { ...getPackage(packageId), cancelledBookingIds };
  });
}

export function restorePackage(packageId) {
  const p = db.prepare('SELECT id, source FROM customer_packages WHERE id = ?').get(packageId);
  if (!p) throw new ApiError(404, 'package_not_found');
  if (p.source === 'online') throw new ApiError(409, 'online_single_readonly');
  db.prepare('UPDATE customer_packages SET archived_at = NULL WHERE id = ?').run(packageId);
  return getPackage(packageId);
}

// 扣 1 堂：條件式 UPDATE 防併發超扣。回 true=成功；剩餘不足/作廢→false。
export function deductOne(packageId) {
  const info = db.prepare(
    `UPDATE customer_packages SET remaining_sessions = remaining_sessions - 1
      WHERE id = ? AND remaining_sessions > 0 AND archived_at IS NULL`
  ).run(packageId);
  return info.changes === 1;
}

// 回補 1 堂（取消預約）：即使已過期/作廢仍回補（堂數屬客人）。
// WHERE remaining < total → changes===1 代表「真的回補了一堂」（已滿時 changes=0、回 false），
// 契約精準，讓「不重複回補」測試不被封頂掩蓋。
export function refundOne(packageId) {
  const info = db.prepare(
    `UPDATE customer_packages SET remaining_sessions = remaining_sessions + 1
      WHERE id = ? AND remaining_sessions < total_sessions`
  ).run(packageId);
  return info.changes === 1;
}

/** 為一筆線上預約建立「一堂的方案」並掛上（source='online'、total 1、remaining 0＝這堂已預約掉）。
 *  金額＝定價−折扣（定價 NULL → NULL；折到 0 元 → 0）。不通知、不改預約其他欄位。回方案 id。 */
export function createOnlineSingleForBooking(bookingId, { createdAt = nowLocal() } = {}) {
  return tx(() => {
    const b = db.prepare('SELECT id, member_id, session_type, original_amount, discount_amount, discount_code, package_id FROM bookings WHERE id = ?').get(bookingId);
    if (!b) throw new ApiError(404, 'booking_not_found');
    if (b.package_id != null) throw new ApiError(409, 'booking_has_package');
    const amount = b.original_amount == null ? null : Math.max(0, b.original_amount - (b.discount_amount || 0));
    const packageId = Number(db.prepare(
      `INSERT INTO customer_packages (member_id, session_type, total_sessions, remaining_sessions, amount, discount_code, source, created_at)
       VALUES (?, ?, 1, 0, ?, ?, 'online', ?)`
    ).run(b.member_id, b.session_type, amount, b.discount_code ?? null, createdAt).lastInsertRowid);
    db.prepare('UPDATE bookings SET package_id = ? WHERE id = ?').run(packageId, bookingId);
    return packageId;
  });
}

/** 關閉線上單堂方案：寫作廢時間（已作廢不改）、釋放名下預約的折扣碼用量。
 *  不是線上單堂方案（或找不到）→ 不動、回 false。不取消預約、不通知。 */
export function closeOnlineSinglePackage(packageId) {
  return tx(() => {
    const p = db.prepare("SELECT id FROM customer_packages WHERE id = ? AND source = 'online'").get(packageId);
    if (!p) return false;
    db.prepare('UPDATE customer_packages SET archived_at = ? WHERE id = ? AND archived_at IS NULL').run(nowLocal(), packageId);
    for (const row of db.prepare('SELECT id FROM bookings WHERE package_id = ?').all(packageId)) {
      releaseRedemption({ kind: 'booking', refId: row.id });
    }
    return true;
  });
}
