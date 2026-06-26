// API test: 管理者單一使用者解除 LINE 綁定（DELETE /api/admin/users/:id/line）。需 running server。
// 自行建立測試管理者(is_admin=1)與測試教練(is_admin=0)，不依賴 seed 的 admin/coach，避免 seed 種類與角色遷移時序造成的 403。
import assert from 'node:assert/strict';
import { db } from '../src/db/connection.js';
import { hashPassword } from '../src/services/auth.js';

const BASE = process.env.BASE || 'http://localhost:3000';
async function req(method, path, { body, token } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers['Authorization'] = `Bearer ${token}`;
  const res = await fetch(BASE + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  let data; try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  return { status: res.status, data };
}
function expect(label, fn){ try{fn();console.log(`  ✓ ${label}`);}catch(e){console.log(`  ✗ ${label}`);console.error(e);process.exitCode=1;} }

console.log('[admin-user-line-unbind-api] start');
const clean = () => db.exec("DELETE FROM users WHERE email LIKE 'lub-%'");
clean();

// 自建測試管理者(coach+is_admin=1)與教練(coach+is_admin=0)，皆可登入後台。
const PW = hashPassword('lubpw1234');
db.prepare("INSERT INTO users (name,email,role,is_admin,password_hash) VALUES ('LUB Admin','lub-admin@x.com','coach',1,?)").run(PW);
db.prepare("INSERT INTO users (name,email,role,is_admin,password_hash) VALUES ('LUB Coach','lub-coach@x.com','coach',0,?)").run(PW);
const adminLogin = await req('POST', '/api/auth/login', { body: { email: 'lub-admin@x.com', password: 'lubpw1234' } });
const adminToken = adminLogin.data?.token;
const coachLogin = await req('POST', '/api/auth/login', { body: { email: 'lub-coach@x.com', password: 'lubpw1234' } });
const coachToken = coachLogin.data?.token;
expect('前置：admin token 取得且 is_admin', () => { assert.equal(adminLogin.status, 200); assert.equal(adminLogin.data.user.is_admin, 1); });
expect('前置：coach token 取得且非 admin', () => { assert.equal(coachLogin.status, 200); assert.equal(coachLogin.data.user.is_admin, 0); });

// 一位已綁定 + 一位未綁定（line_user_id 用唯一值避開 UNIQUE partial index 殘列衝突）
const LUID = 'Ulub' + Date.now();
const boundId = Number(db.prepare("INSERT INTO users (name,email,role,line_user_id,line_bind_code,line_bind_expires_at) VALUES ('LUB Bound','lub-bound@x.com','user',?,'c1','2099-01-01T00:00:00')").run(LUID).lastInsertRowid);
const unboundId = Number(db.prepare("INSERT INTO users (name,email,role) VALUES ('LUB Unbound','lub-unbound@x.com','user')").run().lastInsertRowid);

// 1) admin 解綁已綁定者 → 200 was_bound:true，DB line_user_id/code/expires 全清
const r1 = await req('DELETE', `/api/admin/users/${boundId}/line`, { token: adminToken });
expect('admin 解綁已綁定 → 200 was_bound:true', () => { assert.equal(r1.status, 200); assert.equal(r1.data.ok, true); assert.equal(r1.data.was_bound, true); });
expect('DB 綁定欄位全清空', () => {
  const u = db.prepare('SELECT line_user_id, line_bind_code, line_bind_expires_at FROM users WHERE id=?').get(boundId);
  assert.equal(u.line_user_id, null); assert.equal(u.line_bind_code, null); assert.equal(u.line_bind_expires_at, null);
});

// 2) admin 解綁未綁定者 → 200 was_bound:false（冪等）
const r2 = await req('DELETE', `/api/admin/users/${unboundId}/line`, { token: adminToken });
expect('admin 解綁未綁定 → 200 was_bound:false', () => { assert.equal(r2.status, 200); assert.equal(r2.data.was_bound, false); });

// 3) 不存在 user → 404 user_not_found
const r3 = await req('DELETE', `/api/admin/users/99999999/line`, { token: adminToken });
expect('不存在 → 404 user_not_found', () => { assert.equal(r3.status, 404); assert.equal(r3.data.error, 'user_not_found'); });

// 4) 非 admin（教練）→ 403
const r4 = await req('DELETE', `/api/admin/users/${unboundId}/line`, { token: coachToken });
expect('非 admin → 403', () => { assert.equal(r4.status, 403); });

clean();
console.log('[admin-user-line-unbind-api] done');
