// API test: 登入頁「修改密碼」端點（需 running server）。
import assert from 'node:assert/strict';
import { db } from '../src/db/connection.js';
import { hashPassword } from '../src/services/auth.js';

const BASE = process.env.BASE || 'http://localhost:3000';
async function req(method, path, { body } = {}) {
  const res = await fetch(BASE + path, { method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  let data; try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  return { status: res.status, data };
}
function expect(label, fn){ try{fn();console.log(`  ✓ ${label}`);}catch(e){console.log(`  ✗ ${label}`);console.error(e);process.exitCode=1;} }

console.log('[change-password-api] start');
db.exec("DELETE FROM users WHERE email LIKE 'cpw-%'");
db.prepare("INSERT INTO users (name,email,password_hash,role) VALUES ('CPW Coach','cpw-coach@x.com',?, 'coach')").run(hashPassword('oldpass1'));
db.prepare("INSERT INTO users (name,email,password_hash,role) VALUES ('CPW Member','cpw-member@x.com',?, 'user')").run(hashPassword('memberpw1'));

const r1 = await req('POST', '/api/auth/change-password', { body: { email: 'cpw-coach@x.com', currentPassword: 'WRONG', newPassword: 'newpass1' } });
expect('目前密碼錯 → 401 invalid_credentials', () => { assert.equal(r1.status, 401); assert.equal(r1.data.error, 'invalid_credentials'); });

const r2 = await req('POST', '/api/auth/change-password', { body: { email: 'cpw-coach@x.com', currentPassword: 'oldpass1', newPassword: '123' } });
expect('新密碼太短 → 400 weak_password', () => { assert.equal(r2.status, 400); assert.equal(r2.data.error, 'weak_password'); });

const r3 = await req('POST', '/api/auth/change-password', { body: { email: 'cpw-member@x.com', currentPassword: 'memberpw1', newPassword: 'newpass1' } });
expect('會員不可改密碼 → 403 user_login_disabled', () => { assert.equal(r3.status, 403); assert.equal(r3.data.error, 'user_login_disabled'); });

const r4 = await req('POST', '/api/auth/change-password', { body: { email: 'cpw-coach@x.com' } });
expect('缺欄位 → 400 missing_fields', () => { assert.equal(r4.status, 400); assert.equal(r4.data.error, 'missing_fields'); });

const r5 = await req('POST', '/api/auth/change-password', { body: { email: 'cpw-coach@x.com', currentPassword: 'oldpass1', newPassword: 'newpass9' } });
expect('修改成功 → 200', () => assert.equal(r5.status, 200));

const oldLogin = await req('POST', '/api/auth/login', { body: { email: 'cpw-coach@x.com', password: 'oldpass1' } });
expect('舊密碼登入失敗 → 401', () => assert.equal(oldLogin.status, 401));
const newLogin = await req('POST', '/api/auth/login', { body: { email: 'cpw-coach@x.com', password: 'newpass9' } });
expect('新密碼登入成功 → 200 + token', () => { assert.equal(newLogin.status, 200); assert.ok(newLogin.data.token); });

db.exec("DELETE FROM users WHERE email LIKE 'cpw-%'");
console.log('[change-password-api] done');
