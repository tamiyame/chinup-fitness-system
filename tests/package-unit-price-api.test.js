// API：PATCH /api/coach/packages/:id/unit-price（需 running server + seed admin）＋薪資整合抽查。
import assert from 'node:assert/strict';
import { db } from '../src/db/connection.js';

const BASE = process.env.BASE || 'http://localhost:3000';
async function req(method, path, { body, token } = {}) {
  // 獨立假 IP：避免整條 test:api 鏈共用預設 IP 撞 login 限流（比照 payroll-api.test.js 慣例）
  const headers = { 'Content-Type': 'application/json', 'X-Forwarded-For': '10.99.2.3' };
  if (token) headers['Authorization'] = `Bearer ${token}`;
  const res = await fetch(BASE + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  let data; try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  return { status: res.status, data };
}
function expect(label, fn){ try{fn();console.log(`  ✓ ${label}`);}catch(e){console.log(`  ✗ ${label}`);console.error(e);process.exitCode=1;} }

console.log('[package-unit-price-api] start');
const clean = () => db.exec(`
  DELETE FROM bookings WHERE member_id IN (SELECT id FROM users WHERE email LIKE 'upapi-%') OR coach_id IN (SELECT id FROM coaches WHERE user_id IN (SELECT id FROM users WHERE email LIKE 'upapi-%'));
  DELETE FROM customer_packages WHERE member_id IN (SELECT id FROM users WHERE email LIKE 'upapi-%');
  DELETE FROM auth_sessions WHERE user_id IN (SELECT id FROM users WHERE email LIKE 'upapi-%');
  DELETE FROM coaches WHERE user_id IN (SELECT id FROM users WHERE email LIKE 'upapi-%');
  DELETE FROM users WHERE email LIKE 'upapi-%';
`);
clean();

const noTok = await req('PATCH', '/api/coach/packages/1/unit-price', { body: { unitPrice: 100 } });
expect('未登入 → 401', () => assert.equal(noTok.status, 401));

const login = await req('POST', '/api/auth/login', { body: { email: 'admin@chinup.local', password: 'admin1234' } });
const token = login.data?.token;
expect('admin 登入取得 token', () => assert.ok(token));

const missing = await req('PATCH', '/api/coach/packages/999999/unit-price', { token, body: {} });
expect('缺 unitPrice → 400 missing_unit_price', () => {
  assert.equal(missing.status, 400);
  assert.equal(missing.data.error, 'missing_unit_price');
});

const bad = await req('PATCH', '/api/coach/packages/999999/unit-price', { token, body: { unitPrice: -1 } });
expect('壞值 → 400 invalid_unit_price', () => {
  assert.equal(bad.status, 400);
  assert.equal(bad.data.error, 'invalid_unit_price');
});

// 非 admin 教練 → 403（requireAdmin 守門；比照同路由家族 archive/restore 的既有測試慣例）
const coU = Number(db.prepare("INSERT INTO users (name,email,role,is_admin) VALUES ('upapi純教練','upapi-coachonly@x.com','coach',0)").run().lastInsertRowid);
const coTok = 'upapi-coachtok-' + coU;
db.prepare("INSERT OR REPLACE INTO auth_sessions (token, user_id, expires_at) VALUES (?, ?, '2099-01-01T00:00:00')").run(coTok, coU);
const nonAdmin = await req('PATCH', '/api/coach/packages/999999/unit-price', { token: coTok, body: { unitPrice: 100 } });
expect('非 admin 教練 → 403 admin_only', () => {
  assert.equal(nonAdmin.status, 403);
  assert.equal(nonAdmin.data.error, 'admin_only');
});
db.prepare('DELETE FROM auth_sessions WHERE token=?').run(coTok);

// 建測試方案＋登錄 1 堂（直接 db insert）→ PATCH 成功 → 薪資頁該堂 amount 同步更新
const mid = Number(db.prepare("INSERT INTO users (name,email,phone,role) VALUES ('單價API客','upapi-m@x.com','0994000001','user')").run().lastInsertRowid);
const cu = Number(db.prepare("INSERT INTO users (name,email,role) VALUES ('單價API教練','upapi-coach@x.com','coach')").run().lastInsertRowid);
const coachId = Number(db.prepare("INSERT INTO coaches (user_id,display_name,is_active) VALUES (?, 'upapi-coach',1)").run(cu).lastInsertRowid);
const pkgId = Number(db.prepare(
  "INSERT INTO customer_packages (member_id, session_type, total_sessions, remaining_sessions, amount) VALUES (?, '1on1', 5, 4, 3000)"
).run(mid).lastInsertRowid);
// 2034-06-20 落在薪資期別 2034-07（範圍 2034-06-06T00:00:00 ～ 2034-07-06T00:00:00）
const bid = Number(db.prepare(
  "INSERT INTO bookings (coach_id, member_id, start_at, end_at, status, session_type, package_id, original_amount) VALUES (?, ?, ?, ?, 'confirmed', '1on1', ?, 999)"
).run(coachId, mid, '2034-06-20T09:00:00', '2034-06-20T10:00:00', pkgId).lastInsertRowid);

const patch = await req('PATCH', `/api/coach/packages/${pkgId}/unit-price`, { token, body: { unitPrice: 1800 } });
expect('修正單價成功 → 200 形狀 {ok,amount,unitPrice,rewrittenBookings}', () => {
  assert.equal(patch.status, 200);
  assert.equal(patch.data.ok, true);
  assert.equal(patch.data.amount, 9000); // 1800 * 5
  assert.equal(patch.data.unitPrice, 1800);
  assert.equal(patch.data.rewrittenBookings, 1);
});

const payroll = await req('GET', '/api/admin/payroll?period=2034-07', { token });
expect('薪資整合抽查：該堂所在期別、該教練明細中該堂 amount 已同步為新單價', () => {
  assert.equal(payroll.status, 200);
  const c = payroll.data.coaches.find((x) => x.coachId === coachId);
  assert.ok(c, '應在薪資頁找到該教練');
  const d = c.oneOnOne.details.find((x) => x.bookingId === bid);
  assert.ok(d, '應在明細中找到該堂');
  assert.equal(d.amount, 1800);
});

clean();
console.log('[package-unit-price-api] done');
