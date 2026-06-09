// API test: 會員管理 編輯/封存/還原（需 running server + seed admin）。
import assert from 'node:assert/strict';
import { db } from '../src/db/connection.js';
import { findOrCreateUserByPhone } from '../src/services/userService.js';

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

// 10) 不可封存最後一位擁有者
const ownerId = Number(db.prepare("INSERT INTO users (name,email,role) VALUES ('M Test Owner','mtest-owner@x.com','owner')").run().lastInsertRowid);
const ownerCount = db.prepare("SELECT COUNT(*) AS c FROM users WHERE role='owner'").get().c;
const lo = await req('POST', `/api/admin/users/${ownerId}/archive`, { token });
if (ownerCount === 1) expect('封存最後一位擁有者 → 400 last_owner', () => { assert.equal(lo.status, 400); assert.equal(lo.data.error, 'last_owner'); });
else expect('非最後擁有者 → 可封存 200', () => assert.equal(lo.status, 200));

// 11) 還原
await req('POST', `/api/admin/users/${bId}/archive`, { token });
const re = await req('POST', `/api/admin/users/${bId}/restore`, { token });
expect('還原 → 200 + archived_at=null', () => {
  assert.equal(re.status, 200);
  assert.equal(db.prepare('SELECT archived_at FROM users WHERE id=?').get(bId).archived_at, null);
});

// 12) 角色變更（管理者可；UI 只 user/coach/admin）
const rc1 = await req('PATCH', `/api/admin/users/${bId}/role`, { token, body: { role: 'coach' } });
expect('管理者設為教練 → 200 + 自動建教練檔案(未啟用)', () => {
  assert.equal(rc1.status, 200);
  const c = db.prepare('SELECT is_active FROM coaches WHERE user_id=?').get(bId);
  assert.ok(c); assert.equal(c.is_active, 0);
  assert.equal(db.prepare('SELECT role FROM users WHERE id=?').get(bId).role, 'coach');
});
const rc2 = await req('PATCH', `/api/admin/users/${bId}/role`, { token, body: { role: 'user' } });
expect('教練改回會員 → 200 + 教練檔案停用(保留)', () => {
  assert.equal(rc2.status, 200);
  const c = db.prepare('SELECT is_active FROM coaches WHERE user_id=?').get(bId);
  assert.ok(c); assert.equal(c.is_active, 0);
});
const rc3 = await req('PATCH', `/api/admin/users/${bId}/role`, { token, body: { role: 'owner' } });
expect('不可指派 owner → 400 invalid_role', () => { assert.equal(rc3.status, 400); assert.equal(rc3.data.error, 'invalid_role'); });
const rc4 = await req('PATCH', `/api/admin/users/${ownerId}/role`, { token, body: { role: 'admin' } });
expect('不可變更擁有者 → 403 cannot_modify_owner', () => { assert.equal(rc4.status, 403); assert.equal(rc4.data.error, 'cannot_modify_owner'); });
const rc5 = await req('PATCH', `/api/admin/users/${adminId}/role`, { token, body: { role: 'user' } });
expect('不可變更自己 → 400 cannot_change_own_role', () => { assert.equal(rc5.status, 400); assert.equal(rc5.data.error, 'cannot_change_own_role'); });

clean();
console.log('[member-admin-api] done');
