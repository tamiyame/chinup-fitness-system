// 開會員方案帶 fromPlan：核價、from_plan 三種值、既有行為不變。用獨立的暫存資料庫。
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
const { getPlanTable, replacePlanTable } = await import('../src/services/packagePlanService.js');
const { createDiscountCode } = await import('../src/services/discountService.js');

function expect(label, fn) { try { fn(); console.log(`  ✓ ${label}`); } catch (e) { console.log(`  ✗ ${label}`); console.error(e); process.exitCode = 1; } }
const throwsCode = (fn, status, code) => { let err = null; try { fn(); } catch (e) { err = e; }
  assert.ok(err, `expected throw ${code}`); assert.equal(err.code, code); assert.equal(err.status, status); };
console.log('[package-from-plan test] start');

const m = Number(db.prepare("INSERT INTO users (name,email,role,phone) VALUES ('套裝客','pfp-m@x.com','user','0967000001')").run().lastInsertRowid);
const admin = Number(db.prepare("INSERT INTO users (name,email,role,is_admin) VALUES ('套裝管','pfp-a@x.com','coach',1)").run().lastInsertRowid);
const coachId = Number(db.prepare("INSERT INTO coaches (user_id, display_name, is_active) VALUES (?, '套裝教練', 1)").run(admin).lastInsertRowid);
const setPlans = (plans) => replacePlanTable({ version: getPlanTable().version, plans });
const count = () => db.prepare('SELECT COUNT(*) AS c FROM customer_packages').get().c;
const mk = (extra) => pkg.createPackage({ memberId: m, sessionType: '1on1', totalSessions: 10, createdBy: admin, ...extra });
setPlans([{ sessionType: '1on1', totalSessions: 10, unitPrice: 1400 }, { sessionType: '1on2', totalSessions: 10, unitPrice: 1900 }]);
createDiscountCode({ code: 'PFP500', discount_type: 'fixed', discount_value: 500 });

expect('fromPlan:true 且金額＝單價×堂數 → 建立，from_plan = 1', () => {
  const p = mk({ amount: 14000, fromPlan: true });
  assert.equal(p.amount, 14000);
  assert.equal(p.from_plan, 1);
  assert.equal(p.remaining_sessions, 10);
});
expect('fromPlan:true 加折扣碼 → 以折前總額核價、入帳是折後總額，from_plan = 1', () => {
  const p = mk({ amount: 14000, fromPlan: true, discountCode: 'PFP500' });
  assert.equal(p.amount, 13500);
  assert.equal(p.discount_code, 'PFP500');
  assert.equal(p.from_plan, 1);
});
expect('價目表沒有那個組合 → 409 plan_not_available，沒有新增方案', () => {
  const n = count();
  throwsCode(() => mk({ totalSessions: 20, amount: 28000, fromPlan: true }), 409, 'plan_not_available');
  assert.equal(count(), n);
});
expect('金額對不上或沒帶 → 409 plan_price_changed，沒有新增方案', () => {
  const n = count();
  throwsCode(() => mk({ amount: 15000, fromPlan: true }), 409, 'plan_price_changed');
  throwsCode(() => mk({ amount: null, fromPlan: true }), 409, 'plan_price_changed');
  throwsCode(() => mk({ fromPlan: true }), 409, 'plan_price_changed');
  assert.equal(count(), n);
});
expect('基本欄位先檢查：類型錯仍是 400 invalid_session_type', () => {
  throwsCode(() => mk({ sessionType: 'x', amount: 14000, fromPlan: true }), 400, 'invalid_session_type');
});
expect('fromPlan:false → from_plan = 0，其餘與不帶時相同', () => {
  const p = mk({ totalSessions: 8, amount: 12000, fromPlan: false });
  assert.equal(p.from_plan, 0);
  assert.equal(p.amount, 12000);
  assert.equal(p.total_sessions, 8);
  assert.equal(p.remaining_sessions, 8);
});
expect('不帶 fromPlan（或 null）→ from_plan 是 NULL', () => {
  assert.equal(mk({ amount: 15000 }).from_plan, null);
  assert.equal(mk({ amount: 15000, fromPlan: null }).from_plan, null);
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
expect('改價目表後，先前開出的方案金額不變', () => {
  const p = mk({ amount: 14000, fromPlan: true });
  setPlans([{ sessionType: '1on1', totalSessions: 10, unitPrice: 1600 }]);
  assert.equal(pkg.getPackage(p.id).amount, 14000);
  assert.equal(pkg.getPackage(p.id).from_plan, 1);
  throwsCode(() => mk({ amount: 14000, fromPlan: true }), 409, 'plan_price_changed');
  assert.equal(mk({ amount: 16000, fromPlan: true }).from_plan, 1);
});
expect('線上單堂方案的 from_plan 是 NULL', () => {
  const b = Number(db.prepare("INSERT INTO bookings (coach_id, member_id, start_at, end_at, session_type, original_amount) VALUES (?, ?, '2099-01-05T10:00:00', '2099-01-05T11:00:00', '1on1', 1500)").run(coachId, m).lastInsertRowid);
  const id = pkg.createOnlineSingleForBooking(b);
  assert.equal(db.prepare('SELECT from_plan FROM customer_packages WHERE id = ?').get(id).from_plan, null);
});

db.close();
for (const s of ['', '-wal', '-shm']) rmSync(dbPath + s, { force: true });
console.log('[package-from-plan test] done');
