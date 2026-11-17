// API：套裝方案價目表（GET /api/coach/package-plans、PUT /api/admin/package-plans）＋開方案 fromPlan。
// 需 running server + seed admin；價目表是單一共用表，結束時存回空陣列。
import assert from 'node:assert/strict';
import { db } from '../src/db/connection.js';

const BASE = process.env.BASE || 'http://localhost:3000';
async function req(method, path, { body, token } = {}) {
  // 獨立假 IP：避免整條 test:api 鏈共用預設 IP 撞 login 限流
  const headers = { 'Content-Type': 'application/json', 'X-Forwarded-For': '10.99.4.4' };
  if (token) headers['Authorization'] = `Bearer ${token}`;
  const res = await fetch(BASE + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  let data; try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  return { status: res.status, data };
}
function expect(label, fn){ try{fn();console.log(`  ✓ ${label}`);}catch(e){console.log(`  ✗ ${label}`);console.error(e);process.exitCode=1;} }

console.log('[package-plan-api] start');
const clean = () => db.exec(`
  DELETE FROM customer_packages WHERE member_id IN (SELECT id FROM users WHERE email LIKE 'ppapi-%');
  DELETE FROM auth_sessions WHERE user_id IN (SELECT id FROM users WHERE email LIKE 'ppapi-%');
  DELETE FROM coaches WHERE user_id IN (SELECT id FROM users WHERE email LIKE 'ppapi-%');
  DELETE FROM users WHERE email LIKE 'ppapi-%';
`);
clean();

const noGet = await req('GET', '/api/coach/package-plans');
expect('未登入 GET → 401', () => assert.equal(noGet.status, 401));
const noPut = await req('PUT', '/api/admin/package-plans', { body: { version: '0', plans: [] } });
expect('未登入 PUT → 401', () => assert.equal(noPut.status, 401));

const login = await req('POST', '/api/auth/login', { body: { email: 'admin@chinup.local', password: 'admin1234' } });
const token = login.data?.token;
expect('admin 登入取得 token', () => assert.ok(token));

// 非管理者教練
const coU = Number(db.prepare("INSERT INTO users (name,email,role,is_admin) VALUES ('方案API純教練','ppapi-coach@x.com','coach',0)").run().lastInsertRowid);
const coTok = 'ppapi-coachtok-' + coU;
db.prepare("INSERT OR REPLACE INTO auth_sessions (token, user_id, expires_at) VALUES (?, ?, '2099-01-01T00:00:00')").run(coTok, coU);

const coGet = await req('GET', '/api/coach/package-plans', { token: coTok });
expect('非管理者教練 GET → 200 且回 { version, plans }', () => {
  assert.equal(coGet.status, 200);
  assert.equal(typeof coGet.data.version, 'string');
  assert.ok(Array.isArray(coGet.data.plans));
});
const coPut = await req('PUT', '/api/admin/package-plans', { token: coTok, body: { version: coGet.data.version, plans: [] } });
expect('非管理者教練 PUT → 403 admin_only', () => {
  assert.equal(coPut.status, 403);
  assert.equal(coPut.data.error, 'admin_only');
});

// 管理者存價目表
const start = await req('GET', '/api/coach/package-plans', { token });
const v0 = start.data.version;
const plans = [
  { sessionType: '1on1', totalSessions: 10, unitPrice: 1400 },
  { sessionType: '1on2', totalSessions: 10, unitPrice: 1900 },
];
const put1 = await req('PUT', '/api/admin/package-plans', { token, body: { version: v0, plans } });
expect('管理者 PUT → 200 回 { version, plans }', () => {
  assert.equal(put1.status, 200);
  assert.equal(put1.data.plans.length, 2);
});
const get1 = await req('GET', '/api/coach/package-plans', { token });
expect('接著 GET 與 PUT 回傳相同（版本與 plans）', () => {
  assert.equal(get1.status, 200);
  assert.deepEqual(get1.data, put1.data);
});

const stale = await req('PUT', '/api/admin/package-plans', { token, body: { version: v0, plans: [] } });
const get2 = await req('GET', '/api/coach/package-plans', { token });
expect('舊版本 PUT → 409 plans_changed，內容不變', () => {
  assert.equal(stale.status, 409);
  assert.equal(stale.data.error, 'plans_changed');
  assert.deepEqual(get2.data, get1.data);
});

const noBody = await req('PUT', '/api/admin/package-plans', { token });
expect('PUT 不帶內文 → 409 plans_changed', () => {
  assert.equal(noBody.status, 409);
  assert.equal(noBody.data.error, 'plans_changed');
});

const badPrice = await req('PUT', '/api/admin/package-plans', {
  token, body: { version: get1.data.version, plans: [{ sessionType: '1on1', totalSessions: 10, unitPrice: 0 }] },
});
const get3 = await req('GET', '/api/coach/package-plans', { token });
expect('單價 0 → 400 invalid_unit_price，內容不變', () => {
  assert.equal(badPrice.status, 400);
  assert.equal(badPrice.data.error, 'invalid_unit_price');
  assert.deepEqual(get3.data, get1.data);
});

// 開方案 fromPlan
const mid = Number(db.prepare("INSERT INTO users (name,email,phone,role) VALUES ('方案API客','ppapi-m@x.com','0994100001','user')").run().lastInsertRowid);
const fromPlanOf = (id) => db.prepare('SELECT from_plan, amount FROM customer_packages WHERE id=?').get(id);

const ok = await req('POST', '/api/coach/packages', { token, body: { memberId: mid, fromPlan: true, sessionType: '1on1', totalSessions: 10, amount: 14000 } });
expect('fromPlan true 價格相符 → 201、from_plan=1、amount=14000', () => {
  assert.equal(ok.status, 201);
  const r = fromPlanOf(ok.data.id);
  assert.equal(r.from_plan, 1);
  assert.equal(r.amount, 14000);
});
const wrongPrice = await req('POST', '/api/coach/packages', { token, body: { memberId: mid, fromPlan: true, sessionType: '1on1', totalSessions: 10, amount: 15000 } });
expect('fromPlan true 金額不符 → 409 plan_price_changed', () => {
  assert.equal(wrongPrice.status, 409);
  assert.equal(wrongPrice.data.error, 'plan_price_changed');
});
const noPlan = await req('POST', '/api/coach/packages', { token, body: { memberId: mid, fromPlan: true, sessionType: '1on1', totalSessions: 20, amount: 28000 } });
expect('fromPlan true 無此套裝 → 409 plan_not_available', () => {
  assert.equal(noPlan.status, 409);
  assert.equal(noPlan.data.error, 'plan_not_available');
});
const custom = await req('POST', '/api/coach/packages', { token, body: { memberId: mid, fromPlan: false, totalSessions: 8, amount: 12000 } });
expect('fromPlan false → 201、from_plan=0', () => {
  assert.equal(custom.status, 201);
  assert.equal(fromPlanOf(custom.data.id).from_plan, 0);
});
const legacy = await req('POST', '/api/coach/packages', { token, body: { memberId: mid, totalSessions: 8, amount: 12000 } });
expect('不帶 fromPlan → 201、from_plan=null', () => {
  assert.equal(legacy.status, 201);
  assert.equal(fromPlanOf(legacy.data.id).from_plan, null);
});
const coPkg = await req('POST', '/api/coach/packages', { token: coTok, body: { memberId: mid, fromPlan: true, sessionType: '1on1', totalSessions: 10, amount: 14000 } });
expect('非管理者教練照價目表開方案 → 201', () => assert.equal(coPkg.status, 201));

// 還原：價目表清空、清掉測試資料
const last = await req('GET', '/api/coach/package-plans', { token });
const reset = await req('PUT', '/api/admin/package-plans', { token, body: { version: last.data.version, plans: [] } });
expect('價目表還原為空', () => {
  assert.equal(reset.status, 200);
  assert.deepEqual(reset.data.plans, []);
});
clean();
console.log('[package-plan-api] done');
