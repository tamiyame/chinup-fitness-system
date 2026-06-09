// API test: 會員管理 編輯/封存/還原（需 running server + seed admin）。
import assert from 'node:assert/strict';
import { db } from '../src/db/connection.js';
import { findOrCreateUserByPhone } from '../src/services/userService.js';
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

console.log('[member-admin-api] start');
const clean = () => db.exec("DELETE FROM users WHERE email LIKE 'mtest-%'");
clean();

const login = await req('POST', '/api/auth/login', { body: { email: 'admin@chinup.local', password: 'admin1234' } });
const token = login.data?.token;
const me = await req('GET', '/api/auth/me', { token });
const adminId = me.data.id;

const ins = db.prepare("INSERT INTO users (name,email,phone,role) VALUES (?,?,?,'user')");
const aId = Number(ins.run('M Test A', 'mtest-a@x.com', '0911000001').lastInsertRowid);
const bId = Number(ins.run('M Test B', 'mtest-b@x.com', '0911000002').lastInsertRowid);

// 1) 編輯成功（含生日/地址）
const e1 = await req('PATCH', `/api/admin/users/${aId}`, { token, body: { name: '改名A', phone: '0911000009', email: 'mtest-a2@x.com', birthday: '1990-05-20', address: '台北市信義區' } });
expect('編輯成功 200 + 欄位寫入', () => {
  assert.equal(e1.status, 200);
  assert.equal(e1.data.name, '改名A');
  assert.equal(e1.data.phone, '0911000009');
  assert.equal(e1.data.birthday, '1990-05-20');
  assert.equal(e1.data.address, '台北市信義區');
});

// 1b) 偷渡 role/archived_at 等欄位應被忽略（端點只改 5 個欄位）
const sm = await req('PATCH', `/api/admin/users/${aId}`, { token, body: { name: '改名A', email: 'mtest-a2@x.com', role: 'owner', archived_at: '2099-01-01T00:00:00', notification_preference: 'sms' } });
expect('偷渡 role/archived_at 被忽略', () => {
  assert.equal(sm.status, 200);
  const row = db.prepare('SELECT role, archived_at, notification_preference FROM users WHERE id=?').get(aId);
  assert.equal(row.role, 'user');
  assert.equal(row.archived_at, null);
  assert.notEqual(row.notification_preference, 'sms');
});

// 2) email 衝突
const e2 = await req('PATCH', `/api/admin/users/${aId}`, { token, body: { name: '改名A', email: 'mtest-b@x.com' } });
expect('email 衝突 → 409 email_taken', () => { assert.equal(e2.status, 409); assert.equal(e2.data.error, 'email_taken'); });

// 3) phone 衝突
const e3 = await req('PATCH', `/api/admin/users/${aId}`, { token, body: { name: '改名A', phone: '0911000002' } });
expect('phone 衝突 → 409 phone_taken', () => { assert.equal(e3.status, 409); assert.equal(e3.data.error, 'phone_taken'); });

// 4) phone 格式
const e4 = await req('PATCH', `/api/admin/users/${aId}`, { token, body: { name: '改名A', phone: 'abc' } });
expect('phone 格式錯 → 400 invalid_phone', () => { assert.equal(e4.status, 400); assert.equal(e4.data.error, 'invalid_phone'); });

// 5) 姓名必填
const e5 = await req('PATCH', `/api/admin/users/${aId}`, { token, body: { name: '   ' } });
expect('姓名空白 → 400 missing_name', () => { assert.equal(e5.status, 400); assert.equal(e5.data.error, 'missing_name'); });

// 5b) 員工(coach/admin/owner)不可被清空 email（避免以 email 登入者被鎖在外）
const coachUid = Number(db.prepare("INSERT INTO users (name,email,role,password_hash) VALUES ('M Test Coach','mtest-coach@x.com','coach','x')").run().lastInsertRowid);
const ec1 = await req('PATCH', `/api/admin/users/${coachUid}`, { token, body: { name: 'M Test Coach', email: '' } });
expect('員工清空 email → 400 email_required', () => { assert.equal(ec1.status, 400); assert.equal(ec1.data.error, 'email_required'); });
const ec2 = await req('PATCH', `/api/admin/users/${coachUid}`, { token, body: { name: 'M Test Coach', email: 'mtest-coach2@x.com' } });
expect('員工改 email（非清空）→ 200', () => assert.equal(ec2.status, 200));

// 6) 封存（管理者可）
const ar = await req('POST', `/api/admin/users/${aId}/archive`, { token });
expect('管理者封存 → 200', () => assert.equal(ar.status, 200));
expect('archived_at 已設', () => assert.ok(db.prepare('SELECT archived_at FROM users WHERE id=?').get(aId).archived_at));

// 7) GET 仍回該列（含 archived_at），由前端過濾顯示
const list = await req('GET', '/api/admin/users', { token });
expect('GET 仍含已封存列 + archived_at 有值', () => {
  const row = list.data.find(u => u.id === aId);
  assert.ok(row); assert.ok(row.archived_at);
});

// 8) 同電話再次預約 → 自動還原（findOrCreateUserByPhone 為兩條預約路徑共用）
findOrCreateUserByPhone({ phone: '0911000009', name: '改名A' });
expect('同電話預約 → 自動還原 archived_at=null', () => assert.equal(db.prepare('SELECT archived_at FROM users WHERE id=?').get(aId).archived_at, null));

// 9) 不可封存自己
const self = await req('POST', `/api/admin/users/${adminId}/archive`, { token });
expect('封存自己 → 400 cannot_archive_self', () => { assert.equal(self.status, 400); assert.equal(self.data.error, 'cannot_archive_self'); });

// 10) 還原
await req('POST', `/api/admin/users/${bId}/archive`, { token });
const re = await req('POST', `/api/admin/users/${bId}/restore`, { token });
expect('還原 → 200 + archived_at=null', () => {
  assert.equal(re.status, 200);
  assert.equal(db.prepare('SELECT archived_at FROM users WHERE id=?').get(bId).archived_at, null);
});

// 11) 角色/標籤變更（新模型：role=user/coach；is_admin 標籤只在 coach 有效）
const rc1 = await req('PATCH', `/api/admin/users/${bId}/role`, { token, body: { role: 'coach' } });
expect('設為教練 → 200 + 建教練檔案(未啟用) + is_admin=0', () => {
  assert.equal(rc1.status, 200);
  const c = db.prepare('SELECT is_active FROM coaches WHERE user_id=?').get(bId);
  assert.ok(c); assert.equal(c.is_active, 0);
  const u = db.prepare('SELECT role,is_admin FROM users WHERE id=?').get(bId);
  assert.equal(u.role, 'coach'); assert.equal(u.is_admin, 0);
});
const rc2 = await req('PATCH', `/api/admin/users/${bId}/role`, { token, body: { role: 'coach', is_admin: true } });
expect('教練加管理者標籤 → is_admin=1', () => { assert.equal(rc2.status, 200); assert.equal(db.prepare('SELECT is_admin FROM users WHERE id=?').get(bId).is_admin, 1); });
const rc3 = await req('PATCH', `/api/admin/users/${bId}/role`, { token, body: { role: 'user', is_admin: true } });
expect('改回會員 → 標籤強制清0 + 教練檔案停用', () => {
  assert.equal(rc3.status, 200);
  const u = db.prepare('SELECT role,is_admin FROM users WHERE id=?').get(bId);
  assert.equal(u.role, 'user'); assert.equal(u.is_admin, 0);
  assert.equal(db.prepare('SELECT is_active FROM coaches WHERE user_id=?').get(bId).is_active, 0);
});
const rc4 = await req('PATCH', `/api/admin/users/${bId}/role`, { token, body: { role: 'coach' } });
expect('再設教練 → 教練檔案自動重新啟用(is_active=1)', () => { assert.equal(rc4.status, 200); assert.equal(db.prepare('SELECT is_active FROM coaches WHERE user_id=?').get(bId).is_active, 1); });
const rc5 = await req('PATCH', `/api/admin/users/${bId}/role`, { token, body: { role: 'owner' } });
expect('非法角色 → 400 invalid_role', () => { assert.equal(rc5.status, 400); assert.equal(rc5.data.error, 'invalid_role'); });
const rc6 = await req('PATCH', `/api/admin/users/${adminId}/role`, { token, body: { role: 'user' } });
expect('不可改自己 → 400 cannot_change_self', () => { assert.equal(rc6.status, 400); assert.equal(rc6.data.error, 'cannot_change_self'); });

// 12) 權限閘門（新模型）：會員不可登入；教練(無管理者標籤)不可用管理端點；有標籤才可。
const memberLogin = await req('POST', '/api/auth/login', { body: { email: 'user1@chinup.local', password: 'pass1234' } });
expect('會員不可登入 → 403 user_login_disabled', () => { assert.equal(memberLogin.status, 403); });

db.prepare("INSERT INTO users (name,email,password_hash,role,is_admin) VALUES ('M Plain Coach','mtest-pc@x.com',?, 'coach', 0)").run(hashPassword('coachpass1'));
const pcLogin = await req('POST', '/api/auth/login', { body: { email: 'mtest-pc@x.com', password: 'coachpass1' } });
expect('教練可登入 → 200 + token', () => { assert.equal(pcLogin.status, 200); assert.ok(pcLogin.data.token); });
const pcGet = await req('GET', '/api/admin/users', { token: pcLogin.data.token });
expect('教練(無標籤)用管理端點 → 403 admin_only', () => { assert.equal(pcGet.status, 403); assert.equal(pcGet.data.error, 'admin_only'); });
// 給他標籤後即可
await req('PATCH', `/api/admin/users/${pcLogin.data.user?.id || db.prepare("SELECT id FROM users WHERE email='mtest-pc@x.com'").get().id}/role`, { token, body: { role: 'coach', is_admin: true } });
const pcGet2 = await req('GET', '/api/admin/users', { token: pcLogin.data.token });
expect('教練(加標籤後)用管理端點 → 200', () => assert.equal(pcGet2.status, 200));

clean();
console.log('[member-admin-api] done');
