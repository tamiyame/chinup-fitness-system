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

clean();
console.log('[member-admin-api] done');
