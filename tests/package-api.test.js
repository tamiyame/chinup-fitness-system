// API：方案端點（需 running server + seed admin）。
import assert from 'node:assert/strict';
import { db } from '../src/db/connection.js';

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

console.log('[package-api] start');
const clean = () => db.exec("DELETE FROM customer_packages WHERE member_id IN (SELECT id FROM users WHERE email LIKE 'pkapi-%'); DELETE FROM users WHERE email LIKE 'pkapi-%'");
clean();

const login = await req('POST', '/api/auth/login', { body: { email: 'admin@chinup.local', password: 'admin1234' } });
const token = login.data?.token;
expect('admin 登入取得 token', () => assert.ok(token));

const mid = Number(db.prepare("INSERT INTO users (name,email,phone,role) VALUES ('PK客','pkapi-m@x.com','0962000001','user')").run().lastInsertRowid);

let pkgId;
const c1 = await req('POST', '/api/coach/packages', { token, body: { memberId: mid, sessionType: '1on1', totalSessions: 10, amount: 15000, expiresAt: '2099-12-31', note: '十堂包' } });
expect('建立方案 → 201 + remaining=total + is_valid', () => {
  assert.equal(c1.status, 201);
  assert.equal(c1.data.remaining_sessions, 10);
  assert.equal(c1.data.total_sessions, 10);
  assert.equal(c1.data.is_valid, true);
  pkgId = c1.data.id;
});

const c2 = await req('POST', '/api/coach/packages', { token, body: { memberId: mid, sessionType: 'x', totalSessions: 5 } });
expect('類型錯 → 400 invalid_session_type', () => { assert.equal(c2.status, 400); assert.equal(c2.data.error, 'invalid_session_type'); });

const g = await req('GET', `/api/coach/packages?memberId=${mid}`, { token });
expect('GET 清單含該方案', () => { assert.equal(g.status, 200); assert.ok(g.data.some(p => p.id === pkgId)); });

const gNo = await req('GET', '/api/coach/packages', { token });
expect('GET 無 memberId → 400 missing_member', () => { assert.equal(gNo.status, 400); assert.equal(gNo.data.error, 'missing_member'); });

const pa = await req('PATCH', `/api/coach/packages/${pkgId}`, { token, body: { remaining: 7 } });
expect('調整剩餘 → 200 remaining=7', () => { assert.equal(pa.status, 200); assert.equal(pa.data.remaining_sessions, 7); });

const paBad = await req('PATCH', `/api/coach/packages/${pkgId}`, { token, body: { remaining: 99 } });
expect('調整超過 total → 400 invalid_remaining', () => { assert.equal(paBad.status, 400); assert.equal(paBad.data.error, 'invalid_remaining'); });

const ar = await req('POST', `/api/coach/packages/${pkgId}/archive`, { token });
expect('作廢 → 200 archived_at 有值 + is_valid=false', () => { assert.equal(ar.status, 200); assert.ok(ar.data.archived_at); assert.equal(ar.data.is_valid, false); });

const re = await req('POST', `/api/coach/packages/${pkgId}/restore`, { token });
expect('還原 → 200 archived_at=null + is_valid=true', () => { assert.equal(re.status, 200); assert.equal(re.data.archived_at, null); assert.equal(re.data.is_valid, true); });

const noAuth = await req('POST', '/api/coach/packages', { body: { memberId: mid, sessionType: '1on1', totalSessions: 5 } });
expect('未登入 → 401', () => assert.equal(noAuth.status, 401));

// requireCoach 守門：role=user 會員無法登入 → 直接塞一個有效 session token（年份 2099 遠大於 UTC now）。
// 測試端與 server 共用同一個 data/app.db，session 立即可見。
const memberToken = 'pkapi-token-' + mid;
db.prepare("INSERT OR REPLACE INTO auth_sessions (token, user_id, expires_at) VALUES (?, ?, '2099-01-01T00:00:00')").run(memberToken, mid);
const roleGate = await req('POST', '/api/coach/packages', { token: memberToken, body: { memberId: mid, sessionType: '1on1', totalSessions: 5 } });
expect('role=user 用方案端點 → 403 coach_only', () => { assert.equal(roleGate.status, 403); assert.equal(roleGate.data.error, 'coach_only'); });
db.prepare("DELETE FROM auth_sessions WHERE token=?").run(memberToken);

clean();
console.log('[package-api] done');
