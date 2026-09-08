// API test: LINE 通知開關 GET/PATCH ＋ 本月額度 GET（需 running server）。
// 自建測試管理者(is_admin=1)與教練(is_admin=0)；跑前快照 line_notify_* 設定、跑完還原。
import assert from 'node:assert/strict';
import { db } from '../src/db/connection.js';
import { hashPassword } from '../src/services/auth.js';

const BASE = process.env.BASE || 'http://localhost:3000';
async function req(method, path, { body, token } = {}) {
  // 獨立假 IP：避免整條 test:api 鏈共用預設 IP 撞 login 限流
  const headers = { 'Content-Type': 'application/json', 'X-Forwarded-For': '10.99.7.1' };
  if (token) headers['Authorization'] = `Bearer ${token}`;
  const res = await fetch(BASE + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  let data; try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  return { status: res.status, data };
}
function expect(label, fn){ try{fn();console.log(`  ✓ ${label}`);}catch(e){console.log(`  ✗ ${label}`);console.error(e);process.exitCode=1;} }
const itemOf = (state, key) => state.groups.flatMap((g) => g.items).find((i) => i.key === key);

console.log('[line-notify-api test] start');
const clean = () => db.exec("DELETE FROM users WHERE email LIKE 'lnapi-%'");
clean();
const PW = hashPassword('lnapipw1234');
db.prepare("INSERT INTO users (name,email,role,is_admin,password_hash) VALUES ('LNAPI Admin','lnapi-admin@x.com','coach',1,?)").run(PW);
db.prepare("INSERT INTO users (name,email,role,is_admin,password_hash) VALUES ('LNAPI Coach','lnapi-coach@x.com','coach',0,?)").run(PW);
const adminLogin = await req('POST', '/api/auth/login', { body: { email: 'lnapi-admin@x.com', password: 'lnapipw1234' } });
const adminToken = adminLogin.data?.token;
const coachLogin = await req('POST', '/api/auth/login', { body: { email: 'lnapi-coach@x.com', password: 'lnapipw1234' } });
const coachToken = coachLogin.data?.token;
expect('前置：admin / coach token 取得', () => { assert.equal(adminLogin.status, 200); assert.equal(coachLogin.status, 200); });

const snapshot = db.prepare("SELECT key, value FROM app_settings WHERE key LIKE 'line_notify_%'").all();
function restore() {
  db.exec("DELETE FROM app_settings WHERE key LIKE 'line_notify_%'");
  const ins = db.prepare('INSERT INTO app_settings (key, value) VALUES (?, ?)');
  for (const r of snapshot) ins.run(r.key, r.value);
}

try {
  db.exec("DELETE FROM app_settings WHERE key LIKE 'line_notify_%'");

  const g0 = await req('GET', '/api/admin/line-notify', { token: adminToken });
  expect('GET 200：master false、3 組 16 項、欄位齊', () => {
    assert.equal(g0.status, 200);
    assert.equal(g0.data.master, false);
    assert.equal(g0.data.groups.length, 3);
    const items = g0.data.groups.flatMap((g) => g.items);
    assert.equal(items.length, 16);
    for (const i of items) {
      assert.equal(typeof i.key, 'string'); assert.equal(typeof i.label, 'string');
      assert.equal(typeof i.recipients, 'string'); assert.equal(i.enabled, true);
    }
  });

  const p1 = await req('PATCH', '/api/admin/line-notify', { token: adminToken, body: { master: true } });
  expect('PATCH master:true → master true', () => { assert.equal(p1.status, 200); assert.equal(p1.data.master, true); });

  const p2 = await req('PATCH', '/api/admin/line-notify', { token: adminToken, body: { items: { booking_new: false } } });
  expect('PATCH 單項 false → 該項 false、其餘 true、master 不動', () => {
    assert.equal(p2.status, 200);
    assert.equal(p2.data.master, true);
    assert.equal(itemOf(p2.data, 'booking_new').enabled, false);
    assert.equal(itemOf(p2.data, 'booking_confirmed_member').enabled, true);
  });

  const p3 = await req('PATCH', '/api/admin/line-notify', { token: adminToken, body: { items: { nope: true } } });
  expect('PATCH 未知 key → 400 invalid_line_notify_item', () => { assert.equal(p3.status, 400); assert.equal(p3.data.error, 'invalid_line_notify_item'); });
  const p4 = await req('PATCH', '/api/admin/line-notify', { token: adminToken, body: { master: 'yes' } });
  expect('PATCH master 非 boolean → 400 invalid_line_notify_master', () => { assert.equal(p4.status, 400); assert.equal(p4.data.error, 'invalid_line_notify_master'); });

  const u1 = await req('GET', '/api/admin/line-notify');
  expect('GET 未登入 → 401', () => assert.equal(u1.status, 401));
  const c1 = await req('GET', '/api/admin/line-notify', { token: coachToken });
  expect('GET 教練（非管理者）→ 403', () => assert.equal(c1.status, 403));
  const c2 = await req('PATCH', '/api/admin/line-notify', { token: coachToken, body: { master: false } });
  expect('PATCH 教練 → 403', () => assert.equal(c2.status, 403));

  const q1 = await req('GET', '/api/admin/line-quota', { token: adminToken });
  expect('GET line-quota 200：configured boolean、resetAt 23:00:00、fetchedAt 字串', () => {
    assert.equal(q1.status, 200);
    assert.equal(typeof q1.data.configured, 'boolean');
    assert.match(q1.data.resetAt, /T23:00:00$/);
    assert.equal(typeof q1.data.fetchedAt, 'string');
  });
  const q2 = await req('GET', '/api/admin/line-quota');
  expect('GET line-quota 未登入 → 401', () => assert.equal(q2.status, 401));
} finally {
  restore();
  clean();
}
console.log('[line-notify-api test] done');
