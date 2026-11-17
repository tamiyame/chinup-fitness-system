// 價目表編輯的純邏輯（public/package-plan-table.js，不需要瀏覽器）。
import assert from 'node:assert/strict';
const pt = await import('../public/package-plan-table.js');

function expect(label, fn) { try { fn(); console.log(`  ✓ ${label}`); } catch (e) { console.log(`  ✗ ${label}`); console.error(e); process.exitCode = 1; } }
console.log('[package-plan-table test] start');

const plans = [
  { sessionType: '1on1', totalSessions: 10, unitPrice: 1400 },
  { sessionType: '1on2', totalSessions: 10, unitPrice: 1900 },
  { sessionType: '1on1', totalSessions: 30, unitPrice: 1200 },
];

expect('parseAmount：空白 → null；千分位、前後空白、全形數字都認', () => {
  assert.equal(pt.parseAmount(''), null);
  assert.equal(pt.parseAmount('   '), null);
  assert.equal(pt.parseAmount('1,400'), 1400);
  assert.equal(pt.parseAmount(' 1400 '), 1400);
  assert.equal(pt.parseAmount('１４００'), 1400);
  assert.equal(pt.parseAmount('0'), 0);
  assert.equal(pt.parseAmount('１，４００'), 1400);   // 全形逗號（中文輸入法）
  assert.equal(pt.parseAmount('1，400'), 1400);
});
expect('parseAmount：小數、負號、文字 → NaN', () => {
  for (const t of ['14.5', '-5', 'abc', '1e3', '１４００元']) assert.ok(Number.isNaN(pt.parseAmount(t)), t);
});
expect('rowsFromPlans：一列一種堂數、小到大、價格帶千分位、沒有的組合留空', () => {
  assert.deepEqual(pt.rowsFromPlans(plans), [
    { total: 10, isNew: false, p1on1: '1,400', p1on2: '1,900' },
    { total: 30, isNew: false, p1on1: '1,200', p1on2: '' },
  ]);
  assert.deepEqual(pt.rowsFromPlans([]), []);
});
expect('plansFromRows：來回一致', () => {
  assert.deepEqual(pt.plansFromRows(pt.rowsFromPlans(plans)), { ok: true, plans: [plans[0], plans[1], plans[2]] });
});
expect('清空一格 → 那個組合不在結果裡；清空一整列 → 那個堂數不在結果裡', () => {
  const rows = pt.rowsFromPlans(plans);
  rows[0].p1on2 = '';
  rows[1].p1on1 = '';
  assert.deepEqual(pt.plansFromRows(rows), { ok: true, plans: [plans[0]] });
});
expect('新增一列：填了堂數與價格 → 併入並排序', () => {
  const rows = [...pt.rowsFromPlans(plans), { total: ' 20 ', isNew: true, p1on1: '1300', p1on2: '' }];
  assert.deepEqual(pt.plansFromRows(rows).plans.map((p) => `${p.sessionType}:${p.totalSessions}:${p.unitPrice}`),
    ['1on1:10:1400', '1on2:10:1900', '1on1:20:1300', '1on1:30:1200']);
});
expect('新增的列全空白 → 略過；只填堂數沒填價格 → 沒有組合', () => {
  const rows = [...pt.rowsFromPlans(plans), { total: '', isNew: true, p1on1: '', p1on2: '' }, { total: '50', isNew: true, p1on1: '', p1on2: '' }];
  assert.deepEqual(pt.plansFromRows(rows), { ok: true, plans });
});
expect('新增的列有價格沒堂數 → 請先填堂數', () => {
  const rows = [...pt.rowsFromPlans(plans), { total: '', isNew: true, p1on1: '1300', p1on2: '' }];
  assert.deepEqual(pt.plansFromRows(rows), { ok: false, rowIndex: 2, field: 'total', message: '請先填堂數' });
});
expect('堂數不合格', () => {
  for (const t of ['0', '201', '1.5', 'abc']) {
    const rows = [{ total: t, isNew: true, p1on1: '1300', p1on2: '' }];
    assert.deepEqual(pt.plansFromRows(rows), { ok: false, rowIndex: 0, field: 'total', message: '堂數要填 1–200 的整數' });
  }
});
expect('堂數重複 → 指到後面那一列', () => {
  const rows = [...pt.rowsFromPlans(plans), { total: '10', isNew: true, p1on1: '', p1on2: '' }];
  assert.deepEqual(pt.plansFromRows(rows), { ok: false, rowIndex: 2, field: 'total', message: '這個堂數已經有了' });
});
expect('價格不合格 → 指到那一格', () => {
  const rows = pt.rowsFromPlans(plans);
  rows[1].p1on2 = '0';
  assert.deepEqual(pt.plansFromRows(rows), { ok: false, rowIndex: 1, field: '1on2', message: '每堂單價要填 1–1,000,000 的整數' });
  rows[1].p1on2 = '';
  rows[0].p1on1 = '1000001';
  assert.deepEqual(pt.plansFromRows(rows), { ok: false, rowIndex: 0, field: '1on1', message: '每堂單價要填 1–1,000,000 的整數' });
  rows[0].p1on1 = '一千';
  assert.equal(pt.plansFromRows(rows).field, '1on1');
});
expect('邊界值可以：堂數 1 與 200、單價 1 與 1,000,000', () => {
  const rows = [{ total: '1', isNew: true, p1on1: '1', p1on2: '' }, { total: '200', isNew: true, p1on1: '', p1on2: '1,000,000' }];
  assert.deepEqual(pt.plansFromRows(rows).plans, [
    { sessionType: '1on1', totalSessions: 1, unitPrice: 1 }, { sessionType: '1on2', totalSessions: 200, unitPrice: 1000000 }]);
});
expect('超過 60 個組合 → 最多 60 個組合', () => {
  const rows = Array.from({ length: 31 }, (_, i) => ({ total: String(i + 1), isNew: true, p1on1: '1000', p1on2: '1000' }));
  assert.deepEqual(pt.plansFromRows(rows), { ok: false, rowIndex: -1, field: 'total', message: '最多 60 個組合' });
});
expect('priceNote：留空 → 不提供；有效價格 → 共 NT$；讀不懂的值 → 空字串', () => {
  assert.equal(pt.priceNote('', 10), '不提供');
  assert.equal(pt.priceNote('   ', 10), '不提供');
  assert.equal(pt.priceNote('1,400', 10), '共 NT$14,000');
  assert.equal(pt.priceNote('１，４００', '10'), '共 NT$14,000');
  for (const t of ['abc', '0', '1400元', '14.5', '1000001']) assert.equal(pt.priceNote(t, 10), '', t);
  assert.equal(pt.priceNote('1400', ''), '');      // 堂數還沒填
  assert.equal(pt.priceNote('1400', 'x'), '');
  assert.equal(pt.priceNote('', ''), '不提供');
});
console.log('[package-plan-table test] done');
