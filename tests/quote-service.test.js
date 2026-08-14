// 報價單 service：驗證/金額/單號/建立/查詢（後半：編輯/作廢/成交/公開過濾在同檔尾端）。
import assert from 'node:assert/strict';
const { db } = await import('../src/db/connection.js');
const { validateQuoteInput, nextQuoteNoFor, createQuote, listQuotes, getQuoteAdmin,
  updateQuote, voidQuote, setDealStatus, getQuoteByToken } = await import('../src/services/quoteService.js');
const { getSetting, setSetting } = await import('../src/services/discountService.js');

function expect(label, fn){ try{fn();console.log(`  ✓ ${label}`);}catch(e){console.log(`  ✗ ${label}`);console.error(e);process.exitCode=1;} }
console.log('[quote-service test] start');

// ── 清理本測試資料（customer_title 前綴鎖範圍；quote_items 由 FK CASCADE 帶走）──
db.exec("DELETE FROM quotes WHERE customer_title LIKE 'QT測試%'");
db.exec("DELETE FROM quotes WHERE customer_title LIKE 'QT-API測試%'");   // quote-api 測試殘留單（每跑留 1 張作廢單），同顆 DB 順手清
db.exec("DELETE FROM quotes WHERE quote_no LIKE 'CU2031-%'");   // 跨年重計測試用年份

// 動態日期：base() 用「今天／今天+30 天」，避免固定日期隨時間推移使全鏈斷言變假。
const _pad = (n) => String(n).padStart(2, '0');
const _now = new Date();
const TODAY = `${_now.getFullYear()}-${_pad(_now.getMonth() + 1)}-${_pad(_now.getDate())}`;
const _p30 = new Date(_now.getTime() + 30 * 86400000);
const PLUS30 = `${_p30.getFullYear()}-${_pad(_p30.getMonth() + 1)}-${_pad(_p30.getDate())}`;

const base = () => ({
  customer_title: 'QT測試股份有限公司',
  customer_tax_id: '12345678',
  contact_name: '王小明',
  contact_phone: '0912345678',
  quote_date: TODAY,
  valid_until: PLUS30,
  payment_terms: '簽約後 7 日內電匯 50%，課程結束付清尾款',
  delivery_terms: '雙方確認後 14 日內開課',
  notes: '含教材與場地',
  items: [
    { name: '企業體能課程', spec: '10 堂・每堂 60 分', qty: 10, unit: '堂', unit_price: 2000 },
    { name: '健康講座', qty: 1.5, unit: '小時', unit_price: 3000 },
  ],
});

// ── validateQuoteInput ──
expect('缺客戶抬頭 → missing_customer_title', () => {
  assert.throws(() => validateQuoteInput({ ...base(), customer_title: ' ' }), /missing_customer_title/);
});
expect('空品項 → missing_items', () => {
  assert.throws(() => validateQuoteInput({ ...base(), items: [] }), /missing_items/);
});
expect('品名空白 → missing_item_name', () => {
  const b = base(); b.items[0].name = '';
  assert.throws(() => validateQuoteInput(b), /missing_item_name/);
});
expect('qty=0 → invalid_item_qty', () => {
  const b = base(); b.items[0].qty = 0;
  assert.throws(() => validateQuoteInput(b), /invalid_item_qty/);
});
expect('unit_price=-1 → invalid_item_price', () => {
  const b = base(); b.items[0].unit_price = -1;
  assert.throws(() => validateQuoteInput(b), /invalid_item_price/);
});
expect('unit_price=1.5（非整數）→ invalid_item_price', () => {
  const b = base(); b.items[0].unit_price = 1.5;
  assert.throws(() => validateQuoteInput(b), /invalid_item_price/);
});
expect('日期格式錯 → invalid_quote_date', () => {
  assert.throws(() => validateQuoteInput({ ...base(), quote_date: '2026/08/14' }), /invalid_quote_date/);
});
expect('有效期限早於報價日 → valid_until_before_quote_date', () => {
  assert.throws(() => validateQuoteInput({ ...base(), valid_until: '2000-01-01' }), /valid_until_before_quote_date/);
});
expect('金額計算：10×2000＋1.5×3000 → subtotal 24500 / tax 1225 / total 25725', () => {
  const v = validateQuoteInput(base());
  assert.equal(v.items[0].amount, 20000);
  assert.equal(v.items[1].amount, 4500);
  assert.equal(v.subtotal, 24500);
  assert.equal(v.tax, 1225);
  assert.equal(v.total, 25725);
});
expect('小計四捨五入：1.5×999 → 1499', () => {
  const v = validateQuoteInput({ ...base(), items: [{ name: 'x', qty: 1.5, unit_price: 999 }] });
  assert.equal(v.items[0].amount, 1499);
});
expect('0 元贈送列允許', () => {
  const v = validateQuoteInput({ ...base(), items: [{ name: '贈送體驗課', qty: 1, unit_price: 0 }] });
  assert.equal(v.subtotal, 0); assert.equal(v.total, 0);
});
expect('選填欄位空字串 → null', () => {
  const v = validateQuoteInput({ ...base(), customer_tax_id: ' ', notes: '' });
  assert.equal(v.customer_tax_id, null);
  assert.equal(v.notes, null);
});

// ── 單號 ──
expect('nextQuoteNoFor：無該年單 → 0001（跨年重計）', () => {
  assert.equal(nextQuoteNoFor('2031'), 'CU2031-0001');
});

// ── createQuote ──
const q1 = createQuote(base());
expect('createQuote：單號格式 CU\\d{4}-\\d{4}、token 32 hex、items 落庫', () => {
  assert.match(q1.quote_no, /^CU\d{4}-\d{4}$/);
  assert.match(q1.token, /^[0-9a-f]{32}$/);
  assert.equal(q1.items.length, 2);
  assert.equal(q1.items[0].position, 0);
  assert.equal(q1.items[1].position, 1);
  assert.equal(q1.subtotal, 24500); assert.equal(q1.tax, 1225); assert.equal(q1.total, 25725);
  assert.equal(q1.deal_status, null); assert.equal(q1.voided_at, null);
});
const q2 = createQuote(base());
expect('連續建立：流水遞增、token 不重複', () => {
  assert.equal(Number(q2.quote_no.slice(-4)), Number(q1.quote_no.slice(-4)) + 1);
  assert.notEqual(q2.token, q1.token);
});
expect('前端假數字被伺服器重算覆蓋', () => {
  const b = base(); b.subtotal = 1; b.tax = 1; b.total = 1; b.items[0].amount = 1;
  const q = createQuote(b);
  assert.equal(q.subtotal, 24500); assert.equal(q.total, 25725);
});

// ── 查詢 ──
expect('listQuotes：含新單、新在前、不含 items 欄位', () => {
  const rows = listQuotes();
  const mine = rows.filter((r) => r.customer_title.startsWith('QT測試'));
  assert.ok(mine.length >= 3);
  assert.equal(rows[0].items, undefined);
});
expect('getQuoteAdmin：回 items；查無 → not_found', () => {
  const g = getQuoteAdmin(q1.id);
  assert.equal(g.items.length, 2);
  assert.equal(g.items[0].name, '企業體能課程');
  assert.throws(() => getQuoteAdmin(99999999), /not_found/);
});

// ── updateQuote ──
const beforeEdit = getQuoteAdmin(q1.id);
const edited = (() => {
  const b = base();
  b.items = [{ name: '改版課程', spec: '20 堂', qty: 20, unit: '堂', unit_price: 1800 }];
  return updateQuote(q1.id, b);
})();
expect('updateQuote：金額重算、items 整組替換、單號/token 不變', () => {
  assert.equal(edited.subtotal, 36000);
  assert.equal(edited.tax, 1800);
  assert.equal(edited.total, 37800);
  assert.equal(edited.items.length, 1);
  assert.equal(edited.items[0].name, '改版課程');
  assert.equal(edited.quote_no, beforeEdit.quote_no);
  assert.equal(edited.token, beforeEdit.token);
});
expect('updateQuote 查無 → not_found', () => {
  assert.throws(() => updateQuote(99999999, base()), /not_found/);
});

// ── voidQuote ──
const voided = voidQuote(q2.id);
expect('voidQuote：寫 voided_at', () => { assert.ok(voided.voided_at); });
expect('已作廢再作廢 → already_void', () => { assert.throws(() => voidQuote(q2.id), /already_void/); });
expect('已作廢不可編輯 → quote_voided', () => { assert.throws(() => updateQuote(q2.id, base()), /quote_voided/); });
expect('已作廢不可標成交 → quote_voided', () => { assert.throws(() => setDealStatus(q2.id, 'won'), /quote_voided/); });

// ── setDealStatus ──
expect('setDealStatus：won / lost / null 三態', () => {
  assert.equal(setDealStatus(q1.id, 'won').deal_status, 'won');
  assert.equal(setDealStatus(q1.id, 'lost').deal_status, 'lost');
  assert.equal(setDealStatus(q1.id, null).deal_status, null);
});
expect('setDealStatus 非法值 → invalid_deal_status', () => {
  assert.throws(() => setDealStatus(q1.id, 'maybe'), /invalid_deal_status/);
});

// ── getQuoteByToken（公開過濾）──
expect('getQuoteByToken：查得、含 items 與 company、不洩漏內部欄位', () => {
  const pub = getQuoteByToken(edited.token);
  assert.equal(pub.quote_no, edited.quote_no);
  assert.equal(pub.items.length, 1);
  assert.ok(pub.company && typeof pub.company.name === 'string');
  assert.ok(!('id' in pub));
  assert.ok(!('token' in pub));
  assert.ok(!('deal_status' in pub));
  assert.ok(!('id' in pub.items[0]));
  assert.equal(pub.voided, false);
  assert.equal(pub.expired, false);   // valid_until 為 TODAY+30（動態），恆未過期
});
expect('假 token → not_found', () => {
  assert.throws(() => getQuoteByToken('deadbeef'.repeat(4)), /not_found/);
});
expect('過期單：expired=true；作廢單：voided=true 且 expired=false', () => {
  const past = createQuote({ ...base(), quote_date: '2020-01-01', valid_until: '2020-01-02' });
  assert.equal(getQuoteByToken(past.token).expired, true);
  voidQuote(past.id);
  const pub = getQuoteByToken(past.token);
  assert.equal(pub.voided, true);
  assert.equal(pub.expired, false);
});
expect('company 取 app_settings 即時值', () => {
  const orig = getSetting('company_name');
  setSetting('company_name', 'QT測試公司抬頭');
  assert.equal(getQuoteByToken(edited.token).company.name, 'QT測試公司抬頭');
  setSetting('company_name', orig ?? '');
});

console.log('[quote-service test] done');
