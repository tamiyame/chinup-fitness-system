// 我的課表客戶自助綁定 LINE：公開端點 + getPublicSchedule line_bound。
// server 需帶 LINE_MOCK=1 GCAL_MOCK=1 GMAIL_MOCK=1。
import assert from 'node:assert/strict';
import { db } from '../src/db/connection.js';
const BASE = process.env.BASE || 'http://localhost:3000';
async function req(method, path, { body } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  const res = await fetch(BASE + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text(); let data; try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  return { status: res.status, data };
}
function expect(label, fn){ try{fn();console.log(`  ✓ ${label}`);}catch(e){console.log(`  ✗ ${label}`);console.error(e);process.exitCode=1;} }

console.log('[public-line-bind-api test] start');
db.exec("DELETE FROM users WHERE phone LIKE '0961%'");
const cUid = Number(db.prepare("INSERT INTO users (name,phone,role) VALUES ('PLB 客','0961000001','user')").run().lastInsertRowid);
db.prepare("INSERT INTO users (name,phone,role,line_user_id) VALUES ('PLB 已綁','0961000002','user','Ualreadybound_plb')").run();
db.prepare("INSERT INTO users (name,phone,role) VALUES ('PLB 教練','0961000003','coach')").run();
db.prepare("INSERT OR REPLACE INTO app_settings (key, value) VALUES ('line_official_id','@plbtest')").run();

// 1) 客戶 phone+name → 200 + 6 碼 + expires_at + line_official_url；DB 寫入 line_bind_code
const ok = await req('POST', '/api/public/line/bind-code', { body: { phone: '0961000001', name: 'PLB 客' } });
expect('客戶產碼 → 200', () => assert.equal(ok.status, 200));
expect('回 6 位數 code', () => assert.match(String(ok.data.code), /^\d{6}$/));
expect('回 expires_at', () => assert.ok(ok.data.expires_at));
expect('回 line_official_url 欄位', () => assert.ok('line_official_url' in ok.data));
expect('回 line_official_id 欄位＝設定值（一鍵開 LINE 深連結用）', () => assert.equal(ok.data.line_official_id, '@plbtest'));
expect('DB 寫入 line_bind_code', () => { const r = db.prepare('SELECT line_bind_code FROM users WHERE id=?').get(cUid); assert.equal(r.line_bind_code, String(ok.data.code)); });

// 2) 錯名 → 403 not_found_or_mismatch
const wrong = await req('POST', '/api/public/line/bind-code', { body: { phone: '0961000001', name: '錯名' } });
expect('錯名 → 403 not_found_or_mismatch', () => { assert.equal(wrong.status, 403); assert.equal(wrong.data.error, 'not_found_or_mismatch'); });

// 3) 員工 phone+name → 403 not_found_or_mismatch（role 守門、中性）
const staff = await req('POST', '/api/public/line/bind-code', { body: { phone: '0961000003', name: 'PLB 教練' } });
expect('員工 → 403 not_found_or_mismatch', () => { assert.equal(staff.status, 403); assert.equal(staff.data.error, 'not_found_or_mismatch'); });

// 4) 已綁定客戶 → 409 already_bound
const bound = await req('POST', '/api/public/line/bind-code', { body: { phone: '0961000002', name: 'PLB 已綁' } });
expect('已綁定 → 409 already_bound', () => { assert.equal(bound.status, 409); assert.equal(bound.data.error, 'already_bound'); });

// 5) /api/public/my 回 line_bound（未綁定 false、已綁定 true）
const myUnbound = await req('POST', '/api/public/my', { body: { phone: '0961000001', name: 'PLB 客' } });
expect('未綁定客戶查課表 → line_bound:false', () => { assert.equal(myUnbound.status, 200); assert.equal(myUnbound.data.line_bound, false); });
const myBound = await req('POST', '/api/public/my', { body: { phone: '0961000002', name: 'PLB 已綁' } });
expect('已綁定客戶查課表 → line_bound:true', () => assert.equal(myBound.data.line_bound, true));

db.exec("DELETE FROM users WHERE phone LIKE '0961%'");
db.prepare("INSERT OR REPLACE INTO app_settings (key, value) VALUES ('line_official_id','')").run();
console.log('[public-line-bind-api test] done');
