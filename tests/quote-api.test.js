// 報價單 API：admin CRUD/void/deal、公開 token 端點、company settings、權限守門。
// 慣例：對跑著的 dev server（BASE）打 fetch；X-Forwarded-For 假 IP 避開共用限流。
import assert from 'node:assert/strict';
const BASE = process.env.BASE || 'http://localhost:3000';
async function req(method, path, { body, token } = {}) {
  const headers = { 'Content-Type': 'application/json', 'X-Forwarded-For': '10.99.7.1' };
  if (token) headers['Authorization'] = `Bearer ${token}`;
  const res = await fetch(BASE + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text(); let data; try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  return { status: res.status, data };
}
function expect(label, fn){ try{fn();console.log(`  ✓ ${label}`);}catch(e){console.log(`  ✗ ${label}`);console.error(e);process.exitCode=1;} }
console.log('[quote-api test] start');

const login = await req('POST', '/api/auth/login', { body: { email: 'admin@chinup.local', password: 'admin1234' } });
const token = login.data?.token;
expect('admin 登入成功', () => assert.ok(token));

const body = {
  customer_title: 'QT-API測試有限公司', customer_tax_id: '87654321',
  quote_date: '2026-08-14', valid_until: '2026-09-13',
  payment_terms: '月結 30 天',
  items: [{ name: '企業包班', spec: '8 週', qty: 8, unit: '週', unit_price: 5000 }],
};

// ── 權限守門 ──
{
  const r = await req('GET', '/api/admin/quotes');
  expect('未登入 GET /api/admin/quotes → 401', () => assert.equal(r.status, 401));
  const r2 = await req('POST', '/api/admin/quotes', { body, token: 'bogus-token' });
  expect('假 token POST → 401', () => assert.equal(r2.status, 401));
}

// ── CRUD ──
const c = await req('POST', '/api/admin/quotes', { body, token });
expect('POST 建立 → 201、單號/token/金額', () => {
  assert.equal(c.status, 201);
  assert.match(c.data.quote_no, /^CU\d{4}-\d{4}$/);
  assert.match(c.data.token, /^[0-9a-f]{32}$/);
  assert.equal(c.data.subtotal, 40000);
  assert.equal(c.data.tax, 2000);
  assert.equal(c.data.total, 42000);
});
const qid = c.data.id, qtoken = c.data.token;

const bad = await req('POST', '/api/admin/quotes', { body: { ...body, customer_title: '' }, token });
expect('缺抬頭 → 400 missing_customer_title', () => {
  assert.equal(bad.status, 400);
  assert.equal(bad.data.error, 'missing_customer_title');
});

const list = await req('GET', '/api/admin/quotes', { token });
expect('GET 列表含新單', () => {
  assert.equal(list.status, 200);
  assert.ok(list.data.some((q) => q.id === qid));
});

const one = await req('GET', `/api/admin/quotes/${qid}`, { token });
expect('GET 單筆含 items', () => {
  assert.equal(one.status, 200);
  assert.equal(one.data.items.length, 1);
});

const put = await req('PUT', `/api/admin/quotes/${qid}`, {
  body: { ...body, items: [{ name: '企業包班', qty: 10, unit: '週', unit_price: 5000 }] }, token });
expect('PUT 更新 → 金額重算', () => {
  assert.equal(put.status, 200);
  assert.equal(put.data.subtotal, 50000);
  assert.equal(put.data.total, 52500);
});

const deal = await req('POST', `/api/admin/quotes/${qid}/deal`, { body: { deal_status: 'won' }, token });
expect('POST deal won → 寫入', () => { assert.equal(deal.status, 200); assert.equal(deal.data.deal_status, 'won'); });
const dealBad = await req('POST', `/api/admin/quotes/${qid}/deal`, { body: { deal_status: 'maybe' }, token });
expect('deal 非法值 → 400', () => assert.equal(dealBad.status, 400));

// ── 公開端點 ──
const pub = await req('GET', `/api/public/quotes/${qtoken}`);
expect('公開端點：200、含 company、不洩漏內部欄位', () => {
  assert.equal(pub.status, 200);
  assert.equal(pub.data.quote_no, c.data.quote_no);
  assert.ok('name' in pub.data.company);
  assert.ok(!('deal_status' in pub.data));
  assert.ok(!('id' in pub.data));
  assert.ok(!('token' in pub.data));
});
const pub404 = await req('GET', '/api/public/quotes/deadbeefdeadbeefdeadbeefdeadbeef');
expect('假 token → 404', () => assert.equal(pub404.status, 404));

// ── 作廢 ──
const v = await req('POST', `/api/admin/quotes/${qid}/void`, { token });
expect('作廢 → voided_at', () => { assert.equal(v.status, 200); assert.ok(v.data.voided_at); });
const putVoided = await req('PUT', `/api/admin/quotes/${qid}`, { body, token });
expect('作廢後 PUT → 409', () => assert.equal(putVoided.status, 409));

// ── company settings ──
const s0 = await req('GET', '/api/admin/settings', { token });
expect('settings 含 company 五鍵', () => {
  assert.equal(s0.status, 200);
  for (const k of ['company_name', 'company_tax_id', 'company_phone', 'company_email', 'company_address']) {
    assert.equal(typeof s0.data[k], 'string');
  }
});
const origTax = s0.data.company_tax_id;
const sp = await req('PATCH', '/api/admin/settings', { body: { company_tax_id: '12345678' }, token });
expect('PATCH company_tax_id 寫入', () => { assert.equal(sp.status, 200); assert.equal(sp.data.company_tax_id, '12345678'); });
await req('PATCH', '/api/admin/settings', { body: { company_tax_id: origTax }, token });  // 還原

console.log('[quote-api test] done');
