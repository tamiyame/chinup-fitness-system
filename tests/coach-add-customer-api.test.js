// API test: 登錄預約 新增客人（POST /api/coach/customers）。需 running server + seed admin。
import assert from 'node:assert/strict';
import { db } from '../src/db/connection.js';

const BASE = process.env.BASE || 'http://localhost:3000';
async function req(method, path, { body, token } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers['Authorization'] = `Bearer ${token}`;
  const res = await fetch(BASE + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text(); let data; try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  return { status: res.status, data };
}
function expect(label, fn){ try{fn();console.log(`  ✓ ${label}`);}catch(e){console.log(`  ✗ ${label}`);console.error(e);process.exitCode=1;} }

console.log('[coach-add-customer-api] start');
const PHONES = ['0973099001','0973099002','0973099003'];
const clean = () => db.exec(`DELETE FROM users WHERE phone IN ('${PHONES.join("','")}') OR email LIKE 'cac-%'`);
clean();

const login = await req('POST', '/api/auth/login', { body: { email: 'admin@chinup.local', password: 'admin1234' } });
const token = login.data?.token;
expect('admin 登入', () => assert.ok(token));

// 1) 建立成功 → 200 {id,name,phone}，DB role=user
const r1 = await req('POST', '/api/coach/customers', { token, body: { name: '新客一', phone: '0973099001' } });
expect('建立成功 200 + {id,name,phone}', () => {
  assert.equal(r1.status, 200);
  assert.ok(Number.isInteger(r1.data.id));
  assert.equal(r1.data.name, '新客一');
  assert.equal(r1.data.phone, '0973099001');
});
expect('DB 為 role=user', () => {
  const u = db.prepare('SELECT role FROM users WHERE id=?').get(r1.data.id);
  assert.equal(u.role, 'user');
});

// 2) 缺名 → 400 missing_name
const r2 = await req('POST', '/api/coach/customers', { token, body: { name: '  ', phone: '0973099009' } });
expect('缺名 → 400 missing_name', () => { assert.equal(r2.status, 400); assert.equal(r2.data.error, 'missing_name'); });

// 3) 壞電話 → 400 invalid_phone
const r3 = await req('POST', '/api/coach/customers', { token, body: { name: '阿明', phone: 'abc' } });
expect('壞電話 → 400 invalid_phone', () => { assert.equal(r3.status, 400); assert.equal(r3.data.error, 'invalid_phone'); });

// 4) 員工電話 → 409 phone_unavailable
db.prepare("INSERT INTO users (name,email,phone,role) VALUES ('CAC教練','cac-coach@x.com','0973099003','coach')").run();
const r4 = await req('POST', '/api/coach/customers', { token, body: { name: '想冒用', phone: '0973099003' } });
expect('員工電話 → 409 phone_unavailable', () => { assert.equal(r4.status, 409); assert.equal(r4.data.error, 'phone_unavailable'); });

// 5) 既有客人電話 → find 不重複建（回同一 id、名不覆蓋）
const existId = Number(db.prepare("INSERT INTO users (name,phone,role) VALUES ('原客','0973099002','user')").run().lastInsertRowid);
const r5 = await req('POST', '/api/coach/customers', { token, body: { name: '不同名', phone: '0973099002' } });
expect('既有電話 → 回同一 id、不重複建', () => {
  assert.equal(r5.status, 200);
  assert.equal(r5.data.id, existId);
  const cnt = db.prepare("SELECT COUNT(*) c FROM users WHERE phone='0973099002'").get().c;
  assert.equal(cnt, 1);
});

clean();
console.log('[coach-add-customer-api] done');
