import assert from 'node:assert/strict';
import { db } from '../src/db/connection.js';
import { createTemplate } from '../src/services/courseService.js';
import {
  createGroupOrder, confirmGroupOrder, refundGroupOrder, promoteWaitlist, sessionOccupied,
  adminBackfillRegistration, adminCancelRegistration,
} from '../src/services/groupOrderService.js';
import { listConfirmedPayments } from '../src/services/bookingService.js';

function expect(label, fn) {
  try { fn(); console.log(`  ✓ ${label}`); }
  catch (e) { console.log(`  ✗ ${label}`); console.error(e); process.exitCode = 1; }
}
function reset() {
  db.exec(`
    DELETE FROM group_order_refunds;
    DELETE FROM discount_redemptions;
    DELETE FROM registrations;
    DELETE FROM group_orders;
    DELETE FROM course_sessions;
    DELETE FROM course_templates;
    DELETE FROM discount_codes WHERE code LIKE 'AGR%';
    DELETE FROM notifications WHERE user_id IN (SELECT id FROM users WHERE phone LIKE '0996%' OR name LIKE 'AGR-%');
    DELETE FROM users WHERE phone LIKE '0996%' OR name LIKE 'AGR-%';
  `);
}
function dstr(days) { const d = new Date(); d.setDate(d.getDate() + days); const p = (n) => String(n).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`; }
function dt(days, time) { return `${dstr(days)}T${time}`; }
function agePast(sessionId, daysAgo = 3) {
  db.prepare("UPDATE course_sessions SET session_date=?, start_at=?, end_at=?, registration_deadline=? WHERE id=?")
    .run(dstr(-daysAgo), dt(-daysAgo, '19:00:00'), dt(-daysAgo, '20:00:00'), dt(-daysAgo, '18:00:00'), sessionId);
}

console.log('[admin-group-reg test] start');

// ── §1 migration ──────────────────────────────────────────────
expect('group_order_refunds 表存在且欄位齊全', () => {
  const cols = db.prepare('PRAGMA table_info(group_order_refunds)').all().map((c) => c.name);
  for (const c of ['id', 'order_id', 'registration_id', 'amount', 'refunded_at', 'refunded_by', 'created_at']) {
    assert.ok(cols.includes(c), `missing column ${c}`);
  }
});

// ── §2 promoteWaitlist 過去場次守門 ───────────────────────────
reset();
{
  const tpl = createTemplate({
    name: 'AGR-守門班', min_capacity: 1, max_capacity: 1,
    day_of_week: ((new Date()).getDay() + 2) % 7, start_time: '19:00',
    recurrence: 'weekly', cycle_start_date: dstr(1), cycle_end_date: dstr(15),
    registration_deadline_hours: 1, price_per_session: 500,
  });
  const sid = db.prepare('SELECT id FROM course_sessions WHERE template_id=? ORDER BY start_at ASC').get(tpl.templateId).id;
  const oA = createGroupOrder({ name: 'AGR-甲', phone: '0996200001', paySessionIds: [sid], waitlistSessionIds: [] });
  const actorId = oA.memberId;
  confirmGroupOrder({ orderId: oA.orderId, actorId });
  createGroupOrder({ name: 'AGR-乙', phone: '0996200002', paySessionIds: [], waitlistSessionIds: [sid] });
  agePast(sid);

  // 先把甲的報名直接標取消（raw SQL、不經 refund，避免觸發遞補），讓名額真正空出：
  // 沒有 start_at 守門時，直接呼叫 promoteWaitlist 會把乙遞補成 pending 並開 24h 單。
  db.prepare("UPDATE registrations SET status='cancelled' WHERE order_id=?").run(oA.orderId);
  promoteWaitlist(sid);
  expect('過去場次：名額已空、直接呼叫仍不遞補', () => {
    assert.equal(sessionOccupied(sid), 0);  // 前置確認：名額確實已空，走不到滿額短路
    const b = db.prepare("SELECT r.status FROM registrations r JOIN users u ON u.id=r.user_id WHERE u.phone='0996200002' AND r.session_id=?").get(sid);
    assert.equal(b.status, 'waitlisted');
    assert.equal(db.prepare("SELECT COUNT(*) AS c FROM group_orders o JOIN users u ON u.id=o.member_id WHERE u.phone='0996200002'").get().c, 0);
  });

  // 還原甲為 confirmed，改走「整單退款」路徑（refundGroupOrder 內部會取消甲並呼叫 promoteWaitlist）
  db.prepare("UPDATE registrations SET status='confirmed' WHERE order_id=?").run(oA.orderId);
  refundGroupOrder({ orderId: oA.orderId, actorId });
  expect('過去場次：整單退款也不遞補', () => {
    const b = db.prepare("SELECT r.status FROM registrations r JOIN users u ON u.id=r.user_id WHERE u.phone='0996200002' AND r.session_id=?").get(sid);
    assert.equal(b.status, 'waitlisted');
    assert.equal(db.prepare("SELECT COUNT(*) AS c FROM group_orders o JOIN users u ON u.id=o.member_id WHERE u.phone='0996200002'").get().c, 0);
  });
}

// ── §3 adminBackfillRegistration ──────────────────────────────
reset();
{
  const tpl = createTemplate({
    name: 'AGR-補班', min_capacity: 1, max_capacity: 2,
    day_of_week: ((new Date()).getDay() + 2) % 7, start_time: '19:00',
    recurrence: 'weekly', cycle_start_date: dstr(1), cycle_end_date: dstr(40),
    registration_deadline_hours: 1, price_per_session: 500,
  });
  const ss = db.prepare('SELECT id FROM course_sessions WHERE template_id=? ORDER BY start_at ASC').all(tpl.templateId).map((r) => r.id);
  const [sA, sB, sC, sD] = ss;
  const actorId = Number(db.prepare("INSERT INTO users (name, email, role, is_admin) VALUES ('AGR-管理', 'agr-admin@x.com', 'coach', 1)").run().lastInsertRowid);

  // a) 已收款補報（新客人姓名+電話）→ 獨立 paid 單 + confirmed
  const r1 = adminBackfillRegistration({ sessionId: sA, name: 'AGR-丙', phone: '0996300001', paid: true, actorId });
  expect('paid 補報 → confirmed + 獨立已核對訂單', () => {
    assert.equal(r1.status, 'confirmed');
    const o = db.prepare('SELECT * FROM group_orders WHERE id=?').get(r1.orderId);
    assert.equal(o.status, 'paid'); assert.equal(o.paid_by, actorId);
    assert.ok(o.paid_at); assert.equal(o.total_amount, 500); assert.equal(o.original_amount, 500);
    const reg = db.prepare('SELECT * FROM registrations WHERE id=?').get(r1.registrationId);
    assert.equal(reg.status, 'confirmed'); assert.equal(reg.amount_due, 500); assert.equal(reg.order_id, r1.orderId);
    assert.equal(sessionOccupied(sA), 1);
  });

  // b) 待核對補報（無既有單）→ 新 pending 單（72h）
  const r2 = adminBackfillRegistration({ sessionId: sA, name: 'AGR-丁', phone: '0996300002', paid: false, actorId });
  expect('pending 補報 → 新待核對訂單', () => {
    assert.equal(r2.status, 'pending');
    const o = db.prepare('SELECT * FROM group_orders WHERE id=?').get(r2.orderId);
    assert.equal(o.status, 'pending');
    assert.ok(o.expires_at > dt(0, '00:00:00'));
  });

  // c) 同客人再補另一場 → 併入同一張 pending 單、金額累加
  const r3 = adminBackfillRegistration({ sessionId: sB, name: 'AGR-丁', phone: '0996300002', paid: false, actorId });
  expect('pending 補報 → 併單、金額累加', () => {
    assert.equal(r3.orderId, r2.orderId);
    const o = db.prepare('SELECT * FROM group_orders WHERE id=?').get(r2.orderId);
    assert.equal(o.total_amount, 1000); assert.equal(o.original_amount, 1000);
  });

  // d) 滿額未來場次 → 候補（不建單）；paid+滿額 → 400
  //（sA 此刻已滿：丙 confirmed ＋ 丁 pending，cap=2）
  const r4 = adminBackfillRegistration({ sessionId: sA, name: 'AGR-己', phone: '0996300004', paid: false, actorId });
  expect('滿額未來場次 → waitlisted、無訂單', () => {
    assert.equal(r4.status, 'waitlisted'); assert.equal(r4.orderId, null);
    const reg = db.prepare('SELECT * FROM registrations WHERE id=?').get(r4.registrationId);
    assert.equal(reg.order_id, null); assert.equal(reg.amount_due, null);
  });
  expect('滿額 + paid → 400 paid_requires_seat', () => {
    try { adminBackfillRegistration({ sessionId: sA, name: 'AGR-庚', phone: '0996300005', paid: true, actorId }); assert.fail('no throw'); }
    catch (e) { assert.equal(e.status, 400); assert.equal(e.message, 'paid_requires_seat'); }
  });

  // e) 過去場次：未滿可補（paid）；滿了 → 409 session_full
  agePast(sC);
  const r5 = adminBackfillRegistration({ sessionId: sC, name: 'AGR-辛', phone: '0996300006', paid: true, actorId });
  expect('過去未滿場次可補登（confirmed）', () => assert.equal(r5.status, 'confirmed'));
  adminBackfillRegistration({ sessionId: sC, name: 'AGR-壬', phone: '0996300007', paid: true, actorId }); // sC 滿
  expect('過去滿額場次 → 409 session_full', () => {
    try { adminBackfillRegistration({ sessionId: sC, name: 'AGR-癸', phone: '0996300008', paid: true, actorId }); assert.fail('no throw'); }
    catch (e) { assert.equal(e.status, 409); assert.equal(e.message, 'session_full'); }
  });

  // f) 重複 active 報名 → 409
  expect('重複報名 → 409 already_registered', () => {
    try { adminBackfillRegistration({ sessionId: sA, name: 'AGR-丙', phone: '0996300001', paid: true, actorId }); assert.fail('no throw'); }
    catch (e) { assert.equal(e.status, 409); assert.equal(e.message, 'already_registered'); }
  });

  // g) 已取消舊列 → 復原（同一列，不新插）
  db.prepare("UPDATE registrations SET status='cancelled' WHERE id=?").run(r1.registrationId);
  const r6 = adminBackfillRegistration({ sessionId: sA, name: 'AGR-丙', phone: '0996300001', paid: false, actorId });
  expect('cancelled 舊列復原為 pending（UNIQUE 不撞）', () => {
    assert.equal(r6.registrationId, r1.registrationId);
    assert.equal(db.prepare('SELECT status FROM registrations WHERE id=?').get(r1.registrationId).status, 'pending');
  });

  // g2) 滿額候補撞 cancelled 舊列 → 同列復原為 waitlisted（order_id/amount_due 清空）
  db.prepare("UPDATE registrations SET status='cancelled' WHERE id=?").run(r4.registrationId);
  const r4b = adminBackfillRegistration({ sessionId: sA, name: 'AGR-己', phone: '0996300004', paid: false, actorId });
  expect('滿額候補撞 cancelled 舊列 → 同列復原為 waitlisted', () => {
    assert.equal(r4b.registrationId, r4.registrationId);
    assert.equal(r4b.status, 'waitlisted');
    const reg = db.prepare('SELECT * FROM registrations WHERE id=?').get(r4.registrationId);
    assert.equal(reg.status, 'waitlisted'); assert.equal(reg.order_id, null); assert.equal(reg.amount_due, null);
  });

  // g3) paid 撞 cancelled 舊列 → 同列復原為 confirmed＋新已核對訂單（sB 此刻僅丁 pending 佔 1/2）
  const rp1 = adminBackfillRegistration({ sessionId: sB, name: 'AGR-卯', phone: '0996300010', paid: false, actorId });
  db.prepare("UPDATE registrations SET status='cancelled' WHERE id=?").run(rp1.registrationId);
  const rp2 = adminBackfillRegistration({ sessionId: sB, name: 'AGR-卯', phone: '0996300010', paid: true, actorId });
  expect('paid 撞 cancelled 舊列 → 同列復原為 confirmed＋新已核對訂單', () => {
    assert.equal(rp2.registrationId, rp1.registrationId);
    const reg = db.prepare('SELECT * FROM registrations WHERE id=?').get(rp1.registrationId);
    assert.equal(reg.status, 'confirmed'); assert.equal(reg.order_id, rp2.orderId); assert.equal(reg.amount_due, 500);
    assert.equal(db.prepare('SELECT status FROM group_orders WHERE id=?').get(rp2.orderId).status, 'paid');
  });

  // h) userId 路徑＋員工守門
  const memberId = db.prepare("SELECT id FROM users WHERE phone='0996300001'").get().id;
  const r7 = adminBackfillRegistration({ sessionId: sD, userId: memberId, paid: false, actorId });
  expect('userId 路徑可補報', () => assert.equal(r7.status, 'pending'));
  expect('userId 指到員工 → 404 user_not_found', () => {
    try { adminBackfillRegistration({ sessionId: sD, userId: actorId, paid: false, actorId }); assert.fail('no throw'); }
    catch (e) { assert.equal(e.status, 404); assert.equal(e.message, 'user_not_found'); }
  });

  // i) 無電話客人
  const r8 = adminBackfillRegistration({ sessionId: sD, name: 'AGR-無話', phone: null, paid: true, actorId });
  expect('無電話客人可補報（customer_phone 空字串）', () => {
    const o = db.prepare('SELECT customer_phone FROM group_orders WHERE id=?').get(r8.orderId);
    assert.equal(o.customer_phone, '');
  });

  // j) 未開課場次 → 409
  db.prepare("UPDATE course_sessions SET status='cancelled' WHERE id=?").run(sB);
  expect('cancelled 場次 → 409 session_cancelled', () => {
    try { adminBackfillRegistration({ sessionId: sB, name: 'AGR-子', phone: '0996300009', paid: false, actorId }); assert.fail('no throw'); }
    catch (e) { assert.equal(e.status, 409); assert.equal(e.message, 'session_cancelled'); }
  });
}

// ── §4 adminCancelRegistration ────────────────────────────────
reset();
{
  db.prepare("INSERT INTO discount_codes (code, discount_type, discount_value, active) VALUES ('AGRF100','fixed',100,1)").run();
  db.prepare("INSERT INTO discount_codes (code, discount_type, discount_value, active) VALUES ('AGRP10','percent',10,1)").run();
  const tpl = createTemplate({
    name: 'AGR-取消班', min_capacity: 1, max_capacity: 2,
    day_of_week: ((new Date()).getDay() + 2) % 7, start_time: '19:00',
    recurrence: 'weekly', cycle_start_date: dstr(1), cycle_end_date: dstr(40),
    registration_deadline_hours: 1, price_per_session: 500,
  });
  const ss = db.prepare('SELECT id FROM course_sessions WHERE template_id=? ORDER BY start_at ASC').all(tpl.templateId).map((r) => r.id);
  const [sA, sB, sC, sD] = ss;
  const actorId = Number(db.prepare("INSERT INTO users (name, email, role, is_admin) VALUES ('AGR-管理2', 'agr-admin2@x.com', 'coach', 1)").run().lastInsertRowid);
  const regOf = (phone, sid) => db.prepare('SELECT r.* FROM registrations r JOIN users u ON u.id=r.user_id WHERE u.phone=? AND r.session_id=?').get(phone, sid);

  // a) pending 多場訂單取消一場 → 金額重算；固定額折扣重新報價
  const o1 = createGroupOrder({ name: 'AGR-取甲', phone: '0996400001', paySessionIds: [sA, sB], waitlistSessionIds: [], discountCode: 'AGRF100' });
  expect('前置：900（1000-100）', () => assert.equal(db.prepare('SELECT total_amount FROM group_orders WHERE id=?').get(o1.orderId).total_amount, 900));
  adminCancelRegistration({ registrationId: regOf('0996400001', sA).id, actorId });
  expect('pending 取消一場 → 重算 500-100=400', () => {
    const o = db.prepare('SELECT * FROM group_orders WHERE id=?').get(o1.orderId);
    assert.equal(o.original_amount, 500); assert.equal(o.discount_amount, 100); assert.equal(o.total_amount, 400);
    assert.equal(regOf('0996400001', sA).status, 'cancelled');
    assert.equal(regOf('0996400001', sB).status, 'pending');
  });

  // b) 百分比折扣重新報價
  const o2 = createGroupOrder({ name: 'AGR-取乙', phone: '0996400002', paySessionIds: [sC, sD], waitlistSessionIds: [], discountCode: 'AGRP10' });
  adminCancelRegistration({ registrationId: regOf('0996400002', sC).id, actorId });
  expect('percent 取消一場 → 500-10%=450', () => {
    assert.equal(db.prepare('SELECT total_amount FROM group_orders WHERE id=?').get(o2.orderId).total_amount, 450);
  });

  // c) 折扣碼停用 → 折扣歸零（建單時碼有效，取消時已停用）
  const o3 = createGroupOrder({ name: 'AGR-取丙', phone: '0996400003', paySessionIds: [sA, sB], waitlistSessionIds: [], discountCode: 'AGRF100' });
  db.prepare("UPDATE discount_codes SET active=0 WHERE code='AGRF100'").run();
  adminCancelRegistration({ registrationId: regOf('0996400003', sA).id, actorId });
  expect('折扣碼失效 → 折扣歸零、應付=新原價', () => {
    const o = db.prepare('SELECT * FROM group_orders WHERE id=?').get(o3.orderId);
    assert.equal(o.original_amount, 500); assert.equal(o.discount_amount, null); assert.equal(o.total_amount, 500);
  });

  // d) 最後一場取消 → 整單取消＋釋放折扣
  adminCancelRegistration({ registrationId: regOf('0996400001', sB).id, actorId });
  expect('最後一場 → 整單取消、redemption 釋放', () => {
    const o = db.prepare('SELECT * FROM group_orders WHERE id=?').get(o1.orderId);
    assert.equal(o.status, 'cancelled'); assert.ok(o.cancelled_at);
    assert.equal(db.prepare("SELECT COUNT(*) AS c FROM discount_redemptions WHERE kind='group_order' AND ref_id=?").get(o1.orderId).c, 0);
  });

  // e) 已收款訂單取消一場 → 部分退款明細（預設 amount_due；可自訂；驗上限）
  const o4 = createGroupOrder({ name: 'AGR-取丁', phone: '0996400004', paySessionIds: [sC, sD], waitlistSessionIds: [] });
  confirmGroupOrder({ orderId: o4.orderId, actorId });
  adminCancelRegistration({ registrationId: regOf('0996400004', sC).id, actorId });
  expect('paid 取消 → 預設退 amount_due=500、訂單維持 paid、金額不動', () => {
    const rows = db.prepare('SELECT * FROM group_order_refunds WHERE order_id=?').all(o4.orderId);
    assert.equal(rows.length, 1); assert.equal(rows[0].amount, 500); assert.equal(rows[0].refunded_by, actorId);
    const o = db.prepare('SELECT * FROM group_orders WHERE id=?').get(o4.orderId);
    assert.equal(o.status, 'paid'); assert.equal(o.total_amount, 1000); assert.equal(o.refunded_at, null);
  });
  expect('自訂退款金額 300', () => {
    adminCancelRegistration({ registrationId: regOf('0996400004', sD).id, actorId, refundAmount: 300 });
    const rows = db.prepare('SELECT amount FROM group_order_refunds WHERE order_id=? ORDER BY id ASC').all(o4.orderId);
    assert.deepEqual(rows.map((r) => r.amount), [500, 300]);
  });
  expect('退款金額超過原價 → 400 invalid_refund_amount', () => {
    const o5 = createGroupOrder({ name: 'AGR-取戊', phone: '0996400005', paySessionIds: [sA], waitlistSessionIds: [] });
    confirmGroupOrder({ orderId: o5.orderId, actorId });
    try { adminCancelRegistration({ registrationId: regOf('0996400005', sA).id, actorId, refundAmount: 600 }); assert.fail('no throw'); }
    catch (e) { assert.equal(e.status, 400); assert.equal(e.message, 'invalid_refund_amount'); }
  });

  // f) 候補列取消：無金流
  const o6 = createGroupOrder({ name: 'AGR-取己', phone: '0996400006', paySessionIds: [], waitlistSessionIds: [sB] });
  adminCancelRegistration({ registrationId: regOf('0996400006', sB).id, actorId });
  expect('waitlisted 取消 → cancelled、無退款列', () => {
    assert.equal(regOf('0996400006', sB).status, 'cancelled');
    assert.equal(db.prepare('SELECT COUNT(*) AS c FROM group_order_refunds').get().c, 2); // e) 的 500＋300 兩筆；600 那次 400 已 rollback
  });

  // g) 舊資料（order_id NULL 的 confirmed）
  const legacyUid = Number(db.prepare("INSERT INTO users (name, phone, role) VALUES ('AGR-舊', '0996400007', 'user')").run().lastInsertRowid);
  const legacyRegId = Number(db.prepare("INSERT INTO registrations (session_id, user_id, status, order_id, amount_due) VALUES (?, ?, 'confirmed', NULL, NULL)").run(sB, legacyUid).lastInsertRowid);
  adminCancelRegistration({ registrationId: legacyRegId, actorId });
  expect('legacy confirmed → 直接 cancelled', () => {
    assert.equal(db.prepare('SELECT status FROM registrations WHERE id=?').get(legacyRegId).status, 'cancelled');
  });

  // h) 已取消再取消 → 409
  expect('重複取消 → 409 not_cancellable', () => {
    try { adminCancelRegistration({ registrationId: legacyRegId, actorId }); assert.fail('no throw'); }
    catch (e) { assert.equal(e.status, 409); assert.equal(e.message, 'not_cancellable'); }
  });

  // i) 取消釋名額 → 未來場次自動遞補
  // sA 此刻佔用者＝戊(confirmed, e)＋庚(pending, 下行)＝2＝cap → 滿
  const o7 = createGroupOrder({ name: 'AGR-取庚', phone: '0996400008', paySessionIds: [sA], waitlistSessionIds: [] });
  createGroupOrder({ name: 'AGR-取辛', phone: '0996400009', paySessionIds: [], waitlistSessionIds: [sA] });
  adminCancelRegistration({ registrationId: regOf('0996400008', sA).id, actorId });
  expect('取消未來場次 → 候補遞補為 pending＋24h 單', () => {
    const b = regOf('0996400009', sA);
    assert.equal(b.status, 'pending');
    assert.ok(b.order_id);
  });
}

// ── §5 listConfirmedPayments 部分退款 ─────────────────────────
reset();
{
  const tpl = createTemplate({
    name: 'AGR-對帳班', min_capacity: 1, max_capacity: 3,
    day_of_week: ((new Date()).getDay() + 2) % 7, start_time: '19:00',
    recurrence: 'weekly', cycle_start_date: dstr(1), cycle_end_date: dstr(20),
    registration_deadline_hours: 1, price_per_session: 500,
  });
  const ss = db.prepare('SELECT id FROM course_sessions WHERE template_id=? ORDER BY start_at ASC').all(tpl.templateId).map((r) => r.id);
  const actorId = Number(db.prepare("INSERT INTO users (name, email, role, is_admin) VALUES ('AGR-管理3', 'agr-admin3@x.com', 'coach', 1)").run().lastInsertRowid);
  const o = createGroupOrder({ name: 'AGR-帳甲', phone: '0996500001', paySessionIds: [ss[0], ss[1]], waitlistSessionIds: [] });
  confirmGroupOrder({ orderId: o.orderId, actorId });
  const reg = db.prepare('SELECT r.* FROM registrations r JOIN users u ON u.id=r.user_id WHERE u.phone=? AND r.session_id=?').get('0996500001', ss[0]);
  adminCancelRegistration({ registrationId: reg.id, actorId, refundAmount: 300 });
  expect('listConfirmedPayments 團課列帶 refund_sum/partial_refund', () => {
    const row = listConfirmedPayments().find((x) => x.type === 'group_order' && x.id === o.orderId);
    assert.equal(row.refund_sum, 300);
    assert.equal(row.partial_refund, true);
    assert.equal(row.amount, 1000);
    assert.equal(row.refunded_at, null);
  });
  refundGroupOrder({ orderId: o.orderId, actorId });
  expect('整單退款後 partial_refund=false（已退款 badge 優先）', () => {
    const row = listConfirmedPayments().find((x) => x.type === 'group_order' && x.id === o.orderId);
    assert.ok(row.refunded_at);
    assert.equal(row.partial_refund, false);
  });
}

console.log('[admin-group-reg test] done');
