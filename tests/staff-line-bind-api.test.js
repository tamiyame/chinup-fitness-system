// API test: 員工自助綁定 LINE 端點（需 running server + seed-demo admin）。
// 綁定步驟走真正的 /api/line/webhook HTTP 路徑（伺服器需以 LINE_MOCK=1 啟動，
// 讓 verifySignature 與 lineReply 走 mock），完整驗證「網站發碼 → 傳碼給 LINE → 綁定」流程。
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
// 模擬 LINE 使用者把 6 碼傳給官方帳號（經 webhook）。
function sendCodeViaWebhook(code, lineUserId) {
  return req('POST', '/api/line/webhook', {
    body: { events: [{ type: 'message', source: { userId: lineUserId }, message: { type: 'text', text: code }, replyToken: 'test-reply-token' }] },
  });
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

// 走真正的 webhook HTTP 路徑綁定（伺服器需 LINE_MOCK=1）
const wh = await sendCodeViaWebhook(gen.data.code, TEST_LINE);
expect('webhook 收碼 → 200（伺服器需 LINE_MOCK=1）', () => assert.equal(wh.status, 200));
const st1 = await req('GET', '/api/my/line', { token });
expect('傳碼綁定後 bound=true', () => assert.equal(st1.data.bound, true));

// 已綁定者再發碼 → 409（防直接呼叫 API 換綁；前端本就隱藏發碼按鈕）
const gen2 = await req('POST', '/api/my/line/bind-code', { token });
expect('已綁定再發碼 → 409 already_bound', () => { assert.equal(gen2.status, 409); assert.equal(gen2.data.error, 'already_bound'); });

const del = await req('DELETE', '/api/my/line', { token });
expect('DELETE 解除綁定 → ok', () => assert.equal(del.data.ok, true));
const st2 = await req('GET', '/api/my/line', { token });
expect('解除後 bound=false', () => assert.equal(st2.data.bound, false));

// 解除後可再發碼（換綁/重綁）
const gen3 = await req('POST', '/api/my/line/bind-code', { token });
expect('解除後可再發碼 → 6 碼', () => { assert.equal(gen3.status, 200); assert(/^\d{6}$/.test(gen3.data.code)); });

// 收尾
db.exec("UPDATE users SET line_user_id=NULL, line_bind_code=NULL, line_bind_expires_at=NULL WHERE email='admin@chinup.local' OR line_user_id='Uslb-test-line'");
console.log('[staff-line-bind-api] done');
