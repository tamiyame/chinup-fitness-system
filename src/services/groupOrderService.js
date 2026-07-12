import { db, tx, nowLocal, offsetLocal } from '../db/connection.js';
import { ApiError } from './registration.js';
import { findOrCreateUserByPhone, getUserByPhoneAndName, createCustomerNoPhone } from './userService.js';
import { notify, notifyCourseCoach, notifyAdmins } from './notifications.js';
import { generateBindCode } from './lineBindingService.js';
import { applyDiscountTx, releaseRedemption, getBankInfo, getLineOfficialUrl, getGroupOrderExpiryHours, quoteDiscount } from './discountService.js';
import { listScheduleViewPackages } from './packageService.js';

// 一般 pending 訂單的付款期限改由 app_settings 的 group_order_expiry_hours 控制（預設 72h，後台可調）。
const PROMOTED_TTL_MS = 24 * 60 * 60 * 1000;     // 候補遞補後 24h（固定：遞補名額要快速流轉）

const getSession = db.prepare('SELECT * FROM course_sessions WHERE id = ?');
const getTemplate = db.prepare('SELECT * FROM course_templates WHERE id = ?');
const getAnyReg = db.prepare('SELECT * FROM registrations WHERE session_id = ? AND user_id = ?');
const getCoachUserIdStmt = db.prepare('SELECT user_id FROM coaches WHERE id = ?');

// '2026-07-08T19:00:00' → '7/8'（無前導零、無年、無時間）
function fmtMD(startAt) {
  const m = /^\d{4}-(\d{2})-(\d{2})/.exec(startAt || '');
  return m ? `${Number(m[1])}/${Number(m[2])}` : String(startAt);
}

// 已佔名額：confirmed 一律算（含舊 member-flow 遷移過來、order_id 為 NULL 的列）；
// pending 只在其訂單未過期時算。waitlisted 不算。
const occupiedStmt = db.prepare(`
  SELECT COUNT(*) AS c
  FROM registrations r
  LEFT JOIN group_orders o ON o.id = r.order_id
  WHERE r.session_id = ?
    AND r.on_leave = 0
    AND ( r.status = 'confirmed'
          OR (r.status = 'pending' AND o.id IS NOT NULL AND o.expires_at >= ?) )
`);
export function sessionOccupied(sessionId) {
  return occupiedStmt.get(sessionId, nowLocal()).c;
}
export function sessionIsFull(sessionId) {
  const s = getSession.get(sessionId);
  if (!s) throw new ApiError(404, 'session_not_found');
  const tpl = getTemplate.get(s.template_id);
  if (!tpl) throw new ApiError(404, 'template_not_found');
  return sessionOccupied(sessionId) >= tpl.max_capacity;
}

const insertOrder = db.prepare(`
  INSERT INTO group_orders (member_id, customer_name, customer_phone, total_amount, status, expires_at)
  VALUES (?, ?, ?, ?, 'pending', ?)
`);
const insertReg = db.prepare(
  'INSERT INTO registrations (session_id, user_id, status, order_id, amount_due) VALUES (?, ?, ?, ?, ?)'
);
const reactivateReg = db.prepare(
  "UPDATE registrations SET status=?, order_id=?, amount_due=?, position=NULL, registered_at=datetime('now') WHERE id=?"
);

function validateSelectable(sessionId) {
  const s = getSession.get(sessionId);
  if (!s) throw new ApiError(404, 'session_not_found');
  if (s.status === 'cancelled') throw new ApiError(409, 'session_cancelled');
  if (s.status === 'completed') throw new ApiError(409, 'session_completed');
  if (s.is_open === 0) throw new ApiError(409, 'session_closed');
  if (nowLocal() > s.registration_deadline) throw new ApiError(409, 'registration_closed');
  return s;
}

/**
 * 團體課送出。
 * paySessionIds: 客人預期有空、要付款報名的場次。
 * waitlistSessionIds: 客人已知額滿、選擇候補的場次（不付款）。
 * 回 { orderId, total, bankInfo, expiresAt, waitlisted:[sessionId...] }
 * pay 桶任一場已滿 → throw 409 { fullSessionIds }（整批不寫）。
 */
export function createGroupOrder({ name, phone, paySessionIds = [], waitlistSessionIds = [], discountCode = null }) {
  if (paySessionIds.length === 0 && waitlistSessionIds.length === 0) {
    throw new ApiError(400, 'no_sessions_selected');
  }
  return tx(() => {
    const user = findOrCreateUserByPhone({ phone, name });

    // 驗 pay 桶都還有空（重算）
    const full = [];
    for (const sid of paySessionIds) {
      validateSelectable(sid);
      if (sessionIsFull(sid)) full.push(sid);
    }
    if (full.length > 0) throw new ApiError(409, 'sessions_full', { fullSessionIds: full });

    // 算金額（單堂價可能各 template 不同 → 逐場加）
    let total = 0;
    const payRows = [];
    for (const sid of paySessionIds) {
      const s = getSession.get(sid);
      const tpl = getTemplate.get(s.template_id);
      if (!tpl) throw new ApiError(404, 'template_not_found');
      const dup = getAnyReg.get(sid, user.id);
      if (dup && ['pending', 'confirmed', 'waitlisted'].includes(dup.status)) {
        throw new ApiError(409, 'already_registered', { sessionId: sid });
      }
      payRows.push({ sid, price: tpl.price_per_session, dup });
      total += tpl.price_per_session;
    }

    // 純候補（無付款場次）不建訂單：沒有應付款項，不該出現在「待核對匯款」、
    // 也不該被逾期機制取消。候補名額由 promoteWaitlist 遞補時才開 24h 付款單。
    const hasPay = paySessionIds.length > 0;
    let orderId = null, expiresAt = null;
    let originalAmount = total, discountAmount = null, discountCode_ = null, finalTotal = total;
    if (hasPay) {
      orderId = insertOrder.run(
        user.id, name.trim(), phone, total, offsetLocal(getGroupOrderExpiryHours() * 3600_000)
      ).lastInsertRowid;
      expiresAt = db.prepare('SELECT expires_at FROM group_orders WHERE id = ?').get(orderId).expires_at;

      // 折扣：原價 = total（付款場次加總）。套用在同一 tx 內（防併發超用）。
      const applied = applyDiscountTx({ code: discountCode, phone, subtotal: total, kind: 'group_order', refId: orderId });
      if (applied) { discountAmount = applied.discountAmount; discountCode_ = applied.discountCode; finalTotal = applied.finalTotal; }
      db.prepare('UPDATE group_orders SET original_amount=?, discount_amount=?, discount_code=?, total_amount=? WHERE id=?')
        .run(originalAmount, discountAmount, discountCode_, finalTotal, orderId);

      for (const { sid, price, dup } of payRows) {
        if (dup) reactivateReg.run('pending', orderId, price, dup.id);
        else insertReg.run(sid, user.id, 'pending', orderId, price);
      }
    }

    // 候補桶（不付款；同單若有付款場次則掛同一張訂單，讓後台卡片能列出候補場次。
    // 逾期/取消只動 status='pending' 的列，候補列掛單不受影響）
    const waitlisted = [];
    for (const sid of waitlistSessionIds) {
      validateSelectable(sid);
      const dup = getAnyReg.get(sid, user.id);
      if (dup && ['pending', 'confirmed', 'waitlisted'].includes(dup.status)) continue;
      if (dup) reactivateReg.run('waitlisted', orderId, null, dup.id);
      else insertReg.run(sid, user.id, 'waitlisted', orderId, null);
      waitlisted.push(sid);
      // 加掛：通知該場次教練有人候補
      const ws = getSession.get(sid);
      const wtpl = getTemplate.get(ws.template_id);
      notifyCourseCoach({ coachId: ws.coach_id, sessionId: sid, type: 'course_waitlisted_coach',
        vars: { member_name: name.trim(), course_name: wtpl.name, start_at: ws.start_at } });
    }

    const result = { orderId, total: finalTotal, originalAmount, discountAmount, discountCode: discountCode_,
      bankInfo: getBankInfo(), expiresAt, waitlisted, memberId: user.id };
    // 綁定碼只發給一般會員（縱深防禦：Fix A 已擋員工電話，這裡再保險一次）。
    if (user.role === 'user' && !user.line_user_id) result.lineBindCode = generateBindCode(user.id).code;
    result.lineOfficialUrl = getLineOfficialUrl();
    return result;
  });
}

const getOrder = db.prepare('SELECT * FROM group_orders WHERE id = ?');
const getReg = db.prepare('SELECT * FROM registrations WHERE id = ?');
const getUserByPhone = db.prepare('SELECT * FROM users WHERE phone = ?');
const getUserBasics = db.prepare('SELECT name, phone FROM users WHERE id = ?');

function ownerMatches(user, phone, name) {
  return user && user.phone === phone && user.name &&
    user.name.trim().toLowerCase() === (name || '').trim().toLowerCase();
}

/** admin：待核對（pending 且未過期）訂單清單，含場次摘要。 */
export function listPendingOrders() {
  const now = nowLocal();
  const orders = db.prepare(`
    SELECT id, member_id, customer_name, customer_phone, total_amount, expires_at, created_at
    FROM group_orders WHERE status='pending' AND expires_at >= ?
    ORDER BY created_at ASC
  `).all(now);
  return orders.map((o) => ({
    ...o,
    // 含候補列（status='waitlisted'）：後台卡片標示「候補」，金額仍只計付款場次
    sessions: db.prepare(`
      SELECT s.start_at, t.name AS course_name, r.status
      FROM registrations r JOIN course_sessions s ON s.id=r.session_id
      JOIN course_templates t ON t.id=s.template_id
      WHERE r.order_id=? AND r.status IN ('pending','waitlisted') ORDER BY t.name ASC, s.start_at ASC
    `).all(o.id),
  }));
}

/** admin 核對匯款：order → paid，其 pending registrations → confirmed，通知客人。 */
export function confirmGroupOrder({ orderId, actorId }) {
  return tx(() => {
    const order = getOrder.get(orderId);
    if (!order) throw new ApiError(404, 'order_not_found');
    if (order.status === 'paid') return { ok: true };
    if (order.status === 'cancelled') throw new ApiError(409, 'order_cancelled');
    db.prepare("UPDATE group_orders SET status='paid', paid_at=?, paid_by=? WHERE id=?")
      .run(nowLocal(), actorId, orderId);
    db.prepare("UPDATE registrations SET status='confirmed' WHERE order_id=? AND status='pending'").run(orderId);
    // 通知客人（限已轉正取的付款場次；候補列也掛單，不能拿來當通知對象）
    const first = db.prepare("SELECT session_id FROM registrations WHERE order_id=? AND status='confirmed' LIMIT 1").get(orderId);
    if (first) {
      const s = getSession.get(first.session_id);
      const tpl = getTemplate.get(s.template_id);
      notify({ userId: order.member_id, sessionId: first.session_id, type: 'payment_received',
        vars: { course_name: tpl.name, start_at: s.start_at } });
    }
    // 加掛：整張訂單「彙整」通知教練與管理者（去重：教練收「你帶的」一則，
    // 非教練管理者每門課收摘要一則；同一人兼教練+管理者只收教練版那一則）。
    const confirmedSessions = db.prepare(`
      SELECT s.id AS session_id, s.coach_id, s.start_at, t.name AS course_name
      FROM registrations r JOIN course_sessions s ON s.id = r.session_id
      JOIN course_templates t ON t.id = s.template_id
      WHERE r.order_id = ? AND r.status = 'confirmed'
      ORDER BY s.start_at
    `).all(orderId);
    if (confirmedSessions.length) {
      const byCoachCourse = new Map(); // key: `${coach_id} ${course_name}`
      const byCourse = new Map();      // key: course_name
      for (const cs of confirmedSessions) {
        const ck = `${cs.coach_id} ${cs.course_name}`;
        if (!byCoachCourse.has(ck)) byCoachCourse.set(ck, { coachId: cs.coach_id, courseName: cs.course_name, sessionIds: [], dates: [] });
        const cg = byCoachCourse.get(ck);
        cg.sessionIds.push(cs.session_id); cg.dates.push(cs.start_at);
        if (!byCourse.has(cs.course_name)) byCourse.set(cs.course_name, { courseName: cs.course_name, dates: [] });
        byCourse.get(cs.course_name).dates.push(cs.start_at);
      }
      // 教練版（並收集所有教練 user_id，供管理者廣播排除）
      const coachUserIds = new Set();
      for (const g of byCoachCourse.values()) {
        const cuRow = getCoachUserIdStmt.get(g.coachId);
        if (cuRow) coachUserIds.add(cuRow.user_id);
        if (g.dates.length === 1) {
          notifyCourseCoach({ coachId: g.coachId, sessionId: g.sessionIds[0], type: 'course_registered_coach',
            vars: { member_name: order.customer_name, course_name: g.courseName, start_at: fmtMD(g.dates[0]) } });
        } else {
          notifyCourseCoach({ coachId: g.coachId, sessionId: g.sessionIds[0], type: 'course_registered_coach_batch',
            vars: { member_name: order.customer_name, course_name: g.courseName, count: g.dates.length, date_list: g.dates.map(fmtMD).join('、') } });
        }
      }
      // 管理者摘要版（每門課一則；排除 member + 所有帶課教練 user_id）
      const adminExclude = [order.member_id, ...coachUserIds];
      for (const g of byCourse.values()) {
        if (g.dates.length === 1) {
          notifyAdmins({ type: 'course_registered_admin', excludeUserIds: adminExclude,
            vars: { member_name: order.customer_name, course_name: g.courseName, start_at: fmtMD(g.dates[0]) } });
        } else {
          notifyAdmins({ type: 'course_registered_admin_batch', excludeUserIds: adminExclude,
            vars: { member_name: order.customer_name, course_name: g.courseName, count: g.dates.length, date_list: g.dates.map(fmtMD).join('、') } });
        }
      }
    }
    return { ok: true };
  });
}

/** 取消整筆未付 order（只有 pending 可整筆放棄）。釋名額後遞補。 */
export function cancelGroupOrder({ orderId, phone, name }) {
  return tx(() => {
    const order = getOrder.get(orderId);
    if (!order) throw new ApiError(404, 'order_not_found');
    const user = getUserByPhone.get(phone);
    if (!ownerMatches(user, phone, name) || user.id !== order.member_id) throw new ApiError(403, 'forbidden');
    if (order.status === 'paid') throw new ApiError(409, 'order_already_paid');
    if (order.status === 'cancelled') return { ok: true };
    const regs = db.prepare("SELECT session_id FROM registrations WHERE order_id=? AND status='pending'").all(orderId);
    db.prepare("UPDATE registrations SET status='cancelled' WHERE order_id=? AND status='pending'").run(orderId);
    db.prepare("UPDATE group_orders SET status='cancelled', cancelled_at=? WHERE id=?").run(nowLocal(), orderId);
    releaseRedemption({ kind: 'group_order', refId: orderId });
    for (const r of regs) promoteWaitlist(r.session_id);
    return { ok: true };
  });
}

/** admin 取消「已收款」的團課訂單並退款（已核對匯款卡片長按）。
 *  整單取消：confirmed/pending 列取消並釋名額 → 各場次遞補候補（遞補者產生新的
 *  待付款訂單，回到「待核對匯款」）；掛單的候補列一併取消（整單退場）。
 *  金流由店家線下退回，系統記錄 refunded_at/by；訂單保留在已核對清單供對帳。 */
export function refundGroupOrder({ orderId, actorId }) {
  return tx(() => {
    const order = getOrder.get(orderId);
    if (!order) throw new ApiError(404, 'order_not_found');
    if (!order.paid_at) throw new ApiError(409, 'not_paid');
    if (order.refunded_at) throw new ApiError(409, 'already_refunded');
    const now = nowLocal();
    // 佔名額的列（confirmed / pending）先記下場次，取消後逐場遞補
    const occupying = db.prepare(
      "SELECT session_id FROM registrations WHERE order_id=? AND status IN ('confirmed','pending') AND on_leave = 0"
    ).all(orderId);
    db.prepare(
      "UPDATE registrations SET status='cancelled' WHERE order_id=? AND status IN ('confirmed','pending','waitlisted')"
    ).run(orderId);
    db.prepare("UPDATE group_orders SET status='cancelled', cancelled_at=?, refunded_at=?, refunded_by=? WHERE id=?")
      .run(now, now, actorId, orderId);
    releaseRedemption({ kind: 'group_order', refId: orderId });
    for (const r of occupying) promoteWaitlist(r.session_id);
    notify({ userId: order.member_id, sessionId: null, type: 'group_order_refunded',
      vars: { amount_text: order.total_amount != null ? `（NT$${order.total_amount}）` : '' } });
    return { ok: true, releasedSessions: occupying.length };
  });
}

const countActiveOrderRegsStmt = db.prepare(
  "SELECT COUNT(*) AS c FROM registrations WHERE order_id = ? AND status IN ('pending','confirmed','waitlisted')"
);
/** Release a group order's discount redemption only when the order has NO remaining active
 *  registrations — so a multi-session order doesn't lose its discount when only one session is cancelled. */
export function releaseOrderRedemptionIfInactive(orderId) {
  if (!orderId) return;
  if (countActiveOrderRegsStmt.get(orderId).c === 0) {
    releaseRedemption({ kind: 'group_order', refId: orderId });
  }
}

/** 取消單筆 confirmed / waitlisted registration。釋名額後遞補。 */
export function cancelRegistrationPublic({ registrationId, phone, name }) {
  return tx(() => {
    const reg = getReg.get(registrationId);
    if (!reg) throw new ApiError(404, 'registration_not_found');
    const user = getUserByPhone.get(phone);
    if (!ownerMatches(user, phone, name) || user.id !== reg.user_id) throw new ApiError(403, 'forbidden');
    if (reg.status === 'cancelled') return { ok: true };
    if (reg.status === 'pending') throw new ApiError(409, 'use_cancel_order'); // pending 要走整筆放棄
    const wasOccupying = reg.status === 'confirmed';
    db.prepare("UPDATE registrations SET status='cancelled' WHERE id=?").run(registrationId);
    releaseOrderRedemptionIfInactive(reg.order_id);
    if (wasOccupying) {
      // 加掛：通知該場次教練有會員取消（confirmed 才通知；候補取消不打擾教練）
      const cs = getSession.get(reg.session_id);
      const ctpl = getTemplate.get(cs.template_id);
      notifyCourseCoach({ coachId: cs.coach_id, sessionId: reg.session_id, type: 'course_member_cancelled_coach',
        vars: { member_name: user.name, course_name: ctpl.name, start_at: cs.start_at } });
      promoteWaitlist(reg.session_id);
    }
    return { ok: true };
  });
}

/**
 * 團課「今日請假」：已付款(confirmed)會員針對某場次請假。
 * 標記 on_leave=1（status 維持 confirmed、不退款、不取消訂單），釋出名額並遞補候補，通知該堂課教練。
 * 不可逆（v1）。僅開課前可請假。
 */
export function takeLeavePublic({ registrationId, phone, name }) {
  return tx(() => {
    const reg = getReg.get(registrationId);
    if (!reg) throw new ApiError(404, 'registration_not_found');
    const user = getUserByPhone.get(phone);
    if (!ownerMatches(user, phone, name) || user.id !== reg.user_id) throw new ApiError(403, 'forbidden');
    if (reg.status !== 'confirmed') throw new ApiError(409, 'not_confirmed');   // pending 走放棄、waitlisted 走取消
    if (reg.on_leave) throw new ApiError(409, 'already_on_leave');
    const session = getSession.get(reg.session_id);
    if (!session || session.status === 'cancelled') throw new ApiError(409, 'session_unavailable');
    if (nowLocal() >= session.start_at) throw new ApiError(409, 'session_started');  // 僅開課前可請假
    const tpl = getTemplate.get(session.template_id);
    // 標記請假：保留 confirmed、不退款、不取消訂單；on_leave=1 後不再佔名額。
    db.prepare('UPDATE registrations SET on_leave = 1 WHERE id = ?').run(registrationId);
    // 釋名額 → 遞補候補（沿用既有流程，會發候補遞補通知 + 教練遞補通知）
    promoteWaitlist(reg.session_id);
    // 通知該堂課教練
    notifyCourseCoach({ coachId: session.coach_id, sessionId: session.id, type: 'course_member_leave_coach',
      vars: { member_name: user.name, course_name: tpl.name, start_at: session.start_at } });
    return { ok: true };
  });
}

const getWaitQueue = db.prepare(
  "SELECT * FROM registrations WHERE session_id=? AND status='waitlisted' ORDER BY registered_at ASC, id ASC"
);

/** 若該場有空位，取最早候補 → pending + 建 24h 單堂 order，通知客人。 */
export function promoteWaitlist(sessionId) {
  return tx(() => {
    const s = getSession.get(sessionId);
    if (!s || s.status === 'cancelled') return;
    if (s.start_at <= nowLocal()) return;  // 已開始/已結束不遞補：避免把候補塞進上完的課還開 24h 付款單
    const tpl = getTemplate.get(s.template_id);
    if (sessionOccupied(sessionId) >= tpl.max_capacity) return;
    const next = getWaitQueue.get(sessionId);
    if (!next) return;
    const u = getUserBasics.get(next.user_id);
    if (!u) return;  // FK guarantees this, but stay defensive
    // 併單：同會員既有「未逾期 pending」訂單 → 掛同一張（一張卡、一次匯款；多場
    // 連續遞補不會一場一卡）。金額累加、期限延長到至少 now+24h 保障付款時間。
    // 無既有訂單才開新 24h 單。
    const existing = db.prepare(
      "SELECT id FROM group_orders WHERE member_id=? AND status='pending' AND expires_at >= ? ORDER BY id DESC LIMIT 1"
    ).get(next.user_id, nowLocal());
    let orderId;
    const isNewOrder = !existing;
    if (existing) {
      orderId = existing.id;
      db.prepare(`
        UPDATE group_orders
        SET total_amount = total_amount + ?,
            original_amount = COALESCE(original_amount, 0) + ?,
            expires_at = MAX(expires_at, ?)
        WHERE id = ?
      `).run(tpl.price_per_session, tpl.price_per_session, offsetLocal(PROMOTED_TTL_MS), orderId);
    } else {
      orderId = insertOrder.run(
        next.user_id,
        u.name,
        u.phone || '',
        tpl.price_per_session,
        offsetLocal(PROMOTED_TTL_MS)
      ).lastInsertRowid;
      db.prepare('UPDATE group_orders SET original_amount = ? WHERE id = ?').run(tpl.price_per_session, orderId);
    }
    db.prepare("UPDATE registrations SET status='pending', order_id=?, amount_due=? WHERE id=?")
      .run(orderId, tpl.price_per_session, next.id);
    // 會員通知只在「開新單」時發一次（連續遞補併單不逐場轟炸；明細看我的課表/後台卡片）
    if (isNewOrder) {
      notify({ userId: next.user_id, sessionId, type: 'group_promoted',
        vars: { course_name: tpl.name, start_at: s.start_at } });
    }
    // 教練通知維持逐場（各場教練不同，各自只收自己的場次）
    notifyCourseCoach({ coachId: s.coach_id, sessionId, type: 'course_promoted_coach',
      vars: { member_name: u.name, course_name: tpl.name, start_at: s.start_at } });
  });
}

/** 把所有逾時未付 pending order → cancelled，釋名額後對受影響場次遞補。 */
export function expirePendingOrders() {
  const now = nowLocal();
  const stale = db.prepare("SELECT id FROM group_orders WHERE status='pending' AND expires_at < ?").all(now);
  let expired = 0;
  for (const { id } of stale) {
    // 每筆獨立 tx + try/catch：單筆失敗不中斷整輪 sweep（下一輪會再掃到）
    try {
      tx(() => {
        const regs = db.prepare("SELECT session_id FROM registrations WHERE order_id=? AND status='pending'").all(id);
        db.prepare("UPDATE registrations SET status='cancelled' WHERE order_id=? AND status='pending'").run(id);
        db.prepare("UPDATE group_orders SET status='cancelled', cancelled_at=? WHERE id=?").run(now, id);
        releaseRedemption({ kind: 'group_order', refId: id });
        for (const r of regs) promoteWaitlist(r.session_id);
      });
      expired++;
    } catch (e) {
      console.error(`[expirePendingOrders] order #${id} failed, will retry next sweep:`, e);
    }
  }
  return { expired };
}

/** admin 補報名：管理者從範本 drawer 為客人補一場報名。
 *  paid=true → 獨立「已核對」訂單＋confirmed（已付款的單不事後長大）；
 *  paid=false → 併入該客人未逾期 pending 單（金額累加、期限取 max(now+72h)），無則開新 72h 單；
 *  滿額：未來場次 → 候補（不收款、不建單）；過去場次 → 409（候補對過去無意義）。
 *  不支援折扣碼；只通知教練（業主定案）。 */
export function adminBackfillRegistration({ sessionId, userId = null, name = null, phone = null, paid = false, actorId }) {
  return tx(() => {
    const s = getSession.get(sessionId);
    if (!s) throw new ApiError(404, 'session_not_found');
    if (s.status === 'cancelled') throw new ApiError(409, 'session_cancelled');
    const tpl = getTemplate.get(s.template_id);
    if (!tpl) throw new ApiError(404, 'template_not_found');

    // 解析客人：userId 優先（僅限一般會員）；否則姓名＋電話（選填）find-or-create，與登錄預約同規則
    let user;
    if (userId) {
      user = db.prepare("SELECT * FROM users WHERE id = ? AND role = 'user'").get(userId);
      if (!user) throw new ApiError(404, 'user_not_found');
    } else {
      const hasPhone = phone != null && String(phone).trim() !== '';
      user = hasPhone ? findOrCreateUserByPhone({ phone: String(phone).trim(), name })
                      : createCustomerNoPhone({ name });
    }

    const dup = getAnyReg.get(sessionId, user.id);
    if (dup && ['pending', 'confirmed', 'waitlisted'].includes(dup.status)) {
      throw new ApiError(409, 'already_registered');
    }

    const now = nowLocal();
    const isPast = s.start_at <= now;
    const price = tpl.price_per_session;

    if (sessionIsFull(sessionId)) {
      if (isPast) throw new ApiError(409, 'session_full');
      if (paid) throw new ApiError(400, 'paid_requires_seat'); // UI 已擋，後端防呆
      let regId;
      if (dup) { reactivateReg.run('waitlisted', null, null, dup.id); regId = dup.id; }
      else regId = insertReg.run(sessionId, user.id, 'waitlisted', null, null).lastInsertRowid;
      notifyCourseCoach({ coachId: s.coach_id, sessionId, type: 'course_waitlisted_coach',
        vars: { member_name: user.name, course_name: tpl.name, start_at: s.start_at } });
      return { ok: true, registrationId: Number(regId), orderId: null, status: 'waitlisted' };
    }

    let orderId, regStatus;
    if (paid) {
      orderId = Number(insertOrder.run(user.id, user.name, user.phone || '', price, now).lastInsertRowid);
      db.prepare("UPDATE group_orders SET status='paid', paid_at=?, paid_by=?, original_amount=? WHERE id=?")
        .run(now, actorId, price, orderId);
      regStatus = 'confirmed';
    } else {
      const existing = db.prepare(
        "SELECT id FROM group_orders WHERE member_id=? AND status='pending' AND expires_at >= ? ORDER BY id DESC LIMIT 1"
      ).get(user.id, now);
      const expiry = offsetLocal(getGroupOrderExpiryHours() * 3600_000);
      if (existing) {
        orderId = existing.id;
        db.prepare(`
          UPDATE group_orders
          SET total_amount = total_amount + ?, original_amount = COALESCE(original_amount, 0) + ?,
              expires_at = MAX(expires_at, ?)
          WHERE id = ?
        `).run(price, price, expiry, orderId);
      } else {
        orderId = Number(insertOrder.run(user.id, user.name, user.phone || '', price, expiry).lastInsertRowid);
        db.prepare('UPDATE group_orders SET original_amount = ? WHERE id = ?').run(price, orderId);
      }
      regStatus = 'pending';
    }

    let regId;
    if (dup) { reactivateReg.run(regStatus, orderId, price, dup.id); regId = dup.id; }
    else regId = insertReg.run(sessionId, user.id, regStatus, orderId, price).lastInsertRowid;

    notifyCourseCoach({ coachId: s.coach_id, sessionId, type: 'course_registered_coach',
      vars: { member_name: user.name, course_name: tpl.name, start_at: fmtMD(s.start_at) } });
    return { ok: true, registrationId: Number(regId), orderId, status: regStatus };
  });
}

/** admin 取消單筆報名（範本 drawer 名單列）。
 *  waitlisted → 直接取消；
 *  pending（掛待核對訂單）→ 取消並重算訂單金額（折扣同碼對新小計重新報價、不動用量；
 *    碼已失效 → 折扣歸零）；最後一場 → 整單取消＋釋放折扣；
 *  confirmed＋訂單已收款 → 取消並寫 group_order_refunds 部分退款
 *    （預設該場 amount_due，可帶 refundAmount 調整，0 ≤ 整數 ≤ amount_due）；訂單維持 paid；
 *  confirmed＋無訂單（舊資料）→ 只標取消。
 *  釋名額後遞補（promoteWaitlist 內建過去場次守門）；只通知教練。 */
export function adminCancelRegistration({ registrationId, actorId, refundAmount = null }) {
  return tx(() => {
    const reg = getReg.get(registrationId);
    if (!reg) throw new ApiError(404, 'registration_not_found');
    if (!['pending', 'confirmed', 'waitlisted'].includes(reg.status)) throw new ApiError(409, 'not_cancellable');
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(reg.user_id);
    const s = getSession.get(reg.session_id);
    const tpl = getTemplate.get(s.template_id);
    const order = reg.order_id ? getOrder.get(reg.order_id) : null;
    const wasOccupying = reg.status === 'confirmed' || reg.status === 'pending';
    const now = nowLocal();

    db.prepare("UPDATE registrations SET status='cancelled' WHERE id=?").run(registrationId);

    if (reg.status === 'pending' && order && order.status === 'pending') {
      const remaining = db.prepare(
        "SELECT COALESCE(SUM(amount_due), 0) AS subtotal, COUNT(*) AS c FROM registrations WHERE order_id=? AND status='pending'"
      ).get(order.id);
      if (remaining.c === 0) {
        // 最後一場付款場次 → 整單取消（掛單候補列維持候補，遞補時會開自己的單）
        db.prepare("UPDATE group_orders SET status='cancelled', cancelled_at=? WHERE id=?").run(now, order.id);
        releaseRedemption({ kind: 'group_order', refId: order.id });
      } else {
        let discountAmount = null, finalTotal = remaining.subtotal;
        if (order.discount_code) {
          try {
            const q = quoteDiscount({ code: order.discount_code, amount: remaining.subtotal });
            if (q) { discountAmount = q.discountAmount; finalTotal = q.finalTotal; }
          } catch { /* 折扣碼已失效/停用 → 折扣歸零，應付=新原價 */ }
        }
        db.prepare('UPDATE group_orders SET original_amount=?, discount_amount=?, total_amount=? WHERE id=?')
          .run(remaining.subtotal, discountAmount, finalTotal, order.id);
      }
    } else if (reg.status === 'confirmed' && order && order.paid_at) {
      let amount = reg.amount_due ?? 0;
      if (refundAmount != null) {
        if (!Number.isInteger(refundAmount) || refundAmount < 0 || refundAmount > (reg.amount_due ?? 0)) {
          throw new ApiError(400, 'invalid_refund_amount');
        }
        amount = refundAmount;
      }
      db.prepare('INSERT INTO group_order_refunds (order_id, registration_id, amount, refunded_at, refunded_by) VALUES (?, ?, ?, ?, ?)')
        .run(order.id, registrationId, amount, now, actorId);
    } else {
      // waitlisted 或 legacy confirmed（order_id NULL / 訂單非 paid）：無金流；整單已無 active 列則釋放折扣
      releaseOrderRedemptionIfInactive(reg.order_id);
    }

    if (wasOccupying) {
      notifyCourseCoach({ coachId: s.coach_id, sessionId: reg.session_id, type: 'course_member_cancelled_coach',
        vars: { member_name: user.name, course_name: tpl.name, start_at: s.start_at } });
      promoteWaitlist(reg.session_id);
    }
    return { ok: true };
  });
}

/** 公開：所有「尚有可報名場次」的 published template，回完整週期（不可報名場次帶 state 供灰色顯示）。 */
export function getPublicGroupCourses() {
  const now = nowLocal();
  const templates = db.prepare(`
    SELECT t.id, t.name, t.description, t.min_capacity, t.max_capacity, t.duration_minutes,
           t.price_per_session, t.recurrence, t.cycle_start_date, t.cycle_end_date,
           c.display_name AS coach_name
    FROM course_templates t
    LEFT JOIN coaches c ON c.id = t.coach_id
    WHERE t.status = 'published'
    ORDER BY t.created_at DESC
  `).all();
  return templates.map((t) => {
    // 完整週期：過去/已截止/流課場次一併回傳（前端灰色顯示、不可點）。
    // 唯一仍隱藏的是「未來、open、被管理者暫停(is_open=0)」的場次（暫停＝對客人完全隱藏）。
    const sessions = db.prepare(`
      SELECT id, session_date, start_at, end_at, status, registration_deadline, is_open
      FROM course_sessions
      WHERE template_id = ? AND NOT (start_at > ? AND status = 'open' AND is_open = 0)
      ORDER BY start_at ASC
    `).all(t.id, now).map((s) => {
      const occupied = sessionOccupied(s.id);
      // 額滿徽章顯示目前候補人數用
      const waitlistCount = db.prepare("SELECT COUNT(*) AS c FROM registrations WHERE session_id=? AND status='waitlisted'").get(s.id).c;
      // selectable 比照送單側 validateSelectable，另補截止時間（processDeadlines 整點批次前的空窗）
      const selectable = s.status === 'open' && s.is_open === 1 && s.start_at > now
        && (!s.registration_deadline || s.registration_deadline > now);
      const state = selectable ? 'selectable'
        : s.status === 'cancelled' ? 'not_held'
        : s.start_at <= now ? 'ended'
        : 'deadline_passed';
      return {
        ...s, occupied, max_capacity: t.max_capacity,
        is_full: occupied >= t.max_capacity,
        waitlist_count: waitlistCount,
        price_per_session: t.price_per_session,
        selectable, state,
      };
    });
    return { ...t, sessions };
  }).filter((t) => t.sessions.some((s) => s.selectable));
}

/** 公開：用電話+姓名查課表（1v1 bookings + group registrations）+ 剩堂數。 */
export function getPublicSchedule({ phone, name }) {
  const user = getUserByPhoneAndName({ phone, name });
  if (!user) throw new ApiError(403, 'not_found_or_mismatch');
  const now = nowLocal();

  const bookings = db.prepare(`
    SELECT b.id, b.start_at, b.end_at, b.status, b.session_type, b.paid_at, c.display_name AS coach_display_name
    FROM bookings b JOIN coaches c ON c.id = b.coach_id
    WHERE b.member_id = ? AND b.status != 'cancelled' ORDER BY b.start_at DESC
  `).all(user.id).map((b) => ({
    kind: 'booking', id: b.id, start_at: b.start_at, end_at: b.end_at,
    status: b.status, session_type: b.session_type, coach_display_name: b.coach_display_name,
    paid: !!b.paid_at,
    is_past: b.start_at < now,
    can_cancel: b.status === 'confirmed' && b.start_at > now,
  }));

  const regs = db.prepare(`
    SELECT r.id, r.status, r.amount_due, r.order_id, r.on_leave,
           s.id AS session_id, s.start_at, s.end_at, s.status AS session_status,
           t.name AS course_name, o.status AS order_status, o.expires_at AS order_expires_at,
           o.total_amount, o.id AS oid,
           o.total_amount AS order_total, o.discount_amount AS order_discount
    FROM registrations r
    JOIN course_sessions s ON s.id = r.session_id
    JOIN course_templates t ON t.id = s.template_id
    LEFT JOIN group_orders o ON o.id = r.order_id
    WHERE r.user_id = ? AND r.status != 'cancelled'
    ORDER BY s.start_at DESC
  `).all(user.id).map((r) => ({
    kind: 'registration', id: r.id, status: r.status,
    start_at: r.start_at, end_at: r.end_at, session_id: r.session_id,
    course_name: r.course_name, session_status: r.session_status,
    order_id: r.order_id, order_status: r.order_status, order_expires_at: r.order_expires_at,
    amount_due: r.amount_due, is_past: r.start_at < now,
    on_leave: !!r.on_leave,
    can_cancel: ['confirmed', 'waitlisted'].includes(r.status) && !r.on_leave && r.session_status === 'open' && r.start_at > now,
    can_leave: r.status === 'confirmed' && !r.on_leave && r.session_status === 'open' && r.start_at > now,
    order_total: r.order_total, order_discount: r.order_discount,
  }));

  // 剩堂數 = 已付款(confirmed) 且未上(start_at>now)；請假(on_leave)不計入
  const one_on_one_remaining = bookings.filter((b) => b.status === 'confirmed' && !b.is_past).length;
  const group_remaining = regs.filter((r) => r.status === 'confirmed' && !r.is_past && !r.on_leave).length;

  const items = [...bookings, ...regs].sort((a, b) => b.start_at.localeCompare(a.start_at));
  const stats = {
    one_done: bookings.filter((b) => b.status === 'confirmed' && b.is_past).length,
    group_done: regs.filter((r) => r.status === 'confirmed' && r.is_past && !r.on_leave && r.session_status !== 'cancelled').length,
    leave_count: regs.filter((r) => r.on_leave).length,
    one_upcoming: one_on_one_remaining,
    group_upcoming: group_remaining,
  };
  const packages = listScheduleViewPackages(user.id, now);
  return {
    user: { name: user.name, phone: user.phone },
    items, one_on_one_remaining, group_remaining,
    line_bound: user.role === 'user' ? !!user.line_user_id : null,
    packages,
    stats,
  };
}
