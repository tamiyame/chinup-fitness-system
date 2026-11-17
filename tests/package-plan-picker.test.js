// 「新增方案」選法的純邏輯（public/package-plan-picker.js，不需要瀏覽器）。
import assert from 'node:assert/strict';
const pp = await import('../public/package-plan-picker.js');

function expect(label, fn) { try { fn(); console.log(`  ✓ ${label}`); } catch (e) { console.log(`  ✗ ${label}`); console.error(e); process.exitCode = 1; } }
console.log('[package-plan-picker test] start');

// 伺服器回來的順序：一對一在前、堂數少到多、同堂數價格高的在前
const plans = [
  { id: 11, sessionType: '1on1', totalSessions: 10, unitPrice: 1400, name: null, isActive: true },
  { id: 12, sessionType: '1on1', totalSessions: 10, unitPrice: 1300, name: '舊生價', isActive: true },
  { id: 13, sessionType: '1on1', totalSessions: 20, unitPrice: 1300, name: null, isActive: true },
  { id: 21, sessionType: '1on2', totalSessions: 10, unitPrice: 1900, name: null, isActive: true },
];
const start = pp.initialState(plans);

expect('parseAmount：空白 → null；千分位、全形數字、前後空白都認；其他 → NaN', () => {
  assert.equal(pp.parseAmount(''), null);
  assert.equal(pp.parseAmount('   '), null);
  assert.equal(pp.parseAmount(null), null);
  assert.equal(pp.parseAmount('1,400'), 1400);
  assert.equal(pp.parseAmount(' 1400 '), 1400);
  assert.equal(pp.parseAmount('１，４００'), 1400);
  assert.equal(pp.parseAmount('0'), 0);
  for (const bad of ['abc', '1.5', '-1', '1 400', 'NT$1400']) assert.ok(Number.isNaN(pp.parseAmount(bad)), bad);
});
expect('planTitle／planOptionLabel：有名稱夾在中間，沒有就不出現', () => {
  assert.equal(pp.planTitle(plans[0]), '一對一 10 堂');
  assert.equal(pp.planTitle(plans[3]), '一對二 10 堂');
  assert.equal(pp.planOptionLabel(plans[0]), '一對一 10 堂・每堂 NT$1,400');
  assert.equal(pp.planOptionLabel(plans[1]), '一對一 10 堂・舊生價・每堂 NT$1,300');
});
expect('initialState：有套裝 → 還沒選；沒有套裝 → 直接是自訂', () => {
  assert.deepEqual(start, { choice: null, sessionType: '1on1', customTotal: '', customUnit: '' });
  assert.equal(pp.initialState([]).choice, 'custom');
  assert.equal(pp.initialState(null).choice, 'custom');
});
expect('還沒選 → 請先選擇套裝', () => {
  assert.deepEqual(pp.selectionOf(start, plans), { ok: false, message: '請先選擇套裝' });
});
expect('withChoice：選單的值（字串）轉成選擇', () => {
  assert.equal(pp.withChoice(start, '12').choice, 12);
  assert.equal(pp.withChoice(start, 'custom').choice, 'custom');
  assert.equal(pp.withChoice({ ...start, choice: 12 }, '').choice, null);
  assert.equal(pp.withChoice(start, 'x').choice, null);
});
expect('選套裝 → 帶那一個套裝的類型、堂數、單價與編號，fromPlan true', () => {
  const sel = pp.selectionOf(pp.withChoice(start, '11'), plans);
  assert.deepEqual(sel, { ok: true, sessionType: '1on1', totalSessions: 10, unitPrice: 1400, fromPlan: true, planId: 11 });
  assert.deepEqual(pp.packageFields(sel), { sessionType: '1on1', totalSessions: 10, amount: 14000, fromPlan: true, planId: 11 });
});
expect('同堂數的另一個價：選到的是舊生價那一筆', () => {
  const sel = pp.selectionOf(pp.withChoice(start, '12'), plans);
  assert.deepEqual(pp.packageFields(sel), { sessionType: '1on1', totalSessions: 10, amount: 13000, fromPlan: true, planId: 12 });
});
expect('選一對二的套裝 → 類型跟著套裝，不看自訂用的類型', () => {
  const sel = pp.selectionOf({ ...start, choice: 21, sessionType: '1on1' }, plans);
  assert.equal(sel.sessionType, '1on2');
  assert.equal(sel.planId, 21);
});
expect('選的套裝已經不在清單上 → 視同沒選', () => {
  assert.deepEqual(pp.selectionOf({ ...start, choice: 99 }, plans), { ok: false, message: '請先選擇套裝' });
});
expect('自訂：有效 → fromPlan false、不帶 planId；類型用自訂選的', () => {
  const s = { choice: 'custom', sessionType: '1on2', customTotal: '8', customUnit: '1,500' };
  assert.deepEqual(pp.selectionOf(s, plans), { ok: true, sessionType: '1on2', totalSessions: 8, unitPrice: 1500, fromPlan: false });
  assert.deepEqual(pp.packageFields(pp.selectionOf(s, plans)), { sessionType: '1on2', totalSessions: 8, amount: 12000, fromPlan: false });
});
expect('自訂：單價留空 → unitPrice null、amount null；單價 0 可以', () => {
  const s = { choice: 'custom', sessionType: '1on1', customTotal: '8', customUnit: '' };
  const blank = pp.selectionOf(s, plans);
  assert.equal(blank.unitPrice, null);
  assert.deepEqual(pp.packageFields(blank), { sessionType: '1on1', totalSessions: 8, amount: null, fromPlan: false });
  assert.equal(pp.selectionOf({ ...s, customUnit: '0' }, plans).unitPrice, 0);
});
expect('自訂：堂數或單價不合格', () => {
  const s = { choice: 'custom', sessionType: '1on1', customTotal: '', customUnit: '' };
  for (const t of ['', '0', '-1', '1.5', 'abc']) assert.deepEqual(pp.selectionOf({ ...s, customTotal: t }, plans), { ok: false, message: '請填正確堂數' });
  for (const u of ['-1', '1.5', 'abc']) assert.deepEqual(pp.selectionOf({ ...s, customTotal: '8', customUnit: u }, plans), { ok: false, message: '單價需為 0 以上整數' });
});
expect('沒有任何套裝時選自訂 → 不帶 fromPlan', () => {
  const sel = pp.selectionOf({ choice: 'custom', sessionType: '1on1', customTotal: '8', customUnit: '1500' }, []);
  assert.equal(sel.fromPlan, undefined);
  assert.deepEqual(pp.packageFields(sel), { sessionType: '1on1', totalSessions: 8, amount: 12000 });
});
expect('withPlans（清單重新讀取後）：選過的套裝一律清掉；自訂與輸入維持；清單空了 → 自訂', () => {
  const chosen = pp.withChoice(start, '11');
  assert.equal(pp.withPlans(chosen, plans).choice, null);
  assert.equal(pp.withPlans(chosen, []).choice, 'custom');
  const custom = { choice: 'custom', sessionType: '1on2', customTotal: '8', customUnit: '' };
  assert.deepEqual(pp.withPlans(custom, plans), custom);
});
expect('calcPartsOf：算式、總額、折扣說明分成三段', () => {
  const chosen = pp.withChoice(start, '12');
  assert.deepEqual(pp.calcPartsOf(chosen, plans, false), { text: '10 堂 × NT$1,300', total: 'NT$13,000', note: null });
  assert.deepEqual(pp.calcPartsOf(chosen, plans, true), { text: '10 堂 × NT$1,300', total: 'NT$13,000', note: '套用折扣碼後以折後總額入帳' });
  const custom = { choice: 'custom', sessionType: '1on1', customTotal: '8', customUnit: '1500' };
  assert.deepEqual(pp.calcPartsOf(custom, plans, false), { text: '8 堂 × NT$1,500', total: 'NT$12,000', note: null });
});
expect('calcPartsOf：沒選好 → null；未填單價 → 只有說明文字，沒有總額與折扣說明', () => {
  assert.equal(pp.calcPartsOf(start, plans, false), null);
  const custom = { choice: 'custom', sessionType: '1on1', customTotal: '8', customUnit: '' };
  assert.deepEqual(pp.calcPartsOf(custom, plans, false), { text: '未填單價 → 建立為「無單價」方案', total: null, note: null });
  assert.deepEqual(pp.calcPartsOf(custom, plans, true), { text: '未填單價 → 建立為「無單價」方案', total: null, note: null });
  assert.equal(pp.calcPartsOf({ ...custom, customTotal: '' }, plans, false), null);
});
console.log('[package-plan-picker test] done');
