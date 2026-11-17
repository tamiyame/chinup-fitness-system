// 開會員方案帶 planId／fromPlan：核價、from_plan 三種值、舊畫面相容、既有行為不變。用獨立的暫存資料庫。
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rmSync } from 'node:fs';
const dbPath = join(tmpdir(), `package-from-plan-${process.pid}.db`);
for (const s of ['', '-wal', '-shm']) rmSync(dbPath + s, { force: true });
process.env.DB_PATH = dbPath;
process.env.LINE_MOCK = '1'; process.env.GMAIL_MOCK = '1'; process.env.GCAL_MOCK = '1';
const { db } = await import('../src/db/connection.js');
const pkg = await import('../src/services/packageService.js');
const plans = await import('../src/services/packagePlanService.js');
const { createDiscountCode } = await import('../src/services/discountService.js');

function expect(label, fn) { try { fn(); console.log(`  ✓ ${label}`); } catch (e) { console.log(`  ✗ ${label}`); console.error(e); process.exitCode = 1; } }
const throwsCode = (fn, status, code) => { let err = null; try { fn(); } catch (e) { err = e; }
  assert.ok(err, `expected throw ${code}`); assert.equal(err.code, code); assert.equal(err.status, status); };
console.log('[package-from-plan test] start');

const m = Number(db.prepare("INSERT INTO users (name,email,role,phone) VALUES ('套裝客','pfp-m@x.com','user','0967000001')").run().lastInsertRowid);
const admin = Number(db.prepare("INSERT INTO users (name,email,role,is_admin) VALUES ('套裝管','pfp-a@x.com','coach',1)").run().lastInsertRowid);
const coachId = Number(db.prepare("INSERT INTO coaches (user_id, display_name, is_active) VALUES (?, '套裝教練', 1)").run(admin).lastInsertRowid);
const count = () => db.prepare('SELECT COUNT(*) AS c FROM customer_packages').get().c;
const mk = (extra) => pkg.createPackage({ memberId: m, sessionType: '1on1', totalSessions: 10, createdBy: admin, ...extra });
// 一對一 10 堂有兩個價：原價 1,400 與舊生價 1,300；一對二 10 堂 1,900
const full = plans.createPlan({ sessionType: '1on1', totalSessions: 10, unitPrice: 1400 });
const old = plans.createPlan({ sessionType: '1on1', totalSessions: 10, unitPrice: 1300, name: '舊生價' });
const duo = plans.createPlan({ sessionType: '1on2', totalSessions: 10, unitPrice: 1900 });
createDiscountCode({ code: 'PFP500', discount_type: 'fixed', discount_value: 500 });

// ---- 帶 planId（新畫面）----
expect('planId 且金額＝該套裝單價×堂數 → 建立，from_plan = 1', () => {
  const p = mk({ planId: full.id, amount: 14000 });
  assert.equal(p.amount, 14000);
  assert.equal(p.from_plan, 1);
  assert.equal(p.remaining_sessions, 10);
});
expect('同堂數的另一個價（舊生價）用它自己的 planId → 建立', () => {
  const p = mk({ planId: old.id, amount: 13000, fromPlan: true });
  assert.equal(p.amount, 13000);
  assert.equal(p.from_plan, 1);
});
expect('planId 加折扣碼 → 以折前總額核價、入帳是折後總額', () => {
  const p = mk({ planId: full.id, amount: 14000, discountCode: 'PFP500' });
  assert.equal(p.amount, 13500);
  assert.equal(p.discount_code, 'PFP500');
  assert.equal(p.from_plan, 1);
});
expect('planId 的金額是另一個套裝的價（拿舊生價的金額配原價的編號）→ 409 plan_price_changed', () => {
  const n = count();
  throwsCode(() => mk({ planId: full.id, amount: 13000 }), 409, 'plan_price_changed');
  throwsCode(() => mk({ planId: full.id, amount: null }), 409, 'plan_price_changed');
  throwsCode(() => mk({ planId: full.id }), 409, 'plan_price_changed');
  assert.equal(count(), n);
});
expect('planId 的類型或堂數和送來的不一樣 → 409 plan_price_changed', () => {
  const n = count();
  throwsCode(() => mk({ planId: duo.id, amount: 19000 }), 409, 'plan_price_changed');
  throwsCode(() => mk({ planId: full.id, totalSessions: 20, amount: 28000 }), 409, 'plan_price_changed');
  assert.equal(count(), n);
});
expect('planId 不存在或已停用 → 409 plan_not_available，沒有新增方案', () => {
  const n = count();
  throwsCode(() => mk({ planId: 999999, amount: 14000 }), 409, 'plan_not_available');
  plans.updatePlan(duo.id, { isActive: false });
  throwsCode(() => mk({ planId: duo.id, sessionType: '1on2', amount: 19000 }), 409, 'plan_not_available');
  plans.updatePlan(duo.id, { isActive: true });
  assert.equal(mk({ planId: duo.id, sessionType: '1on2', amount: 19000 }).from_plan, 1);
  assert.equal(count(), n + 1);
});
expect('planId 不是正整數 → 400 invalid_plan_id，沒有新增方案', () => {
  const n = count();
  for (const v of ['3', 0, -1, 1.5, true, {}, []]) throwsCode(() => mk({ planId: v, amount: 14000 }), 400, 'invalid_plan_id');
  assert.equal(count(), n);
});
expect('planId 同時送 fromPlan:false（自相矛盾）→ 400 invalid_from_plan', () => {
  throwsCode(() => mk({ planId: full.id, amount: 14000, fromPlan: false }), 400, 'invalid_from_plan');
});
expect('基本欄位先檢查：類型錯仍是 400 invalid_session_type', () => {
  throwsCode(() => mk({ sessionType: 'x', planId: full.id, amount: 14000 }), 400, 'invalid_session_type');
});

// ---- 只帶 fromPlan:true（還沒重新整理的舊畫面）----
// 舊畫面同堂數只畫得出一顆按鈕、分不出是哪個價，所以同堂數有兩種價時一律不收，免得開成別的價
expect('舊畫面 fromPlan:true：同類型同堂數有兩種啟用中的價 → 409 plan_price_changed（哪個金額都不收）', () => {
  const n = count();
  throwsCode(() => mk({ amount: 14000, fromPlan: true }), 409, 'plan_price_changed');
  throwsCode(() => mk({ amount: 13000, fromPlan: true }), 409, 'plan_price_changed');
  assert.equal(count(), n);
});
expect('舊畫面 fromPlan:true：同堂數只剩一種啟用中的價 → 金額相符就建立，from_plan = 1', () => {
  plans.updatePlan(old.id, { isActive: false });
  assert.equal(mk({ amount: 14000, fromPlan: true }).from_plan, 1);
  plans.updatePlan(old.id, { isActive: true });
  assert.equal(mk({ sessionType: '1on2', amount: 19000, fromPlan: true }).from_plan, 1);
});
expect('舊畫面 fromPlan:true：同堂數兩筆同價不同名稱 → 不算兩種價，照收', () => {
  const twin = plans.createPlan({ sessionType: '1on2', totalSessions: 10, unitPrice: 1900, name: '員工價' });
  assert.equal(mk({ sessionType: '1on2', amount: 19000, fromPlan: true }).from_plan, 1);
  plans.deletePlan(twin.id);
});
expect('舊畫面 fromPlan:true：沒有這個類型＋堂數的啟用中套裝 → 409 plan_not_available', () => {
  const n = count();
  throwsCode(() => mk({ totalSessions: 20, amount: 28000, fromPlan: true }), 409, 'plan_not_available');
  assert.equal(count(), n);
});
expect('舊畫面 fromPlan:true：金額對不上或沒帶 → 409 plan_price_changed；停用的套裝不算', () => {
  plans.updatePlan(old.id, { isActive: false });
  const n = count();
  throwsCode(() => mk({ amount: 15000, fromPlan: true }), 409, 'plan_price_changed');
  throwsCode(() => mk({ amount: 13000, fromPlan: true }), 409, 'plan_price_changed');
  throwsCode(() => mk({ amount: null, fromPlan: true }), 409, 'plan_price_changed');
  throwsCode(() => mk({ fromPlan: true }), 409, 'plan_price_changed');
  assert.equal(count(), n);
  plans.updatePlan(old.id, { isActive: true });
});

// ---- 自訂與舊行為 ----
expect('fromPlan:false → from_plan = 0，其餘與不帶時相同', () => {
  const p = mk({ totalSessions: 8, amount: 12000, fromPlan: false });
  assert.equal(p.from_plan, 0);
  assert.equal(p.amount, 12000);
  assert.equal(p.total_sessions, 8);
  assert.equal(p.remaining_sessions, 8);
});
expect('不帶 fromPlan（或 null）、planId 是 null → from_plan 是 NULL', () => {
  assert.equal(mk({ amount: 15000 }).from_plan, null);
  assert.equal(mk({ amount: 15000, fromPlan: null, planId: null }).from_plan, null);
});
expect('不帶 fromPlan、單價留空 → 無單價方案；帶了折扣碼也略過', () => {
  const p = mk({ amount: null, discountCode: 'PFP500' });
  assert.equal(p.amount, null);
  assert.equal(p.discount_code, null);
  assert.equal(p.from_plan, null);
});
expect('fromPlan 不是布林 → 400 invalid_from_plan，沒有新增方案', () => {
  const n = count();
  for (const v of ['true', 1, 0, 'false']) throwsCode(() => mk({ amount: 14000, fromPlan: v }), 400, 'invalid_from_plan');
  assert.equal(count(), n);
});
expect('套裝改價或刪除後，先前開出的方案金額不變；舊價不能再開', () => {
  const p = mk({ planId: full.id, amount: 14000 });
  plans.updatePlan(full.id, { unitPrice: 1600 });
  assert.equal(pkg.getPackage(p.id).amount, 14000);
  assert.equal(pkg.getPackage(p.id).from_plan, 1);
  throwsCode(() => mk({ planId: full.id, amount: 14000 }), 409, 'plan_price_changed');
  assert.equal(mk({ planId: full.id, amount: 16000 }).from_plan, 1);
  plans.deletePlan(full.id);
  assert.equal(pkg.getPackage(p.id).amount, 14000);
  throwsCode(() => mk({ planId: full.id, amount: 16000 }), 409, 'plan_not_available');
});
expect('線上單堂方案的 from_plan 是 NULL', () => {
  const b = Number(db.prepare("INSERT INTO bookings (coach_id, member_id, start_at, end_at, session_type, original_amount) VALUES (?, ?, '2099-01-05T10:00:00', '2099-01-05T11:00:00', '1on1', 1500)").run(coachId, m).lastInsertRowid);
  const id = pkg.createOnlineSingleForBooking(b);
  assert.equal(db.prepare('SELECT from_plan FROM customer_packages WHERE id = ?').get(id).from_plan, null);
});

db.close();
for (const s of ['', '-wal', '-shm']) rmSync(dbPath + s, { force: true });
console.log('[package-from-plan test] done');
