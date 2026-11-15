// 業主 2026-11-15：待核對匯款過了付款期限不自動取消——
// 訂單留在「待核對匯款」、名額照佔，等管理者手動按「已收款」或「取消訂單」。
// （教練課預約本來就沒有逾期機制，這裡只測團課訂單。）
import assert from 'node:assert/strict';
process.env.LINE_MOCK = '1';
const { db, offsetLocal } = await import('../src/db/connection.js');
const { createTemplate, getTemplate } = await import('../src/services/courseService.js');
const {
  createGroupOrder, listPendingOrders, sessionIsFull, getPublicGroupCourses, getPublicSchedule,
  confirmGroupOrder, cancelGroupOrder,
} = await import('../src/services/groupOrderService.js');

async function expect(label, fn) {
  try { await fn(); console.log(`  ✓ ${label}`); }
  catch (e) { console.log(`  ✗ ${label}`); console.error(e); process.exitCode = 1; }
}
const pad = (n) => String(n).padStart(2, '0');
function dstr(days) { const d = new Date(); d.setDate(d.getDate() + days); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; }
function reset() {
  db.exec(`
    DELETE FROM notifications;
    DELETE FROM registrations;
    DELETE FROM group_orders;
    DELETE FROM course_sessions;
    DELETE FROM course_templates;
    DELETE FROM users WHERE phone LIKE '0979%' OR email = 'pne-admin@x.com';
  `);
}
const uidOf = (phone) => db.prepare('SELECT id FROM users WHERE phone = ?').get(phone).id;
const regOf = (phone, sid) => db.prepare('SELECT * FROM registrations WHERE user_id = ? AND session_id = ?').get(uidOf(phone), sid);
const orderOf = (id) => db.prepare('SELECT * FROM group_orders WHERE id = ?').get(id);
const makeOverdue = (orderId) => db.prepare('UPDATE group_orders SET expires_at = ? WHERE id = ?').run(offsetLocal(-3600_000), orderId);

console.log('[pending-no-auto-expire test] start');
reset();

// 上限 1 人的班，三個未來場次
const tpl = createTemplate({
  name: 'PNE-不逾期班', min_capacity: 1, max_capacity: 1,
  day_of_week: ((new Date()).getDay() + 2) % 7, start_time: '19:00',
  recurrence: 'weekly', cycle_start_date: dstr(1), cycle_end_date: dstr(40),
  registration_deadline_hours: 1, price_per_session: 500,
});
const [s1, s2, s3] = db.prepare('SELECT id FROM course_sessions WHERE template_id = ? ORDER BY start_at ASC').all(tpl.templateId).map((r) => r.id);
const adminId = Number(db.prepare("INSERT INTO users (name, email, role, is_admin) VALUES ('PNE-管理', 'pne-admin@x.com', 'coach', 1)").run().lastInsertRowid);

// 甲付款報 s1、乙付款報 s2；甲的單過期、乙的單沒過期
const oA = createGroupOrder({ name: 'PNE-甲', phone: '0979000001', paySessionIds: [s1], waitlistSessionIds: [] });
const oB = createGroupOrder({ name: 'PNE-乙', phone: '0979000002', paySessionIds: [s2], waitlistSessionIds: [] });
makeOverdue(oA.orderId);

// ── 1. 逾期單留在待核對清單，並標示逾期 ──
await expect('逾期的待付款單仍在待核對清單，overdue=true', () => {
  const card = listPendingOrders().find((o) => o.id === oA.orderId);
  assert.ok(card, '逾期單應該還在清單裡');
  assert.equal(card.overdue, true);
  assert.equal(card.total_amount, 500);
  assert.deepEqual(card.sessions.map((s) => s.status), ['pending']);
});
await expect('未逾期的待付款單 overdue=false', () => {
  const card = listPendingOrders().find((o) => o.id === oB.orderId);
  assert.ok(card);
  assert.equal(card.overdue, false);
});

// ── 2. 逾期單照佔名額（三個口徑一致）──
await expect('逾期單照佔名額：sessionIsFull', () => assert.equal(sessionIsFull(s1), true));
await expect('逾期單照佔名額：公開課程列表 occupied／is_full', () => {
  const sess = getPublicGroupCourses().find((t) => t.id === tpl.templateId).sessions.find((s) => s.id === s1);
  assert.equal(sess.occupied, 1);
  assert.equal(sess.is_full, true);
});
await expect('逾期單照佔名額：後台範本場次 occupied', () => {
  const sess = getTemplate(tpl.templateId).sessions.find((s) => s.id === s1);
  assert.equal(sess.occupied, 1);
});
await expect('逾期單佔著的場次，別人付款報名 → 409 sessions_full', () => {
  try {
    createGroupOrder({ name: 'PNE-丙', phone: '0979000003', paySessionIds: [s1], waitlistSessionIds: [] });
    assert.fail('no throw');
  } catch (e) {
    assert.equal(e.status, 409);
    assert.equal(e.code, 'sessions_full');
  }
});

// 丙改排 s1 候補
createGroupOrder({ name: 'PNE-丙', phone: '0979000003', paySessionIds: [], waitlistSessionIds: [s1] });

// ── 3. 排程不再自動取消逾期單 ──
// 把 cron.schedule 換成收集器，實際跑一遍排程註冊的每個工作（備份會寫檔，略過）。
{
  const cron = (await import('node-cron')).default;
  const realSchedule = cron.schedule;
  const jobs = [];
  cron.schedule = (expr, fn) => { jobs.push(fn); return { stop() {} }; };
  try {
    const { startScheduler } = await import('../src/scheduler.js');
    startScheduler();
  } finally {
    cron.schedule = realSchedule;
  }
  for (const fn of jobs) {
    if (/runBackup/.test(String(fn))) continue;
    await fn();
  }
  await expect('排程有註冊工作（收集器有接到）', () => assert.ok(jobs.length >= 5, `got ${jobs.length}`));
  await expect('跑完所有排程工作：逾期單仍是待付款、報名列仍 pending', () => {
    assert.equal(orderOf(oA.orderId).status, 'pending');
    assert.equal(regOf('0979000001', s1).status, 'pending');
  });
  await expect('跑完所有排程工作：候補沒有被遞補', () => {
    assert.equal(regOf('0979000003', s1).status, 'waitlisted');
  });
}

// ── 4. 客人端：逾期單仍顯示待付款與原期限 ──
await expect('我的課表：逾期單的報名仍是 pending，帶原付款期限', () => {
  const item = getPublicSchedule({ phone: '0979000001', name: 'PNE-甲' }).items.find((x) => x.kind === 'registration' && x.session_id === s1);
  assert.ok(item);
  assert.equal(item.status, 'pending');
  assert.equal(item.order_status, 'pending');
  assert.equal(item.order_expires_at, orderOf(oA.orderId).expires_at);
});

// ── 5. 逾期單不被併單：同一位客人在別場遞補時開新單並通知 ──
{
  // 丁付款佔住 s3，甲排 s3 候補；丁放棄 → 甲遞補
  const oD = createGroupOrder({ name: 'PNE-丁', phone: '0979000004', paySessionIds: [s3], waitlistSessionIds: [] });
  createGroupOrder({ name: 'PNE-甲', phone: '0979000001', paySessionIds: [], waitlistSessionIds: [s3] });
  db.exec("DELETE FROM notifications WHERE type = 'group_promoted'");
  cancelGroupOrder({ orderId: oD.orderId, phone: '0979000004', name: 'PNE-丁' });
  await expect('遞補不併進逾期單：開新單、逾期單金額與期限不變', () => {
    const reg = regOf('0979000001', s3);
    assert.equal(reg.status, 'pending');
    assert.notEqual(reg.order_id, oA.orderId);
    const old = orderOf(oA.orderId);
    assert.equal(old.total_amount, 500);
    assert.ok(old.expires_at < offsetLocal(0), '逾期單的期限不應被延長');
  });
  await expect('遞補開新單 → 客人收到遞補通知', () => {
    const c = db.prepare("SELECT COUNT(*) AS c FROM notifications WHERE type = 'group_promoted' AND user_id = ?").get(uidOf('0979000001')).c;
    assert.equal(c, 1);
  });
}

// ── 6. 管理者手動處理：取消 → 釋出名額並遞補；已收款 → 照常核對 ──
await expect('手動取消逾期單 → 訂單取消、候補的丙遞補成待付款', () => {
  cancelGroupOrder({ orderId: oA.orderId, phone: '0979000001', name: 'PNE-甲' });
  assert.equal(orderOf(oA.orderId).status, 'cancelled');
  assert.equal(regOf('0979000001', s1).status, 'cancelled');
  assert.equal(regOf('0979000003', s1).status, 'pending');
});
await expect('逾期單按已收款 → 訂單 paid、報名 confirmed', () => {
  makeOverdue(oB.orderId);
  confirmGroupOrder({ orderId: oB.orderId, actorId: adminId });
  assert.equal(orderOf(oB.orderId).status, 'paid');
  assert.equal(regOf('0979000002', s2).status, 'confirmed');
  assert.ok(!listPendingOrders().some((o) => o.id === oB.orderId));
});

reset();
console.log('[pending-no-auto-expire test] done');
