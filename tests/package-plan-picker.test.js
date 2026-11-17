// 「新增方案」選法的純邏輯（public/package-plan-picker.js，不需要瀏覽器）。
import assert from 'node:assert/strict';
const pp = await import('../public/package-plan-picker.js');

function expect(label, fn) { try { fn(); console.log(`  ✓ ${label}`); } catch (e) { console.log(`  ✗ ${label}`); console.error(e); process.exitCode = 1; } }
console.log('[package-plan-picker test] start');

const plans = [
  { sessionType: '1on1', totalSessions: 20, unitPrice: 1300 },
  { sessionType: '1on1', totalSessions: 10, unitPrice: 1400 },
  { sessionType: '1on2', totalSessions: 10, unitPrice: 1900 },
];
const only1on1 = plans.filter((p) => p.sessionType === '1on1');

expect('optionsForType：只給該類型、堂數小到大', () => {
  assert.deepEqual(pp.optionsForType(plans, '1on1'), [{ totalSessions: 10, unitPrice: 1400 }, { totalSessions: 20, unitPrice: 1300 }]);
  assert.deepEqual(pp.optionsForType(only1on1, '1on2'), []);
});
expect('initialState：一對一、堂數不預選；一對一沒有套裝時直接是自訂', () => {
  assert.deepEqual(pp.initialState(plans), { sessionType: '1on1', choice: null, customTotal: '', customUnit: '' });
  assert.equal(pp.initialState([plans[2]]).choice, 'custom');
});
expect('沒選堂數 → 請先選堂數', () => {
  assert.deepEqual(pp.selectionOf(pp.initialState(plans), plans), { ok: false, message: '請先選堂數' });
});
expect('選套裝 → 帶價目表的單價、fromPlan true', () => {
  const s = { ...pp.initialState(plans), choice: 10 };
  assert.deepEqual(pp.selectionOf(s, plans), { ok: true, sessionType: '1on1', totalSessions: 10, unitPrice: 1400, fromPlan: true });
  assert.deepEqual(pp.packageFields(pp.selectionOf(s, plans)), { sessionType: '1on1', totalSessions: 10, amount: 14000, fromPlan: true });
});
expect('切換類型：原本選套裝 → 清掉；新類型沒有套裝 → 自訂', () => {
  const s = { ...pp.initialState(plans), choice: 10 };
  assert.equal(pp.withType(s, plans, '1on2').choice, null);
  assert.equal(pp.withType(s, plans, '1on2').sessionType, '1on2');
  assert.equal(pp.withType(s, only1on1, '1on2').choice, 'custom');
});
expect('切換類型：原本是自訂 → 維持自訂、輸入保留', () => {
  const s = { sessionType: '1on1', choice: 'custom', customTotal: '8', customUnit: '1500' };
  assert.deepEqual(pp.withType(s, plans, '1on2'), { sessionType: '1on2', choice: 'custom', customTotal: '8', customUnit: '1500' });
});
expect('自訂：有效 → fromPlan false；單價留空 → unitPrice null、amount null', () => {
  const s = { sessionType: '1on2', choice: 'custom', customTotal: '8', customUnit: '1500' };
  assert.deepEqual(pp.selectionOf(s, plans), { ok: true, sessionType: '1on2', totalSessions: 8, unitPrice: 1500, fromPlan: false });
  const blank = pp.selectionOf({ ...s, customUnit: '' }, plans);
  assert.equal(blank.unitPrice, null);
  assert.deepEqual(pp.packageFields(blank), { sessionType: '1on2', totalSessions: 8, amount: null, fromPlan: false });
  assert.equal(pp.selectionOf({ ...s, customUnit: '0' }, plans).unitPrice, 0);
});
expect('自訂：堂數或單價不合格', () => {
  const s = { sessionType: '1on1', choice: 'custom', customTotal: '', customUnit: '' };
  for (const t of ['', '0', '-1', '1.5', 'abc']) assert.deepEqual(pp.selectionOf({ ...s, customTotal: t }, plans), { ok: false, message: '請填正確堂數' });
  for (const u of ['-1', '1.5', 'abc']) assert.deepEqual(pp.selectionOf({ ...s, customTotal: '8', customUnit: u }, plans), { ok: false, message: '單價需為 0 以上整數' });
});
expect('價目表是空的時候選自訂 → 不帶 fromPlan', () => {
  const sel = pp.selectionOf({ sessionType: '1on1', choice: 'custom', customTotal: '8', customUnit: '1500' }, []);
  assert.equal(sel.fromPlan, undefined);
  assert.deepEqual(pp.packageFields(sel), { sessionType: '1on1', totalSessions: 8, amount: 12000 });
});
expect('withPlans：選過的套裝一律清掉；自訂維持；該類型沒有套裝了 → 自訂', () => {
  const chosen = { ...pp.initialState(plans), choice: 10 };
  assert.equal(pp.withPlans(chosen, plans).choice, null);
  assert.equal(pp.withPlans(chosen, [plans[2]]).choice, 'custom');
  const custom = { sessionType: '1on1', choice: 'custom', customTotal: '8', customUnit: '' };
  assert.deepEqual(pp.withPlans(custom, plans), custom);
});
expect('選的套裝已不在價目表上 → 視同沒選', () => {
  assert.deepEqual(pp.selectionOf({ ...pp.initialState(plans), choice: 30 }, plans), { ok: false, message: '請先選堂數' });
});
expect('calcTextOf：文字與現有表單相同', () => {
  const chosen = { ...pp.initialState(plans), choice: 10 };
  assert.equal(pp.calcTextOf(chosen, plans, false), '10 堂 × NT$1,400 ＝ 總額 NT$14,000');
  assert.equal(pp.calcTextOf(chosen, plans, true), '10 堂 × NT$1,400 ＝ 總額 NT$14,000（套用折扣碼後以折後總額入帳）');
  assert.equal(pp.calcTextOf(pp.initialState(plans), plans, false), '');
  const custom = { sessionType: '1on1', choice: 'custom', customTotal: '8', customUnit: '1500' };
  assert.equal(pp.calcTextOf(custom, plans, false), '8 堂 × NT$1,500 ＝ 總額 NT$12,000');
  assert.equal(pp.calcTextOf({ ...custom, customUnit: '' }, plans, false), '未填單價 → 建立為「無單價」方案');
  assert.equal(pp.calcTextOf({ ...custom, customTotal: '' }, plans, false), '');
});
console.log('[package-plan-picker test] done');
