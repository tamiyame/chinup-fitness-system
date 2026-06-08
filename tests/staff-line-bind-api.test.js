// API test: 員工自助綁定 LINE 端點（需 running server + seed-demo admin）。
import assert from 'node:assert/strict';
import { db } from '../src/db/connection.js';
import { consumeCode } from '../src/services/lineBindingService.js';

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

console.log('[staff-line-bind-api] start');
// 清掉測試用 LINE id + admin 既有綁定
db.exec("UPDATE users SET line_user_id=NULL, line_bind_code=NULL, line_bind_expires_at=NULL WHERE email='admin@chinup.local' OR line_user_id='Uslb-test-line'");

const TEST_LINE = 'Uslb-test-line';
const login = await req('POST', '/api/auth/login', { body: { email: 'admin@chinup.local', password: 'admin1234' } });
const token = login.data?.token;

const noauth = await req('GET', '/api/my/line');
expect('未登入 → 401', () => assert.equal(noauth.status, 401));

const st0 = await req('GET', '/api/my/line', { token });
expect('初始 bound=false', () => { assert.equal(st0.status, 200); assert.equal(st0.data.bound, false); });

const gen = await req('POST', '/api/my/line/bind-code', { token });
expect('POST bind-code → 6 碼', () => { assert.equal(gen.status, 200); assert(/^\d{6}$/.test(gen.data.code)); });

// 模擬 webhook 收到使用者傳碼
consumeCode(gen.data.code, TEST_LINE);
const st1 = await req('GET', '/api/my/line', { token });
expect('傳碼綁定後 bound=true', () => assert.equal(st1.data.bound, true));

const del = await req('DELETE', '/api/my/line', { token });
expect('DELETE 解除綁定 → ok', () => assert.equal(del.data.ok, true));
const st2 = await req('GET', '/api/my/line', { token });
expect('解除後 bound=false', () => assert.equal(st2.data.bound, false));

// 收尾
db.exec("UPDATE users SET line_user_id=NULL, line_bind_code=NULL, line_bind_expires_at=NULL WHERE email='admin@chinup.local' OR line_user_id='Uslb-test-line'");
console.log('[staff-line-bind-api] done');
