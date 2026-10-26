// 期課「續報下期」：期末最後一堂的舊生一鍵報進同範本下一期（待付款單，期限＝下期第一堂截止）。
import assert from 'node:assert/strict';
import { db, nowLocal, offsetLocal } from '../src/db/connection.js';
import { createTemplate } from '../src/services/courseService.js';
import {
  createGroupOrder, confirmGroupOrder, expirePendingOrders, listPendingOrders,
  getRenewalInfo, adminRenewNextPeriod,
} from '../src/services/groupOrderService.js';
import { periodOf, nextPeriod, periodLabel } from '../src/services/period.js';

function expect(label, fn) {
  try { fn(); console.log(`  ✓ ${label}`); }
  catch (e) { console.log(`  ✗ ${label}`); console.error(e); process.exitCode = 1; }
}
function expectApiError(fn, status, code) {
  assert.throws(fn, (e) => e.status === status && e.code === code);
}
function reset() {
  db.exec(`
    DELETE FROM group_order_refunds;
    DELETE FROM discount_redemptions;
    DELETE FROM registrations;
    DELETE FROM group_orders;
    DELETE FROM course_sessions;
    DELETE FROM course_templates;
    DELETE FROM notifications WHERE user_id IN (SELECT id FROM users WHERE phone LIKE '0984%');
    DELETE FROM users WHERE phone LIKE '0984%';
  `);
}

console.log('[group-renew test] start');

// 期別固定取「下一期」當本期、「下下期」當下期 → 全部場次都在未來，結果與今天日期無關。
const P1 = nextPeriod(periodOf(nowLocal().slice(0, 10)));
const P2 = nextPeriod(P1);
const between = (p) => (s) => s.session_date >= p.start && s.session_date <= p.end;

function setup({ max = 6 } = {}) {
  reset();
  const { templateId } = createTemplate({
    name: 'RNW-續報班', min_capacity: 1, max_capacity: max,
    day_of_week: 2, start_time: '19:00', recurrence: 'weekly',
    cycle_start_date: P1.start, cycle_end_date: P2.end,
    registration_deadline_hours: 2, price_per_session: 500,
  });
  const all = db.prepare('SELECT * FROM course_sessions WHERE template_id=? ORDER BY start_at').all(templateId);
  const p1 = all.filter(between(P1));
  const p2 = all.filter(between(P2));
  return { templateId, p1, p2, last: p1[p1.length - 1] };
}
// 報名本期最後一堂並核對（confirmed），回 userId
function enrolLast(last, name, phone, { confirm = true } = {}) {
  const o = createGroupOrder({ name, phone, paySessionIds: [last.id] });
  if (confirm) confirmGroupOrder({ orderId: o.orderId, actorId: o.memberId });
  return o.memberId;
}
const regsOf = (userId, sessionIds) => db.prepare(
  `SELECT * FROM registrations WHERE user_id=? AND session_id IN (${sessionIds.join(',')}) ORDER BY session_id`
).all(userId);

// ── §1 資格：只有期內最後一堂 ─────────────────────────────────
{
  const { p1, p2, last } = setup();
  expect('前置：本期與下期都有場次', () => { assert.ok(p1.length >= 4); assert.ok(p2.length >= 4); });
  expect('非最後一堂 → eligible false', () => {
    assert.deepEqual(getRenewalInfo(p1[0].id), { eligible: false });
  });
  expect('最後一堂 → eligible＋下期標籤、場數、單價', () => {
    const info = getRenewalInfo(last.id);
    assert.equal(info.eligible, true);
    assert.equal(info.periodLabel, periodLabel(P2));
    assert.equal(info.sessionCount, p2.length);
    assert.equal(info.fullCount, 0);
    assert.equal(info.pricePerSession, 500);
    assert.deepEqual(info.renewedUserIds, []);
  });
  expect('不存在的場次 → 404', () => expectApiError(() => getRenewalInfo(999999), 404, 'session_not_found'));

  // 最後一堂未開課（cancelled）→ 前一堂遞補為「最後一堂」
  db.prepare("UPDATE course_sessions SET status='cancelled' WHERE id=?").run(last.id);
  expect('最後一堂未開課 → 改由前一堂當最後一堂', () => {
    assert.equal(getRenewalInfo(last.id).eligible, false);
    assert.equal(getRenewalInfo(p1[p1.length - 2].id).eligible, true);
  });
}

// ── §2 一鍵續報：建待付款單、全部下期場次 pending ───────────────
{
  const { p2, last } = setup();
  const userA = enrolLast(last, 'RNW-甲', '0984000001');
  const before = nowLocal();
  const r = adminRenewNextPeriod({ sessionId: last.id, userId: userA });
  expect('回傳：訂單、金額、場數、期別', () => {
    assert.ok(r.orderId);
    assert.equal(r.payCount, p2.length);
    assert.equal(r.waitlistCount, 0);
    assert.equal(r.total, p2.length * 500);
    assert.equal(r.periodLabel, periodLabel(P2));
  });
  expect('下期每場一筆 pending、掛同一張單、amount_due＝範本價', () => {
    const regs = regsOf(userA, p2.map((s) => s.id));
    assert.equal(regs.length, p2.length);
    for (const reg of regs) {
      assert.equal(reg.status, 'pending');
      assert.equal(reg.order_id, r.orderId);
      assert.equal(reg.amount_due, 500);
    }
  });
  expect('訂單 pending、總額＝原價、無折扣、客人資料帶入', () => {
    const o = db.prepare('SELECT * FROM group_orders WHERE id=?').get(r.orderId);
    assert.equal(o.status, 'pending');
    assert.equal(o.total_amount, p2.length * 500);
    assert.equal(o.original_amount, p2.length * 500);
    assert.equal(o.discount_amount, null);
    assert.equal(o.member_id, userA);
    assert.equal(o.customer_name, 'RNW-甲');
    assert.equal(o.customer_phone, '0984000001');
  });
  expect('付款期限＝下期第一堂報名截止（遠於一般期限時）', () => {
    assert.equal(r.expiresAt, p2[0].registration_deadline);
    assert.ok(r.expiresAt > before);
  });
  expect('出現在待核對匯款清單', () => {
    const card = listPendingOrders().find((o) => o.id === r.orderId);
    assert.ok(card);
    assert.equal(card.sessions.length, p2.length);
  });
  expect('info：該客人列入 renewedUserIds', () => {
    assert.deepEqual(getRenewalInfo(last.id).renewedUserIds, [userA]);
  });
  expect('重複續報 → 409 already_renewed', () => expectApiError(
    () => adminRenewNextPeriod({ sessionId: last.id, userId: userA }), 409, 'already_renewed'));

  // 核對收款 → 下期全部正取
  confirmGroupOrder({ orderId: r.orderId, actorId: userA });
  expect('核對後下期全部 confirmed', () => {
    assert.ok(regsOf(userA, p2.map((s) => s.id)).every((x) => x.status === 'confirmed'));
  });
}

// ── §3 資格守門 ───────────────────────────────────────────────
{
  const { p1, p2, last } = setup();
  const userA = enrolLast(last, 'RNW-甲', '0984000001');
  const userPending = enrolLast(last, 'RNW-未付', '0984000002', { confirm: false });
  // 只報第一堂的客人（不在最後一堂名單）
  const other = createGroupOrder({ name: 'RNW-乙', phone: '0984000003', paySessionIds: [p1[0].id] }).memberId;

  expect('最後一堂待付款（pending）的客人也可續報', () => {
    const r = adminRenewNextPeriod({ sessionId: last.id, userId: userPending });
    assert.equal(r.payCount, p2.length);
  });
  expect('不在最後一堂名單 → 409 not_registered', () => expectApiError(
    () => adminRenewNextPeriod({ sessionId: last.id, userId: other }), 409, 'not_registered'));
  expect('非最後一堂 → 409 not_period_last', () => expectApiError(
    () => adminRenewNextPeriod({ sessionId: p1[0].id, userId: other }), 409, 'not_period_last'));
  expect('不存在的客人 → 404 user_not_found', () => expectApiError(
    () => adminRenewNextPeriod({ sessionId: last.id, userId: 999999 }), 404, 'user_not_found'));

  // 最後一堂已取消報名的客人
  db.prepare("UPDATE registrations SET status='cancelled' WHERE user_id=? AND session_id=?").run(userA, last.id);
  expect('最後一堂報名已取消 → 409 not_registered', () => expectApiError(
    () => adminRenewNextPeriod({ sessionId: last.id, userId: userA }), 409, 'not_registered'));

  // 下期全部暫停 → 無可續報場次
  db.prepare(`UPDATE course_sessions SET is_open=0 WHERE id IN (${p2.map((s) => s.id).join(',')})`).run();
  db.prepare("UPDATE registrations SET status='confirmed' WHERE user_id=? AND session_id=?").run(userA, last.id);
  expect('下期全部暫停 → info 不可續報、POST 409 no_next_sessions', () => {
    assert.equal(getRenewalInfo(last.id).eligible, false);
    expectApiError(() => adminRenewNextPeriod({ sessionId: last.id, userId: userA }), 409, 'no_next_sessions');
  });
}

// ── §4 下期場次篩選：暫停、未開課不報；別的範本不算 ───────────────
{
  const { p2, last } = setup();
  const userA = enrolLast(last, 'RNW-甲', '0984000001');
  db.prepare('UPDATE course_sessions SET is_open=0 WHERE id=?').run(p2[1].id);
  db.prepare("UPDATE course_sessions SET status='cancelled' WHERE id=?").run(p2[2].id);
  // 另一門課同期的場次：已有報名不影響「已續報」判定
  const { templateId: otherTpl } = createTemplate({
    name: 'RNW-別班', min_capacity: 1, max_capacity: 6, day_of_week: 4, start_time: '19:00', recurrence: 'weekly',
    cycle_start_date: P2.start, cycle_end_date: P2.end, registration_deadline_hours: 2, price_per_session: 300,
  });
  const otherSid = db.prepare('SELECT id FROM course_sessions WHERE template_id=? ORDER BY start_at').get(otherTpl).id;
  createGroupOrder({ name: 'RNW-甲', phone: '0984000001', paySessionIds: [otherSid] });

  expect('info：暫停／未開課場次不算入場數；別班報名不算已續報', () => {
    const info = getRenewalInfo(last.id);
    assert.equal(info.sessionCount, p2.length - 2);
    assert.deepEqual(info.renewedUserIds, []);
  });
  const r = adminRenewNextPeriod({ sessionId: last.id, userId: userA });
  expect('續報略過暫停與未開課場次', () => {
    assert.equal(r.payCount, p2.length - 2);
    const sids = regsOf(userA, p2.map((s) => s.id)).map((x) => x.session_id);
    assert.ok(!sids.includes(p2[1].id));
    assert.ok(!sids.includes(p2[2].id));
  });
}

// ── §5 額滿場次改候補（不收費、掛同一張單）；全滿不建單 ───────────
{
  const { p2, last } = setup({ max: 1 });
  const userA = enrolLast(last, 'RNW-甲', '0984000001');
  // 下期第一堂被網路客人報滿（max=1）
  createGroupOrder({ name: 'RNW-網客', phone: '0984000009', paySessionIds: [p2[0].id] });
  expect('info：fullCount 計入額滿場次', () => assert.equal(getRenewalInfo(last.id).fullCount, 1));
  const r = adminRenewNextPeriod({ sessionId: last.id, userId: userA });
  expect('額滿場次 → 候補、不計金額、掛同一張單', () => {
    assert.equal(r.waitlistCount, 1);
    assert.equal(r.payCount, p2.length - 1);
    assert.equal(r.total, (p2.length - 1) * 500);
    const w = db.prepare('SELECT * FROM registrations WHERE user_id=? AND session_id=?').get(userA, p2[0].id);
    assert.equal(w.status, 'waitlisted');
    assert.equal(w.order_id, r.orderId);
    assert.equal(w.amount_due, null);
  });
  expect('期限取第一個「付款」場次的截止', () => assert.equal(r.expiresAt, p2[1].registration_deadline));
}
{
  const { p2, last } = setup({ max: 1 });
  const userA = enrolLast(last, 'RNW-甲', '0984000001');
  createGroupOrder({ name: 'RNW-網客', phone: '0984000009', paySessionIds: p2.map((s) => s.id) });
  const r = adminRenewNextPeriod({ sessionId: last.id, userId: userA });
  expect('下期全滿 → 不建單、全部候補', () => {
    assert.equal(r.orderId, null);
    assert.equal(r.total, 0);
    assert.equal(r.waitlistCount, p2.length);
    const regs = regsOf(userA, p2.map((s) => s.id));
    assert.ok(regs.every((x) => x.status === 'waitlisted' && x.order_id === null));
    assert.ok(getRenewalInfo(last.id).renewedUserIds.includes(userA));
  });
}

// ── §6 期限：第一堂截止太近 → 至少一般期限；逾期取消後可再續報（復原舊列）──
{
  const { p2, last } = setup();
  const userA = enrolLast(last, 'RNW-甲', '0984000001');
  db.prepare('UPDATE course_sessions SET registration_deadline=? WHERE id=?').run(offsetLocal(3600_000), p2[0].id);
  const r = adminRenewNextPeriod({ sessionId: last.id, userId: userA });
  expect('第一堂截止 <72h → 期限至少一般期限（預設 72h）', () => {
    assert.ok(r.expiresAt >= offsetLocal(71 * 3600_000));
  });

  db.prepare('UPDATE group_orders SET expires_at=? WHERE id=?').run(offsetLocal(-60_000), r.orderId);
  expirePendingOrders();
  expect('逾期 → 下期報名取消、不再算已續報', () => {
    assert.ok(regsOf(userA, p2.map((s) => s.id)).every((x) => x.status === 'cancelled'));
    assert.deepEqual(getRenewalInfo(last.id).renewedUserIds, []);
  });
  expect('逾期後可再續報（舊列復原，不撞 UNIQUE）', () => {
    const r2 = adminRenewNextPeriod({ sessionId: last.id, userId: userA });
    assert.notEqual(r2.orderId, r.orderId);
    const regs = regsOf(userA, p2.map((s) => s.id));
    assert.equal(regs.length, p2.length);
    assert.ok(regs.every((x) => x.status === 'pending' && x.order_id === r2.orderId));
  });
}

reset();
console.log('[group-renew test] done');
