// 套裝方案 service：一列一個套裝的新增／修改／停用／刪除、排序、驗證。用獨立的暫存資料庫。
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rmSync } from 'node:fs';
const dbPath = join(tmpdir(), `package-plan-svc-${process.pid}.db`);
for (const s of ['', '-wal', '-shm']) rmSync(dbPath + s, { force: true });
process.env.DB_PATH = dbPath;
const { db } = await import('../src/db/connection.js');
const svc = await import('../src/services/packagePlanService.js');

function expect(label, fn) { try { fn(); console.log(`  ✓ ${label}`); } catch (e) { console.log(`  ✗ ${label}`); console.error(e); process.exitCode = 1; } }
const throwsCode = (fn, status, code) => { let err = null; try { fn(); } catch (e) { err = e; }
  assert.ok(err, `expected throw ${code}`); assert.equal(err.code, code); assert.equal(err.status, status); };
console.log('[package-plan-service test] start');

const base = { sessionType: '1on1', totalSessions: 10, unitPrice: 1400 };
const brief = (p) => `${p.sessionType}/${p.totalSessions}/${p.unitPrice}/${p.name ?? '-'}/${p.isActive ? 'on' : 'off'}`;
const count = () => db.prepare('SELECT COUNT(*) AS c FROM package_plans').get().c;

expect('空的：listPlans 回空陣列', () => {
  assert.deepEqual(svc.listPlans(), []);
  assert.deepEqual(svc.listPlans({ activeOnly: true }), []);
});

let a; let b; let c;
expect('新增：回傳完整的套裝，預設啟用、名稱是 null', () => {
  a = svc.createPlan(base);
  assert.deepEqual(a, { id: a.id, sessionType: '1on1', totalSessions: 10, unitPrice: 1400, name: null, isActive: true });
  assert.ok(Number.isInteger(a.id) && a.id > 0);
});
expect('同類型同堂數可以再建一筆不同價格；名稱去頭尾空白', () => {
  b = svc.createPlan({ ...base, unitPrice: 1300, name: '  舊生價 ' });
  assert.equal(b.name, '舊生價');
  assert.notEqual(b.id, a.id);
});
expect('同類型同堂數同價格、名稱不同也可以', () => {
  c = svc.createPlan({ ...base, unitPrice: 1300, name: '員工價' });
  assert.equal(count(), 3);
});
expect('四項完全相同 → 409 duplicate_plan（空字串、空白、null、沒帶名稱都算沒有名稱）', () => {
  for (const name of [undefined, null, '', '   ']) throwsCode(() => svc.createPlan({ ...base, name }), 409, 'duplicate_plan');
  throwsCode(() => svc.createPlan({ ...base, unitPrice: 1300, name: '舊生價' }), 409, 'duplicate_plan');
  assert.equal(count(), 3);
});
expect('停用的套裝也算重複', () => {
  const d = svc.createPlan({ sessionType: '1on2', totalSessions: 5, unitPrice: 2000, isActive: false });
  assert.equal(d.isActive, false);
  throwsCode(() => svc.createPlan({ sessionType: '1on2', totalSessions: 5, unitPrice: 2000 }), 409, 'duplicate_plan');
  svc.deletePlan(d.id);
});
expect('排序：一對一在前、堂數少到多、同堂數價格高的在前、再依建立先後', () => {
  svc.createPlan({ sessionType: '1on2', totalSessions: 10, unitPrice: 1900 });
  svc.createPlan({ sessionType: '1on1', totalSessions: 1, unitPrice: 1000, name: '體驗價' });
  svc.createPlan({ sessionType: '1on1', totalSessions: 1, unitPrice: 1500 });
  svc.createPlan({ sessionType: '1on2', totalSessions: 1, unitPrice: 2000 });
  assert.deepEqual(svc.listPlans().map(brief), [
    '1on1/1/1500/-/on', '1on1/1/1000/體驗價/on',
    '1on1/10/1400/-/on', '1on1/10/1300/舊生價/on', '1on1/10/1300/員工價/on',
    '1on2/1/2000/-/on', '1on2/10/1900/-/on',
  ]);
});
expect('驗證：類型、堂數、單價、名稱、啟用', () => {
  const n = count();
  throwsCode(() => svc.createPlan({ ...base, sessionType: 'group' }), 400, 'invalid_session_type');
  for (const t of [0, -1, 1.5, 201, '10', null, undefined]) throwsCode(() => svc.createPlan({ ...base, totalSessions: t }), 400, 'invalid_total');
  for (const u of [0, -5, 99.5, 1000001, '1400', null, undefined]) throwsCode(() => svc.createPlan({ ...base, unitPrice: u }), 400, 'invalid_unit_price');
  for (const name of [123, {}, [], true, '一二三四五六七八九十一二三四五六七八九十一']) throwsCode(() => svc.createPlan({ ...base, unitPrice: 999, name }), 400, 'invalid_name');
  for (const isActive of [1, 0, 'true', null]) throwsCode(() => svc.createPlan({ ...base, unitPrice: 999, isActive }), 400, 'invalid_active');
  for (const bad of [undefined, null, 'x', []]) throwsCode(() => svc.createPlan(bad), 400, 'invalid_plan');
  assert.equal(count(), n);
});
expect('名稱剛好 20 個字可以', () => {
  const p = svc.createPlan({ ...base, unitPrice: 998, name: '一二三四五六七八九十一二三四五六七八九十' });
  assert.equal([...p.name].length, 20);
  svc.deletePlan(p.id);
});
expect('修改：只改送來的欄位；回傳修改後的套裝', () => {
  const r = svc.updatePlan(b.id, { unitPrice: 1250 });
  assert.deepEqual(r, { ...b, unitPrice: 1250 });
  assert.deepEqual(svc.getPlan(b.id), r);
  b = r;
});
expect('修改：名稱送 null 或空字串 → 清掉名稱；類型與堂數也能改', () => {
  const r = svc.updatePlan(c.id, { name: '', sessionType: '1on2', totalSessions: 20 });
  assert.deepEqual(r, { id: c.id, sessionType: '1on2', totalSessions: 20, unitPrice: 1300, name: null, isActive: true });
  c = r;
});
expect('修改成和別筆四項完全相同 → 409 duplicate_plan，內容不變；改成和自己相同不算重複', () => {
  throwsCode(() => svc.updatePlan(b.id, { unitPrice: 1400, name: null }), 409, 'duplicate_plan');
  assert.deepEqual(svc.getPlan(b.id), b);
  assert.deepEqual(svc.updatePlan(b.id, { unitPrice: b.unitPrice, name: b.name }), b);
});
expect('修改：欄位不合格 → 400，內容不變；找不到 → 404 plan_not_found；id 不是正整數 → 404', () => {
  throwsCode(() => svc.updatePlan(b.id, { unitPrice: 0 }), 400, 'invalid_unit_price');
  throwsCode(() => svc.updatePlan(b.id, { totalSessions: 0 }), 400, 'invalid_total');
  throwsCode(() => svc.updatePlan(b.id, { isActive: 'no' }), 400, 'invalid_active');
  throwsCode(() => svc.updatePlan(b.id, null), 400, 'invalid_plan');
  assert.deepEqual(svc.getPlan(b.id), b);
  for (const id of [999999, 0, -1, 1.5, NaN, 'x']) throwsCode(() => svc.updatePlan(id, { unitPrice: 1 }), 404, 'plan_not_found');
});
expect('停用後：listPlans 還在、activeOnly 不含它；findActivePlan 回 null', () => {
  const r = svc.updatePlan(a.id, { isActive: false });
  assert.equal(r.isActive, false);
  assert.ok(svc.listPlans().some((p) => p.id === a.id));
  assert.ok(!svc.listPlans({ activeOnly: true }).some((p) => p.id === a.id));
  assert.equal(svc.findActivePlan(a.id), null);
  assert.deepEqual(svc.findActivePlan(b.id), b);
  assert.equal(svc.findActivePlan(999999), null);
});
expect('重新啟用後又回到 activeOnly', () => {
  svc.updatePlan(a.id, { isActive: true });
  assert.ok(svc.listPlans({ activeOnly: true }).some((p) => p.id === a.id));
  a = svc.getPlan(a.id);
});
expect('matchActivePlans：依類型＋堂數找啟用中的套裝（給還沒重新整理的舊畫面核價）', () => {
  assert.deepEqual(svc.matchActivePlans('1on1', 10).map((p) => p.unitPrice), [1400, 1250]);
  assert.deepEqual(svc.matchActivePlans('1on1', 99), []);
  svc.updatePlan(b.id, { isActive: false });
  assert.deepEqual(svc.matchActivePlans('1on1', 10).map((p) => p.unitPrice), [1400]);
  svc.updatePlan(b.id, { isActive: true });
});
expect('刪除：回 { ok: true }，再查不到；刪第二次 → 404 plan_not_found', () => {
  const n = count();
  assert.deepEqual(svc.deletePlan(c.id), { ok: true });
  assert.equal(svc.getPlan(c.id), null);
  assert.equal(count(), n - 1);
  throwsCode(() => svc.deletePlan(c.id), 404, 'plan_not_found');
});
expect('上限 100 筆：第 101 筆 → 400 too_many_plans', () => {
  const ins = db.prepare("INSERT INTO package_plans (session_type, total_sessions, unit_price, name) VALUES ('1on2', 200, ?, '填充')");
  for (let i = count(); i < 100; i++) ins.run(5000 + i);
  assert.equal(count(), 100);
  throwsCode(() => svc.createPlan({ sessionType: '1on1', totalSessions: 3, unitPrice: 777 }), 400, 'too_many_plans');
  assert.equal(count(), 100);
  // 修改與刪除不受上限影響
  assert.equal(svc.updatePlan(a.id, { unitPrice: 1401 }).unitPrice, 1401);
});

db.close();
for (const s of ['', '-wal', '-shm']) rmSync(dbPath + s, { force: true });
console.log('[package-plan-service test] done');
