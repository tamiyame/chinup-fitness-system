// API：套裝方案（一列一個套裝）的讀取／新增／修改／刪除＋開方案帶 planId。
// 需 running server + seed admin。套裝是共用資料：本檔只用堂數 173／174 的套裝，開頭與結尾都清掉。
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
  DELETE FROM package_plans WHERE total_sessions IN (173, 174);
  DELETE FROM customer_packages WHERE member_id IN (SELECT id FROM users WHERE email LIKE 'ppapi-%');
  DELETE FROM auth_sessions WHERE user_id IN (SELECT id FROM users WHERE email LIKE 'ppapi-%');
  DELETE FROM coaches WHERE user_id IN (SELECT id FROM users WHERE email LIKE 'ppapi-%');
  DELETE FROM users WHERE email LIKE 'ppapi-%';
`);
clean();
const mine = (plans) => plans.filter((p) => p.totalSessions === 173 || p.totalSessions === 174);

for (const [method, path] of [
  ['GET', '/api/coach/package-plans'], ['GET', '/api/admin/package-plans'], ['POST', '/api/admin/package-plans'],
  ['PATCH', '/api/admin/package-plans/1'], ['DELETE', '/api/admin/package-plans/1'],
]) {
  const r = await req(method, path, { body: method === 'GET' || method === 'DELETE' ? undefined : {} });
  expect(`未登入 ${method} ${path} → 401`, () => assert.equal(r.status, 401));
}

const login = await req('POST', '/api/auth/login', { body: { email: 'admin@chinup.local', password: 'admin1234' } });
const token = login.data?.token;
expect('admin 登入取得 token', () => assert.ok(token));

// 非管理者教練
const coU = Number(db.prepare("INSERT INTO users (name,email,role,is_admin) VALUES ('方案API純教練','ppapi-coach@x.com','coach',0)").run().lastInsertRowid);
const coTok = 'ppapi-coachtok-' + coU;
db.prepare("INSERT OR REPLACE INTO auth_sessions (token, user_id, expires_at) VALUES (?, ?, '2099-01-01T00:00:00')").run(coTok, coU);

for (const [method, path] of [
  ['GET', '/api/admin/package-plans'], ['POST', '/api/admin/package-plans'],
  ['PATCH', '/api/admin/package-plans/1'], ['DELETE', '/api/admin/package-plans/1'],
]) {
  const r = await req(method, path, { token: coTok, body: method === 'GET' || method === 'DELETE' ? undefined : { sessionType: '1on1', totalSessions: 173, unitPrice: 1400 } });
  expect(`非管理者教練 ${method} ${path} → 403 admin_only`, () => {
    assert.equal(r.status, 403);
    assert.equal(r.data.error, 'admin_only');
  });
}
const oldPut = await req('PUT', '/api/admin/package-plans', { token, body: { version: '0', plans: [] } });
expect('整張取代的舊端點（PUT）已經拿掉 → 404', () => assert.equal(oldPut.status, 404));

// 管理者新增：同類型同堂數兩個價
const full = await req('POST', '/api/admin/package-plans', { token, body: { sessionType: '1on1', totalSessions: 173, unitPrice: 1400 } });
expect('管理者新增 → 201 回完整的套裝（預設啟用、名稱 null）', () => {
  assert.equal(full.status, 201);
  assert.deepEqual(full.data, { id: full.data.id, sessionType: '1on1', totalSessions: 173, unitPrice: 1400, name: null, isActive: true });
});
const oldie = await req('POST', '/api/admin/package-plans', { token, body: { sessionType: '1on1', totalSessions: 173, unitPrice: 1300, name: ' 舊生價 ' } });
expect('同類型同堂數再新增一個價（帶名稱）→ 201，名稱去空白', () => {
  assert.equal(oldie.status, 201);
  assert.equal(oldie.data.name, '舊生價');
});
const dup = await req('POST', '/api/admin/package-plans', { token, body: { sessionType: '1on1', totalSessions: 173, unitPrice: 1300, name: '舊生價' } });
expect('四項完全相同 → 409 duplicate_plan', () => {
  assert.equal(dup.status, 409);
  assert.equal(dup.data.error, 'duplicate_plan');
});
const badPrice = await req('POST', '/api/admin/package-plans', { token, body: { sessionType: '1on1', totalSessions: 173, unitPrice: 0 } });
const strPrice = await req('POST', '/api/admin/package-plans', { token, body: { sessionType: '1on1', totalSessions: 173, unitPrice: '1500' } });
const noBody = await req('POST', '/api/admin/package-plans', { token });
expect('單價 0、單價是字串 → 400 invalid_unit_price；不帶內文 → 400 invalid_session_type', () => {
  assert.equal(badPrice.status, 400);
  assert.equal(badPrice.data.error, 'invalid_unit_price');
  assert.equal(strPrice.status, 400);
  assert.equal(strPrice.data.error, 'invalid_unit_price');
  assert.equal(noBody.status, 400);
  assert.equal(noBody.data.error, 'invalid_session_type');
});

const adminList = await req('GET', '/api/admin/package-plans', { token });
const coachList = await req('GET', '/api/coach/package-plans', { token: coTok });
expect('兩個 GET 都回 { plans }；同堂數價格高的在前', () => {
  assert.equal(adminList.status, 200);
  assert.equal(coachList.status, 200);
  assert.deepEqual(mine(adminList.data.plans), [full.data, oldie.data]);
  assert.deepEqual(mine(coachList.data.plans), [full.data, oldie.data]);
});

// 修改與停用
const patched = await req('PATCH', `/api/admin/package-plans/${oldie.data.id}`, { token, body: { unitPrice: 1250 } });
expect('PATCH 只改單價 → 200，其他欄位不動', () => {
  assert.equal(patched.status, 200);
  assert.deepEqual(patched.data, { ...oldie.data, unitPrice: 1250 });
});
const off = await req('PATCH', `/api/admin/package-plans/${oldie.data.id}`, { token, body: { isActive: false } });
const adminList2 = await req('GET', '/api/admin/package-plans', { token });
const coachList2 = await req('GET', '/api/coach/package-plans', { token: coTok });
expect('停用後：管理者清單還看得到（isActive false），教練的選單沒有它', () => {
  assert.equal(off.status, 200);
  assert.equal(off.data.isActive, false);
  assert.deepEqual(mine(adminList2.data.plans).map((p) => [p.id, p.isActive]), [[full.data.id, true], [oldie.data.id, false]]);
  assert.deepEqual(mine(coachList2.data.plans).map((p) => p.id), [full.data.id]);
});
const patchBad = await req('PATCH', `/api/admin/package-plans/${oldie.data.id}`, { token, body: { isActive: 'no' } });
const patch404 = await req('PATCH', '/api/admin/package-plans/99999999', { token, body: { unitPrice: 1 } });
const patchNaN = await req('PATCH', '/api/admin/package-plans/abc', { token, body: { unitPrice: 1 } });
const patchDup = await req('PATCH', `/api/admin/package-plans/${oldie.data.id}`, { token, body: { unitPrice: 1400, name: '' } });
expect('PATCH：isActive 不是布林 → 400；找不到或 id 不是數字 → 404 plan_not_found；改成和別筆相同 → 409', () => {
  assert.equal(patchBad.status, 400);
  assert.equal(patchBad.data.error, 'invalid_active');
  assert.equal(patch404.status, 404);
  assert.equal(patch404.data.error, 'plan_not_found');
  assert.equal(patchNaN.status, 404);
  assert.equal(patchNaN.data.error, 'plan_not_found');
  assert.equal(patchDup.status, 409);
  assert.equal(patchDup.data.error, 'duplicate_plan');
});
await req('PATCH', `/api/admin/package-plans/${oldie.data.id}`, { token, body: { isActive: true } });

// 開方案帶 planId
const mid = Number(db.prepare("INSERT INTO users (name,email,phone,role) VALUES ('方案API客','ppapi-m@x.com','0994100001','user')").run().lastInsertRowid);
const fromPlanOf = (id) => db.prepare('SELECT from_plan, amount FROM customer_packages WHERE id=?').get(id);
const open = (tok, extra) => req('POST', '/api/coach/packages', { token: tok, body: { memberId: mid, sessionType: '1on1', totalSessions: 173, ...extra } });

const ok = await open(token, { planId: full.data.id, fromPlan: true, amount: 1400 * 173 });
expect('planId 價格相符 → 201、from_plan=1', () => {
  assert.equal(ok.status, 201);
  assert.deepEqual({ ...fromPlanOf(ok.data.id) }, { from_plan: 1, amount: 1400 * 173 });
});
const okOld = await open(coTok, { planId: oldie.data.id, fromPlan: true, amount: 1250 * 173 });
expect('非管理者教練用同堂數的另一個價（舊生價）開方案 → 201、金額是舊生價', () => {
  assert.equal(okOld.status, 201);
  assert.deepEqual({ ...fromPlanOf(okOld.data.id) }, { from_plan: 1, amount: 1250 * 173 });
});
const wrongPrice = await open(token, { planId: full.data.id, fromPlan: true, amount: 1250 * 173 });
expect('planId 配上另一個套裝的金額 → 409 plan_price_changed', () => {
  assert.equal(wrongPrice.status, 409);
  assert.equal(wrongPrice.data.error, 'plan_price_changed');
});
const strId = await open(token, { planId: String(full.data.id), fromPlan: true, amount: 1400 * 173 });
expect('planId 是字串 → 400 invalid_plan_id', () => {
  assert.equal(strId.status, 400);
  assert.equal(strId.data.error, 'invalid_plan_id');
});
const legacyTwo = await open(token, { fromPlan: true, amount: 1400 * 173 });
expect('舊畫面（只送 fromPlan:true）：同堂數有兩種啟用中的價 → 409 plan_price_changed', () => {
  assert.equal(legacyTwo.status, 409);
  assert.equal(legacyTwo.data.error, 'plan_price_changed');
});
await req('PATCH', `/api/admin/package-plans/${oldie.data.id}`, { token, body: { isActive: false } });
const offPlan = await open(token, { planId: oldie.data.id, fromPlan: true, amount: 1250 * 173 });
expect('套裝停用後再用它開 → 409 plan_not_available', () => {
  assert.equal(offPlan.status, 409);
  assert.equal(offPlan.data.error, 'plan_not_available');
});
const legacyOk = await open(token, { fromPlan: true, amount: 1400 * 173 });
const legacyBad = await open(token, { fromPlan: true, amount: 1250 * 173 });
const legacyNone = await open(token, { fromPlan: true, totalSessions: 174, amount: 1400 * 174 });
expect('舊畫面（只送 fromPlan:true）：同堂數只剩一種價且金額相符 → 201；對不上 → 409 plan_price_changed；沒有該堂數 → 409 plan_not_available', () => {
  assert.equal(legacyOk.status, 201);
  assert.equal(fromPlanOf(legacyOk.data.id).from_plan, 1);
  assert.equal(legacyBad.status, 409);
  assert.equal(legacyBad.data.error, 'plan_price_changed');
  assert.equal(legacyNone.status, 409);
  assert.equal(legacyNone.data.error, 'plan_not_available');
});
const custom = await open(token, { fromPlan: false, totalSessions: 8, amount: 12000 });
expect('fromPlan false → 201、from_plan=0', () => {
  assert.equal(custom.status, 201);
  assert.equal(fromPlanOf(custom.data.id).from_plan, 0);
});
const plain = await open(token, { totalSessions: 8, amount: 12000 });
expect('不帶 fromPlan／planId → 201、from_plan=null', () => {
  assert.equal(plain.status, 201);
  assert.equal(fromPlanOf(plain.data.id).from_plan, null);
});

// 刪除
const del = await req('DELETE', `/api/admin/package-plans/${full.data.id}`, { token });
const delAgain = await req('DELETE', `/api/admin/package-plans/${full.data.id}`, { token });
const adminList3 = await req('GET', '/api/admin/package-plans', { token });
expect('DELETE → 200 { ok: true }；再刪一次 → 404；清單裡沒有它；已開出的方案還在', () => {
  assert.equal(del.status, 200);
  assert.deepEqual(del.data, { ok: true });
  assert.equal(delAgain.status, 404);
  assert.equal(delAgain.data.error, 'plan_not_found');
  assert.deepEqual(mine(adminList3.data.plans).map((p) => p.id), [oldie.data.id]);
  assert.equal(fromPlanOf(ok.data.id).amount, 1400 * 173);
});

clean();
console.log('[package-plan-api] done');
