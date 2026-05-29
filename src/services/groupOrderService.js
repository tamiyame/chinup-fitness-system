import { db, tx, nowLocal, offsetLocal } from '../db/connection.js';
import { ApiError } from './registration.js';
import { findOrCreateUserByPhone } from './userService.js';
import { notify } from './notifications.js';

// 收款資訊（健身房固定，可改用環境變數）
export const BANK_INFO = process.env.BANK_INFO || '玉山銀行 (808) 1234-567-890123 戶名：CHINUP';
const PENDING_TTL_MS = 6 * 60 * 60 * 1000;       // 一般 pending 6h
const PROMOTED_TTL_MS = 24 * 60 * 60 * 1000;     // 遞補後 24h

const getSession = db.prepare('SELECT * FROM course_sessions WHERE id = ?');
const getTemplate = db.prepare('SELECT * FROM course_templates WHERE id = ?');
const getAnyReg = db.prepare('SELECT * FROM registrations WHERE session_id = ? AND user_id = ?');

// 已佔名額：confirmed 一律算（含舊 member-flow 遷移過來、order_id 為 NULL 的列）；
// pending 只在其訂單未過期時算。waitlisted 不算。
const occupiedStmt = db.prepare(`
  SELECT COUNT(*) AS c
  FROM registrations r
  LEFT JOIN group_orders o ON o.id = r.order_id
  WHERE r.session_id = ?
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
export function createGroupOrder({ name, phone, paySessionIds = [], waitlistSessionIds = [] }) {
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

    const orderId = insertOrder.run(
      user.id, name.trim(), phone, total, offsetLocal(PENDING_TTL_MS)
    ).lastInsertRowid;
    const order = db.prepare('SELECT expires_at FROM group_orders WHERE id = ?').get(orderId);

    for (const { sid, price, dup } of payRows) {
      if (dup) reactivateReg.run('pending', orderId, price, dup.id);
      else insertReg.run(sid, user.id, 'pending', orderId, price);
    }

    // 候補桶（不付款）
    const waitlisted = [];
    for (const sid of waitlistSessionIds) {
      validateSelectable(sid);
      const dup = getAnyReg.get(sid, user.id);
      if (dup && ['pending', 'confirmed', 'waitlisted'].includes(dup.status)) continue;
      if (dup) reactivateReg.run('waitlisted', null, null, dup.id);
      else insertReg.run(sid, user.id, 'waitlisted', null, null);
      waitlisted.push(sid);
    }

    return { orderId, total, bankInfo: BANK_INFO, expiresAt: order.expires_at, waitlisted, memberId: user.id };
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
    // 通知客人
    const first = db.prepare('SELECT session_id FROM registrations WHERE order_id=? LIMIT 1').get(orderId);
    if (first) {
      const s = getSession.get(first.session_id);
      const tpl = getTemplate.get(s.template_id);
      notify({ userId: order.member_id, sessionId: first.session_id, type: 'payment_received',
        vars: { course_name: tpl.name, start_at: s.start_at } });
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
    for (const r of regs) promoteWaitlist(r.session_id);
    return { ok: true };
  });
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
    if (wasOccupying) promoteWaitlist(reg.session_id);
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
    const tpl = getTemplate.get(s.template_id);
    if (sessionOccupied(sessionId) >= tpl.max_capacity) return;
    const next = getWaitQueue.get(sessionId);
    if (!next) return;
    const u = getUserBasics.get(next.user_id);
    if (!u) return;  // FK guarantees this, but stay defensive
    const orderId = insertOrder.run(
      next.user_id,
      u.name,
      u.phone || '',
      tpl.price_per_session,
      offsetLocal(PROMOTED_TTL_MS)
    ).lastInsertRowid;
    db.prepare("UPDATE registrations SET status='pending', order_id=?, amount_due=? WHERE id=?")
      .run(orderId, tpl.price_per_session, next.id);
    notify({ userId: next.user_id, sessionId, type: 'group_promoted',
      vars: { course_name: tpl.name, start_at: s.start_at } });
  });
}
