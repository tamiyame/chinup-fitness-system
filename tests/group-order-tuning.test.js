// 團課訂單調整：付款期限可調(72h)、純候補不建訂單、混合單列候補場次、
// 逾期不殺候補、名單依報名時間新→舊、公開 API 候補人數。
import assert from 'node:assert/strict';
process.env.LINE_MOCK = '1';
const { db, nowLocal } = await import('../src/db/connection.js');
const { setSetting, getGroupOrderExpiryHours } = await import('../src/services/discountService.js');
const { createGroupOrder, listPendingOrders, expirePendingOrders, getPublicGroupCourses } = await import('../src/services/groupOrderService.js');
const { listRegistrationsBySession } = await import('../src/services/courseService.js');

function expect(label, fn){ try{fn();console.log(`  ✓ ${label}`);}catch(e){console.log(`  ✗ ${label}`);console.error(e);process.exitCode=1;} }
console.log('[group-order-tuning test] start');
db.exec("DELETE FROM notifications; DELETE FROM registrations; DELETE FROM group_orders; DELETE FROM course_sessions; DELETE FROM course_templates; DELETE FROM users WHERE phone LIKE '0991%'");
setSetting('group_order_expiry_hours', '72');

// fixtures：published 範本 + 三個未來場次（上限 2）
const pad = n => String(n).padStart(2,'0');
const day = (d) => { const x = new Date(Date.now() + d*86400000); return `${x.getFullYear()}-${pad(x.getMonth()+1)}-${pad(x.getDate())}`; };
const tplId = Number(db.prepare(`
  INSERT INTO course_templates (name, min_capacity, max_capacity, day_of_week, start_time, recurrence, cycle_start_date, cycle_end_date, status, price_per_session)
  VALUES ('調校測試班', 1, 2, 6, '15:00', 'weekly', ?, ?, 'published', 600)
`).run(day(1), day(60)).lastInsertRowid);
const mkSession = (d) => Number(db.prepare(`
  INSERT INTO course_sessions (template_id, session_date, start_at, end_at, registration_deadline)
  VALUES (?, ?, ?, ?, ?)
`).run(tplId, day(d), `${day(d)}T15:00:00`, `${day(d)}T16:00:00`, `${day(d)}T14:00:00`).lastInsertRowid);
const s1 = mkSession(7), s2 = mkSession(14), s3 = mkSession(21);

// 1. 期限可調
expect('accessor 預設 72', () => assert.equal(getGroupOrderExpiryHours(), 72));
const o1 = createGroupOrder({ name: 'tu1', phone: '0991000001', paySessionIds: [s1], waitlistSessionIds: [] });
expect('建單 expires_at ≈ now+72h', () => {
  const diffH = (new Date(o1.expiresAt) - new Date(nowLocal())) / 3600000;
  assert.ok(diffH > 71 && diffH < 73, `got ${diffH}h`);
});
setSetting('group_order_expiry_hours', '6');
const o2 = createGroupOrder({ name: 'tu2', phone: '0991000002', paySessionIds: [s2], waitlistSessionIds: [] });
expect('設 6 → expires_at ≈ now+6h', () => {
  const diffH = (new Date(o2.expiresAt) - new Date(nowLocal())) / 3600000;
  assert.ok(diffH > 5 && diffH < 7, `got ${diffH}h`);
});
setSetting('group_order_expiry_hours', '72');

// 2. 純候補：不建訂單
const before = db.prepare('SELECT COUNT(*) AS c FROM group_orders').get().c;
const wOnly = createGroupOrder({ name: 'tu3', phone: '0991000003', paySessionIds: [], waitlistSessionIds: [s1] });
expect('純候補 orderId=null、expiresAt=null、total=0', () => {
  assert.equal(wOnly.orderId, null);
  assert.equal(wOnly.expiresAt, null);
  assert.equal(wOnly.total, 0);
  assert.deepEqual(wOnly.waitlisted, [s1]);
});
expect('純候補不產生 group_orders 列', () => {
  assert.equal(db.prepare('SELECT COUNT(*) AS c FROM group_orders').get().c, before);
});
expect('候補列存在（order_id NULL）', () => {
  const r = db.prepare("SELECT * FROM registrations WHERE session_id=? AND status='waitlisted'").get(s1);
  assert.ok(r && r.order_id === null);
});

// 3. 混合單：候補列掛同一張訂單；listPendingOrders 列出候補場次、金額只計付款
const mixed = createGroupOrder({ name: 'tu4', phone: '0991000004', paySessionIds: [s3], waitlistSessionIds: [s2] });
expect('混合單：候補列 order_id = 訂單 id', () => {
  const r = db.prepare("SELECT * FROM registrations WHERE session_id=? AND status='waitlisted' AND user_id=(SELECT id FROM users WHERE phone='0991000004')").get(s2);
  assert.ok(r);
  assert.equal(r.order_id, mixed.orderId);
});
expect('混合單金額只計付款場次（600）', () => assert.equal(mixed.total, 600));
expect('listPendingOrders：含付款＋候補場次（帶 status）', () => {
  const card = listPendingOrders().find(o => o.id === mixed.orderId);
  assert.ok(card);
  assert.equal(card.total_amount, 600);
  const statuses = card.sessions.map(s => s.status).sort();
  assert.deepEqual(statuses, ['pending', 'waitlisted']);
});

// 4. 逾期：pending 取消、候補存活
db.prepare("UPDATE group_orders SET expires_at='2000-01-01T00:00:00' WHERE id=?").run(mixed.orderId);
expirePendingOrders();
expect('逾期後：付款列 cancelled、候補列仍 waitlisted', () => {
  const regs = db.prepare('SELECT session_id, status FROM registrations WHERE order_id=?').all(mixed.orderId);
  const byStatus = Object.fromEntries(regs.map(r => [r.status, r.session_id]));
  assert.equal(byStatus.cancelled, s3);
  assert.equal(byStatus.waitlisted, s2);
});

// 5. 名單依報名時間新→舊
db.prepare("UPDATE registrations SET registered_at='2026-01-01T10:00:00' WHERE session_id=? AND user_id=(SELECT id FROM users WHERE phone='0991000001')").run(s1);
db.prepare("UPDATE registrations SET registered_at='2026-01-02T10:00:00' WHERE session_id=? AND user_id=(SELECT id FROM users WHERE phone='0991000003')").run(s1);
expect('listRegistrationsBySession 純時間新→舊（不分狀態）', () => {
  const list = listRegistrationsBySession(s1);
  assert.equal(list[0].user_name, 'tu3'); // 較晚報名（候補）在前
  assert.equal(list[1].user_name, 'tu1');
});

// 6. 公開 API 候補人數
expect('getPublicGroupCourses 場次帶 waitlist_count', () => {
  const tpl = getPublicGroupCourses().find(t => t.id === tplId);
  assert.ok(tpl);
  const sess1 = tpl.sessions.find(s => s.id === s1);
  assert.equal(sess1.waitlist_count, 1);
  const sess2 = tpl.sessions.find(s => s.id === s2);
  assert.equal(sess2.waitlist_count, 1);
});

// 7. 連續遞補併單：上限 1、兩場；A 付款核對占滿、B 候補兩場 → 取消 A 訂單 → B 兩場遞補進「同一張」新單
const { confirmGroupOrder, refundGroupOrder } = await import('../src/services/groupOrderService.js');
const tpl2 = Number(db.prepare(`
  INSERT INTO course_templates (name, min_capacity, max_capacity, day_of_week, start_time, recurrence, cycle_start_date, cycle_end_date, status, price_per_session)
  VALUES ('併單測試班', 1, 1, 6, '15:00', 'weekly', ?, ?, 'published', 600)
`).run(day(1), day(60)).lastInsertRowid);
const mk2 = (d) => Number(db.prepare(`
  INSERT INTO course_sessions (template_id, session_date, start_at, end_at, registration_deadline)
  VALUES (?, ?, ?, ?, ?)
`).run(tpl2, day(d), `${day(d)}T15:00:00`, `${day(d)}T16:00:00`, `${day(d)}T14:00:00`).lastInsertRowid);
const m1 = mk2(30), m2 = mk2(37);
const admin = Number(db.prepare("INSERT INTO users (name,email,role,is_admin) VALUES ('併單管理','tu-a@x.com','coach',1)").run().lastInsertRowid);
// 場次掛教練（notifyCourseCoach 對無教練場次靜默跳過，要驗逐場通知須先掛上）
const tcu = Number(db.prepare("INSERT INTO users (name,email,role) VALUES ('併單教練','tu-c@x.com','coach')").run().lastInsertRowid);
const tco = Number(db.prepare("INSERT INTO coaches (user_id, display_name) VALUES (?, '併單教練')").run(tcu).lastInsertRowid);
db.prepare('UPDATE course_sessions SET coach_id=? WHERE id IN (?,?)').run(tco, m1, m2);
const oA = createGroupOrder({ name: 'tuA', phone: '0991000008', paySessionIds: [m1, m2], waitlistSessionIds: [] });
confirmGroupOrder({ orderId: oA.orderId, actorId: admin });
createGroupOrder({ name: 'tuB', phone: '0991000009', paySessionIds: [], waitlistSessionIds: [m1, m2] });
db.exec("DELETE FROM notifications");
refundGroupOrder({ orderId: oA.orderId, actorId: admin });
expect('連續遞補 → 同一張訂單（兩列同 order_id、總額 1200、期限≈+24h）', () => {
  const regs = db.prepare("SELECT order_id FROM registrations WHERE user_id=(SELECT id FROM users WHERE phone='0991000009') AND status='pending'").all();
  assert.equal(regs.length, 2);
  assert.equal(regs[0].order_id, regs[1].order_id);
  const o = db.prepare('SELECT total_amount, original_amount, expires_at FROM group_orders WHERE id=?').get(regs[0].order_id);
  assert.equal(o.total_amount, 1200);
  assert.equal(o.original_amount, 1200);
  const diffH = (new Date(o.expires_at) - new Date(nowLocal())) / 3600000;
  assert.ok(diffH > 23 && diffH < 25, `expiry ${diffH}h`);
  assert.ok(listPendingOrders().filter(x => x.id === regs[0].order_id).length === 1);
});
expect('連續遞補只發一則 group_promoted 給會員', () => {
  const c = db.prepare("SELECT COUNT(*) AS c FROM notifications WHERE type='group_promoted'").get().c;
  assert.equal(c, 1);
});
expect('教練遞補通知維持逐場（2 則）', () => {
  const c = db.prepare("SELECT COUNT(*) AS c FROM notifications WHERE type='course_promoted_coach'").get().c;
  assert.equal(c, 2);
});
db.exec("DELETE FROM notifications; DELETE FROM registrations; DELETE FROM group_orders; DELETE FROM course_sessions WHERE template_id=" + tpl2 + "; DELETE FROM course_templates WHERE id=" + tpl2 + "; DELETE FROM coaches WHERE id=" + tco + "; DELETE FROM users WHERE email IN ('tu-a@x.com','tu-c@x.com')");

setSetting('group_order_expiry_hours', '72');
db.exec("DELETE FROM notifications; DELETE FROM registrations; DELETE FROM group_orders; DELETE FROM course_sessions WHERE template_id=" + tplId + "; DELETE FROM course_templates WHERE id=" + tplId + "; DELETE FROM users WHERE phone LIKE '0991%'");
console.log('[group-order-tuning test] done');
