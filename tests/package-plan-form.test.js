// 後台「方案」頁籤的純邏輯（public/package-plan-form.js，不需要瀏覽器）：側欄表單解析、清單分組與摘要。
import assert from 'node:assert/strict';
const pf = await import('../public/package-plan-form.js');

function expect(label, fn) { try { fn(); console.log(`  ✓ ${label}`); } catch (e) { console.log(`  ✗ ${label}`); console.error(e); process.exitCode = 1; } }
console.log('[package-plan-form test] start');

const plans = [
  { id: 1, sessionType: '1on1', totalSessions: 1, unitPrice: 1500, name: null, isActive: true },
  { id: 2, sessionType: '1on1', totalSessions: 10, unitPrice: 1400, name: null, isActive: true },
  { id: 3, sessionType: '1on1', totalSessions: 10, unitPrice: 1300, name: '舊生價', isActive: false },
  { id: 4, sessionType: '1on2', totalSessions: 10, unitPrice: 1900, name: null, isActive: true },
];
const good = { sessionType: '1on1', total: '10', unit: '1,300', name: ' 舊生價 ', isActive: true };

expect('formFromPlan：新增 → 一對一、全空、啟用', () => {
  assert.deepEqual(pf.formFromPlan(null), { sessionType: '1on1', total: '', unit: '', name: '', isActive: true });
});
expect('formFromPlan：編輯 → 帶入原值，單價有千分位、沒有名稱是空字串', () => {
  assert.deepEqual(pf.formFromPlan(plans[2]), { sessionType: '1on1', total: '10', unit: '1,300', name: '舊生價', isActive: false });
  assert.equal(pf.formFromPlan(plans[3]).name, '');
  assert.equal(pf.formFromPlan(plans[3]).sessionType, '1on2');
});
expect('planFromForm：有效 → 數字與去空白的名稱', () => {
  assert.deepEqual(pf.planFromForm(good), { ok: true, plan: { sessionType: '1on1', totalSessions: 10, unitPrice: 1300, name: '舊生價', isActive: true } });
});
expect('planFromForm：名稱空白 → null；全形數字也認', () => {
  const r = pf.planFromForm({ ...good, total: '１０', unit: '１，４００', name: '   ', isActive: false });
  assert.deepEqual(r.plan, { sessionType: '1on1', totalSessions: 10, unitPrice: 1400, name: null, isActive: false });
});
expect('planFromForm：堂數不合格 → 指到堂數欄', () => {
  for (const t of ['', '0', '201', '1.5', 'abc', '-3']) {
    assert.deepEqual(pf.planFromForm({ ...good, total: t }), { ok: false, field: 'total', message: '堂數要填 1–200 的整數' });
  }
});
expect('planFromForm：單價不合格 → 指到單價欄（套裝一定要有單價）', () => {
  for (const u of ['', '0', '1000001', '99.5', 'abc']) {
    assert.deepEqual(pf.planFromForm({ ...good, unit: u }), { ok: false, field: 'unit', message: '每堂單價要填 1–1,000,000 的整數' });
  }
});
expect('planFromForm：名稱超過 20 個字 → 指到名稱欄；剛好 20 個字可以', () => {
  const twenty = '一二三四五六七八九十一二三四五六七八九十';
  assert.equal(pf.planFromForm({ ...good, name: twenty }).ok, true);
  assert.deepEqual(pf.planFromForm({ ...good, name: twenty + '一' }), { ok: false, field: 'name', message: '名稱最多 20 個字' });
});
expect('planFromForm：先檢查堂數、再單價、再名稱', () => {
  assert.equal(pf.planFromForm({ ...good, total: '', unit: '', name: 'x'.repeat(30) }).field, 'total');
  assert.equal(pf.planFromForm({ ...good, unit: '', name: 'x'.repeat(30) }).field, 'unit');
});
expect('formCalcText：堂數與單價都有效才有試算', () => {
  assert.equal(pf.formCalcText(good), '10 堂 × NT$1,300 ＝ 總價 NT$13,000');
  assert.equal(pf.formCalcText({ ...good, unit: '' }), '');
  assert.equal(pf.formCalcText({ ...good, total: 'abc' }), '');
  assert.equal(pf.formCalcText({ ...good, total: '0' }), '');
});
expect('summaryText：總數與啟用中的數量', () => {
  assert.equal(pf.summaryText(plans), '共 4 個・啟用中 3 個');
  assert.equal(pf.summaryText([]), '');
});
expect('groupPlans：依類型分組、保持原順序；沒有的類型不出現', () => {
  const g = pf.groupPlans(plans);
  assert.deepEqual(g.map((x) => [x.sessionType, x.label, x.plans.map((p) => p.id)]), [['1on1', '一對一', [1, 2, 3]], ['1on2', '一對二', [4]]]);
  assert.deepEqual(pf.groupPlans([plans[3]]).map((x) => x.label), ['一對二']);
  assert.deepEqual(pf.groupPlans([]), []);
});
expect('planRowParts：清單一列要顯示的字', () => {
  assert.deepEqual(pf.planRowParts(plans[2]), {
    title: '一對一 10 堂', name: '舊生價', status: '已停用', formula: '10 堂 × NT$1,300',
    unit: 'NT$1,300', total: 'NT$13,000', toggleLabel: '啟用',
  });
  const on = pf.planRowParts(plans[0]);
  assert.equal(on.name, null);
  assert.equal(on.status, '啟用中');
  assert.equal(on.toggleLabel, '停用');
  assert.equal(on.total, 'NT$1,500');
});
expect('planErrorMessage：伺服器錯誤碼 → 給人看的話；不認得的回 null', () => {
  assert.equal(pf.planErrorMessage('duplicate_plan'), '已經有類型、堂數、單價、名稱都一樣的套裝');
  assert.equal(pf.planErrorMessage('too_many_plans'), '套裝最多 100 個，請先刪掉用不到的');
  assert.equal(pf.planErrorMessage('plan_not_found'), '這個套裝已經被刪除');
  assert.equal(pf.planErrorMessage('whatever'), null);
  assert.equal(pf.planErrorMessage(undefined), null);
});
console.log('[package-plan-form test] done');
