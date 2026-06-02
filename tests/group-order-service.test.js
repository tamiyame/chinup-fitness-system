import assert from 'node:assert/strict';
import { db } from '../src/db/connection.js';
import { createTemplate, setSessionOpen } from '../src/services/courseService.js';
import { createGroupOrder, sessionOccupied } from '../src/services/groupOrderService.js';
import { getBankInfo } from '../src/services/discountService.js';
import { ApiError } from '../src/services/registration.js';

function reset() {
  db.exec(`
    DELETE FROM notifications WHERE user_id IN (SELECT id FROM users WHERE phone LIKE '0997%');
    DELETE FROM registrations;
    DELETE FROM group_orders;
    DELETE FROM course_sessions;
    DELETE FROM course_templates;
    DELETE FROM users WHERE phone LIKE '0997%';
  `);
}
function expect(label, fn) {
  try { fn(); console.log(`  ✓ ${label}`); }
  catch (e) { console.log(`  ✗ ${label}`); console.error(e); process.exitCode = 1; }
}
function dstr(days) { const d=new Date(); d.setDate(d.getDate()+days); const p=(n)=>String(n).padStart(2,'0'); return `${d.getFullYear()}-${p(d.getMonth()+1)}-${p(d.getDate())}`; }

console.log('[group-order-service test] start');
reset();

// 建一個 cap=2、price=500 的 template（產生數個 future sessions）
const tpl = createTemplate({
  name: 'TRX班', min_capacity: 1, max_capacity: 2,
  day_of_week: ((new Date()).getDay()+2)%7, start_time: '19:00',
  recurrence: 'weekly', cycle_start_date: dstr(1), cycle_end_date: dstr(60),
  registration_deadline_hours: 1, price_per_session: 500,
});
const sessions = db.prepare("SELECT id FROM course_sessions WHERE template_id=? ORDER BY start_at ASC").all(tpl.templateId);
const s1 = sessions[0].id, s2 = sessions[1].id;

// 建單：選 2 場（都有空）
const o1 = createGroupOrder({ name: '甲', phone: '0997000001', paySessionIds: [s1, s2], waitlistSessionIds: [] });
expect('order created', () => assert(o1.orderId));
expect('order returns lineBindCode for unbound user', () => assert(/^\d{6}$/.test(o1.lineBindCode)));
expect('total = 2*500', () => assert.equal(o1.total, 1000));
expect('bankInfo present', () => assert(o1.bankInfo && o1.bankInfo === getBankInfo()));
expect('expiresAt present', () => assert(typeof o1.expiresAt === 'string'));
expect('2 pending registrations', () => {
  const c = db.prepare("SELECT COUNT(*) AS c FROM registrations WHERE order_id=? AND status='pending'").get(o1.orderId).c;
  assert.equal(c, 2);
});
expect('s1 occupied = 1', () => assert.equal(sessionOccupied(s1), 1));

// 第二位填滿 s1（cap=2 → 還有 1 位）
const o2 = createGroupOrder({ name: '乙', phone: '0997000002', paySessionIds: [s1], waitlistSessionIds: [] });
expect('s1 occupied = 2 (full)', () => assert.equal(sessionOccupied(s1), 2));

// 第三位選 s1（已滿）走 pay → 整批 409 fullSessionIds
expect('pay full session → 409 with fullSessionIds', () => {
  try { createGroupOrder({ name: '丙', phone: '0997000003', paySessionIds: [s1], waitlistSessionIds: [] }); assert.fail('no throw'); }
  catch (e) { assert.equal(e.status, 409); assert.deepEqual(e.detail.fullSessionIds, [s1]); }
});

// 第三位改 waitlist s1 → waitlisted reg、不佔名額、無金額
const o3 = createGroupOrder({ name: '丙', phone: '0997000003', paySessionIds: [], waitlistSessionIds: [s1] });
expect('waitlist order has no payment', () => assert.equal(o3.total, 0));
expect('waitlisted reg created', () => {
  const r = db.prepare("SELECT * FROM registrations WHERE session_id=? AND status='waitlisted'").get(s1);
  assert(r && r.order_id === null && r.amount_due === null);
});
expect('waitlist does NOT change occupied', () => assert.equal(sessionOccupied(s1), 2));

// 重複報名同場 → 409 already_registered
expect('duplicate → 409', () => {
  try { createGroupOrder({ name: '甲', phone: '0997000001', paySessionIds: [s2], waitlistSessionIds: [] }); assert.fail('no throw'); }
  catch (e) { assert.equal(e.status, 409); }
});

// all-or-nothing：pay 桶含「未滿 + 已滿」→ 整批 409，未滿場次與訂單/使用者都不被寫入（tx rollback）
expect('partial-full pay batch → 409 and writes nothing', () => {
  const before = sessionOccupied(s2);
  try {
    createGroupOrder({ name: '戊', phone: '0997000009', paySessionIds: [s2, s1], waitlistSessionIds: [] });
    assert.fail('no throw');
  } catch (e) {
    assert.equal(e.status, 409);
    assert.deepEqual(e.detail.fullSessionIds, [s1]);
  }
  assert.equal(sessionOccupied(s2), before, 's2 occupancy unchanged');
  assert.equal(db.prepare("SELECT COUNT(*) AS c FROM group_orders WHERE customer_phone='0997000009'").get().c, 0, 'no order written');
  assert.equal(db.prepare("SELECT COUNT(*) AS c FROM users WHERE phone='0997000009'").get().c, 0, 'no user written (tx rolled back)');
});

console.log('[group-order-service part1] done');

import { confirmGroupOrder, cancelGroupOrder, cancelRegistrationPublic, promoteWaitlist } from '../src/services/groupOrderService.js';

console.log('[group-order-service part2] start');

// 接續 part1 狀態：s1 cap=2，o1(甲:s1,s2 pending)、o2(乙:s1 pending)、o3(丙:s1 waitlisted)
// 核對 o2 付款 → confirmed
expect('confirm order → paid + regs confirmed', () => {
  const adminId = db.prepare("SELECT id FROM users WHERE role IN ('admin','owner') LIMIT 1").get()?.id
    || db.prepare("INSERT INTO users (name,email,password_hash,role) VALUES ('A','goa@x.com','x','owner') RETURNING id").get().id;
  const res = confirmGroupOrder({ orderId: o2.orderId, actorId: adminId });
  assert.equal(res.ok, true);
  const o = db.prepare('SELECT status FROM group_orders WHERE id=?').get(o2.orderId);
  assert.equal(o.status, 'paid');
  const r = db.prepare("SELECT status FROM registrations WHERE order_id=?").get(o2.orderId);
  assert.equal(r.status, 'confirmed');
});

// 乙取消（confirmed）→ 釋名額 → 丙(候補) 遞補成 pending + 新 24h order
expect('cancel confirmed reg → promote waitlist', () => {
  const reg = db.prepare("SELECT id FROM registrations WHERE order_id=?").get(o2.orderId);
  const res = cancelRegistrationPublic({ registrationId: reg.id, phone: '0997000002', name: '乙' });
  assert.equal(res.ok, true);
  // 丙 應被遞補
  const bing = db.prepare("SELECT * FROM registrations WHERE session_id=? AND user_id=(SELECT id FROM users WHERE phone='0997000003')").get(s1);
  assert.equal(bing.status, 'pending');
  assert(bing.order_id);  // 新訂單
  const ord = db.prepare('SELECT * FROM group_orders WHERE id=?').get(bing.order_id);
  assert.equal(ord.status, 'pending');
});

// 放棄整筆未付 order（甲的 o1）→ regs cancelled、釋名額
expect('cancel pending order whole → ok', () => {
  const res = cancelGroupOrder({ orderId: o1.orderId, phone: '0997000001', name: '甲' });
  assert.equal(res.ok, true);
  const o = db.prepare('SELECT status FROM group_orders WHERE id=?').get(o1.orderId);
  assert.equal(o.status, 'cancelled');
  const cnt = db.prepare("SELECT COUNT(*) AS c FROM registrations WHERE order_id=? AND status='cancelled'").get(o1.orderId).c;
  assert.equal(cnt, 2);
});

// 取消他人 order（用真實但非本人的帳號：甲 試圖取消屬於丙的 o3）→ 403
expect('cancel order wrong owner → 403', () => {
  try { cancelGroupOrder({ orderId: o3.orderId, phone: '0997000001', name: '甲' }); assert.fail('no throw'); }
  catch (e) { assert.equal(e.status, 403); }
});

// cancelRegistrationPublic 對 pending reg（丙遞補後的待付）→ 409 use_cancel_order（須走整筆放棄）
expect('cancel pending reg → 409 use_cancel_order', () => {
  const bingId = db.prepare("SELECT id FROM users WHERE phone='0997000003'").get().id;
  const reg = db.prepare("SELECT id FROM registrations WHERE user_id=? AND status='pending'").get(bingId);
  assert(reg, 'expected promoted 丙 to have a pending reg');
  try { cancelRegistrationPublic({ registrationId: reg.id, phone: '0997000003', name: '丙' }); assert.fail('no throw'); }
  catch (e) { assert.equal(e.status, 409); assert.equal(e.code, 'use_cancel_order'); }
});

console.log('[group-order-service part2] done');

import { expirePendingOrders, getPublicGroupCourses, getPublicSchedule } from '../src/services/groupOrderService.js';

console.log('[group-order-service part3] start');

// 造一筆「已過期」pending order：直接改 expires_at 到過去
expect('expire sweep cancels stale pending + promotes', () => {
  // 用丁建一個 pending（選 s2，s2 cap=2 目前 0 佔；先讓某人候補 s2）
  const oDi = createGroupOrder({ name: '丁', phone: '0997000004', paySessionIds: [s2], waitlistSessionIds: [] });
  // 戊候補 s2 之前要先把 s2 佔滿；s2 cap=2，丁佔 1，再加一個正取佔滿
  createGroupOrder({ name: '己', phone: '0997000005', paySessionIds: [s2], waitlistSessionIds: [] }); // s2 now full(2)
  const oGeng = createGroupOrder({ name: '庚', phone: '0997000006', paySessionIds: [], waitlistSessionIds: [s2] }); // waitlist
  // 把丁的 order 過期
  db.prepare("UPDATE group_orders SET expires_at='2000-01-01T00:00:00' WHERE id=?").run(oDi.orderId);
  const res = expirePendingOrders();
  assert(res.expired >= 1);
  const o = db.prepare('SELECT status FROM group_orders WHERE id=?').get(oDi.orderId);
  assert.equal(o.status, 'cancelled');
  // 庚 應遞補上 s2
  const geng = db.prepare("SELECT status FROM registrations WHERE session_id=? AND user_id=(SELECT id FROM users WHERE phone='0997000006')").get(s2);
  assert.equal(geng.status, 'pending');
});

// 公開課程列表
expect('getPublicGroupCourses returns templates with sessions+price+occupied', () => {
  const courses = getPublicGroupCourses();
  const c = courses.find(x => x.id === tpl.templateId);
  assert(c && c.price_per_session === 500 && Array.isArray(c.sessions));
  const sess = c.sessions.find(x => x.id === s1);
  assert(typeof sess.occupied === 'number' && sess.max_capacity === 2 && typeof sess.is_full === 'boolean');
});

// 公開查課表（電話+姓名）+ 剩堂數
expect('getPublicSchedule by phone+name', () => {
  const sched = getPublicSchedule({ phone: '0997000006', name: '庚' });
  assert(sched && Array.isArray(sched.items));
  assert(typeof sched.group_remaining === 'number');
  assert(typeof sched.one_on_one_remaining === 'number');
});
expect('getPublicSchedule wrong name → 403', () => {
  try { getPublicSchedule({ phone: '0997000006', name: '錯' }); assert.fail('no throw'); }
  catch (e) { assert.equal(e.status, 403); }
});

console.log('[group-order-service part3] done');

// ── part4：單一場次手動開放/關閉 (is_open) ──
console.log('[group-order-service part4] session is_open toggle');
reset();
const tplX = createTemplate({
  name: 'OPEN班', min_capacity: 1, max_capacity: 5,
  day_of_week: ((new Date()).getDay()+2)%7, start_time: '20:00',
  recurrence: 'weekly', cycle_start_date: dstr(1), cycle_end_date: dstr(60),
  registration_deadline_hours: 1, price_per_session: 500,
});
const xs = db.prepare("SELECT id FROM course_sessions WHERE template_id=? ORDER BY start_at ASC").all(tplX.templateId);
const pubCount = () => getPublicGroupCourses().find(t => t.id === tplX.templateId)?.sessions.length || 0;
const before = pubCount();
expect('public lists open sessions initially (>=2)', () => assert(before >= 2));

const toggled = setSessionOpen(xs[0].id, false);
expect('setSessionOpen(false) → is_open=0', () => assert.equal(toggled.is_open, 0));
expect('public excludes closed session (count -1)', () => assert.equal(pubCount(), before - 1));
expect('closed session id absent from public list', () => {
  const t = getPublicGroupCourses().find(t => t.id === tplX.templateId);
  assert(!t.sessions.some(s => s.id === xs[0].id));
});
expect('booking a closed session → 409 session_closed', () => {
  try { createGroupOrder({ name: '關客', phone: '0997000099', paySessionIds: [xs[0].id], waitlistSessionIds: [] }); assert.fail('no throw'); }
  catch (e) { assert.equal(e.status, 409); assert.equal(e.code, 'session_closed'); }
});

const reopened = setSessionOpen(xs[0].id, true);
expect('setSessionOpen(true) → is_open=1', () => assert.equal(reopened.is_open, 1));
expect('public re-includes reopened session', () => assert.equal(pubCount(), before));

expect('setSessionOpen on non-open session → 409 session_not_toggleable', () => {
  db.prepare("UPDATE course_sessions SET status='cancelled' WHERE id=?").run(xs[1].id);
  try { setSessionOpen(xs[1].id, false); assert.fail('no throw'); }
  catch (e) { assert.equal(e.status, 409); assert.equal(e.code, 'session_not_toggleable'); }
});
expect('setSessionOpen on missing session → 404', () => {
  try { setSessionOpen(99999999, false); assert.fail('no throw'); }
  catch (e) { assert.equal(e.status, 404); }
});
console.log('[group-order-service part4] done');

// part5 安全：員工帳號的電話不可被匿名報名重用（與 1對1 同一越權綁定修補）
console.log('[group-order-service part5] staff-phone guard');
db.prepare("INSERT INTO users (name, phone, role) VALUES ('Staff X', '0997099999', 'coach')").run();
expect('group order with a staff phone → 409 phone_unavailable', () => {
  try {
    createGroupOrder({ name: '冒用者', phone: '0997099999', paySessionIds: [s2], waitlistSessionIds: [] });
    assert.fail('no throw');
  } catch (e) { assert.equal(e.status, 409); assert.equal(e.code, 'phone_unavailable'); }
});
expect('no order/registration written for staff phone (tx rolled back)', () => {
  assert.equal(db.prepare("SELECT COUNT(*) AS c FROM group_orders WHERE customer_phone='0997099999'").get().c, 0);
  const sid = db.prepare("SELECT id FROM users WHERE phone='0997099999'").get().id;
  assert.equal(db.prepare("SELECT COUNT(*) AS c FROM registrations WHERE user_id=?").get(sid).c, 0);
});
expect('staff account got no bind code', () => {
  const u = db.prepare("SELECT line_bind_code FROM users WHERE phone='0997099999'").get();
  assert.equal(u.line_bind_code, null);
});
console.log('[group-order-service part5] done');
