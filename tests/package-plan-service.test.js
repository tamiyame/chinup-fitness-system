// 套裝方案價目表 service：讀取、整張取代、版本、驗證。用獨立的暫存資料庫。
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rmSync } from 'node:fs';
const dbPath = join(tmpdir(), `package-plan-svc-${process.pid}.db`);
for (const s of ['', '-wal', '-shm']) rmSync(dbPath + s, { force: true });
process.env.DB_PATH = dbPath;
const { db } = await import('../src/db/connection.js');
const { getPlanTable, replacePlanTable, findPlan } = await import('../src/services/packagePlanService.js');

function expect(label, fn) { try { fn(); console.log(`  ✓ ${label}`); } catch (e) { console.log(`  ✗ ${label}`); console.error(e); process.exitCode = 1; } }
const throwsCode = (fn, status, code) => { let err = null; try { fn(); } catch (e) { err = e; }
  assert.ok(err, `expected throw ${code}`); assert.equal(err.code, code); assert.equal(err.status, status); };
console.log('[package-plan-service test] start');

const A = { sessionType: '1on1', totalSessions: 10, unitPrice: 1400 };
const B = { sessionType: '1on2', totalSessions: 10, unitPrice: 1900 };
const C = { sessionType: '1on1', totalSessions: 20, unitPrice: 1300 };
const D = { sessionType: '1on1', totalSessions: 5, unitPrice: 1450 };
const save = (plans) => replacePlanTable({ version: getPlanTable().version, plans });

expect('空表：plans 是空陣列、版本是非空字串', () => {
  const t = getPlanTable();
  assert.deepEqual(t.plans, []);
  assert.equal(typeof t.version, 'string');
  assert.ok(t.version.length > 0);
});
expect('儲存後依堂數小到大、同堂數一對一在前；版本改變；回傳與 getPlanTable 相同', () => {
  const v0 = getPlanTable().version;
  const r = replacePlanTable({ version: v0, plans: [C, B, A, D] });
  assert.deepEqual(r.plans, [D, A, B, C]);
  assert.notEqual(r.version, v0);
  assert.deepEqual(getPlanTable(), r);
});
expect('findPlan：有就回那一筆，沒有回 null', () => {
  assert.deepEqual(findPlan('1on2', 10), B);
  assert.equal(findPlan('1on2', 20), null);
});
expect('整張取代：沒送的組合消失', () => {
  assert.deepEqual(save([A]).plans, [A]);
  assert.equal(findPlan('1on2', 10), null);
});
expect('同一個版本存第二次 → 409 plans_changed，內容是第一次存的', () => {
  const v = getPlanTable().version;
  replacePlanTable({ version: v, plans: [A, B] });
  throwsCode(() => replacePlanTable({ version: v, plans: [C] }), 409, 'plans_changed');
  assert.deepEqual(getPlanTable().plans, [A, B]);
});
expect('沒帶版本、版本不是字串或數字 → 409 plans_changed，內容不變', () => {
  for (const bad of [undefined, null, {}, [], true]) throwsCode(() => replacePlanTable({ version: bad, plans: [C] }), 409, 'plans_changed');
  assert.deepEqual(getPlanTable().plans, [A, B]);
});
expect('版本用數字送也認', () => {
  const v = getPlanTable().version;
  assert.deepEqual(replacePlanTable({ version: Number(v), plans: [A, B] }).plans, [A, B]);
});
expect('版本對不上時不檢查內容：先回 plans_changed', () => {
  throwsCode(() => replacePlanTable({ version: 'nope', plans: 'x' }), 409, 'plans_changed');
});

// 驗證錯誤：整批不存，內容與版本都不變（此時表裡是 [A, B]）
const bad = (plans, code) => { const before = getPlanTable();
  throwsCode(() => replacePlanTable({ version: before.version, plans }), 400, code);
  assert.deepEqual(getPlanTable(), before); };
const many = (n) => Array.from({ length: n }, (_, i) => ({ sessionType: i % 2 ? '1on2' : '1on1', totalSessions: Math.floor(i / 2) + 1, unitPrice: 1000 }));
expect('plans 不是陣列 → invalid_plans', () => { bad(undefined, 'invalid_plans'); bad('x', 'invalid_plans'); bad({}, 'invalid_plans'); });
expect('項目不是物件 → invalid_plans', () => { bad([null], 'invalid_plans'); bad([A, 'x'], 'invalid_plans'); });
expect('超過 60 筆 → invalid_plans', () => bad(many(61), 'invalid_plans'));
expect('類型不對 → invalid_session_type', () => { bad([{ ...A, sessionType: 'group' }], 'invalid_session_type'); bad([{ totalSessions: 10, unitPrice: 1400 }], 'invalid_session_type'); });
expect('堂數 0、201、1.5、字串 → invalid_total', () => { for (const t of [0, 201, 1.5, '10', null]) bad([A, { ...C, totalSessions: t }], 'invalid_total'); });
expect('單價 0、1000001、1.5、字串 → invalid_unit_price', () => { for (const u of [0, 1000001, 1.5, '1400', null]) bad([A, { ...C, unitPrice: u }], 'invalid_unit_price'); });
expect('同類型同堂數出現兩次 → duplicate_plan', () => bad([A, B, { ...A, unitPrice: 1500 }], 'duplicate_plan'));
expect('剛好 60 筆、邊界值（堂數 1 與 200、單價 1 與 1000000）可以存', () => {
  assert.equal(save(many(60)).plans.length, 60);
  const edge = [{ sessionType: '1on1', totalSessions: 1, unitPrice: 1 }, { sessionType: '1on2', totalSessions: 200, unitPrice: 1000000 }];
  assert.deepEqual(save(edge).plans, edge);
});
expect('空陣列合法：清空價目表，版本照樣前進', () => {
  const v = getPlanTable().version;
  const r = save([]);
  assert.deepEqual(r.plans, []);
  assert.notEqual(r.version, v);
});

db.close();
for (const s of ['', '-wal', '-shm']) rmSync(dbPath + s, { force: true });
console.log('[package-plan-service test] done');
