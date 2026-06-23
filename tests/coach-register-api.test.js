// API：週彙整 / 客人搜尋 / 登錄預覽+建立（需 running server + seed admin）。
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
console.log('[coach-register-api] start');
const clean = () => db.exec("DELETE FROM notifications WHERE user_id IN (SELECT id FROM users WHERE email LIKE 'cra-%'); DELETE FROM bookings WHERE member_id IN (SELECT id FROM users WHERE email LIKE 'cra-%'); DELETE FROM customer_packages WHERE member_id IN (SELECT id FROM users WHERE email LIKE 'cra-%'); DELETE FROM users WHERE email LIKE 'cra-%'");
clean();
const login = await req('POST', '/api/auth/login', { body: { email: 'admin@chinup.local', password: 'admin1234' } });
const token = login.data?.token;
expect('admin 登入', () => assert.ok(token));
// 取一個已啟用教練 + 建客人 + 方案
const coaches = await req('GET', '/api/admin/coaches', { token });
const coachId = coaches.data.find(c => c.is_active).id;
const mid = Number(db.prepare("INSERT INTO users (name,email,phone,role) VALUES ('CRA客','cra-m@x.com','0973000001','user')").run().lastInsertRowid);
const pkg = await req('POST', '/api/coach/packages', { token, body: { memberId: mid, sessionType: '1on1', totalSessions: 3, amount: 4500 } });
const pkgId = pkg.data.id;
const pad = n => String(n).padStart(2,'0'); const d = new Date(Date.now()+15*86400000);
const D = `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}`;

expect('客人搜尋（姓名）', async () => {});
const s = await req('GET', `/api/coach/customers/search?q=CRA`, { token });
expect('搜尋回該客人 {id,name,phone}', () => { assert.ok(s.data.some(u => u.id === mid)); assert.ok(s.data.every(u => 'phone' in u && !('email' in u))); });

const pv = await req('POST', '/api/coach/register/preview', { token, body: { coachId, memberId: mid, packageId: pkgId, startAt: `${D}T09:00:00`, recurrence: { frequency:'daily', end:{type:'count',count:5} } } });
expect('預覽：3 ok + 2 depleted（方案 3 堂）', () => {
  assert.equal(pv.status, 200);
  assert.equal(pv.data.willCreate, 3);
  assert.equal(pv.data.occurrences.filter(o=>o.status==='ok').length, 3);
  assert.equal(pv.data.occurrences.filter(o=>o.status==='depleted').length, 2);
});
const cr = await req('POST', '/api/coach/register', { token, body: { coachId, memberId: mid, packageId: pkgId, startAt: `${D}T09:00:00`, recurrence: { frequency:'daily', end:{type:'count',count:5} } } });
expect('登錄：建立 3 筆、扣到 0、群組串接', () => {
  assert.equal(cr.status, 201);
  assert.equal(cr.data.created.length, 3);
  assert.equal(cr.data.remainingAfter, 0);
  const b = db.prepare('SELECT * FROM bookings WHERE id=?').get(cr.data.created[0].id);
  assert.ok(b.paid_at); assert.equal(b.package_id, pkgId); assert.equal(b.original_amount, 1500);
});
const wk = await req('GET', `/api/coach/week?coachId=${coachId}&start=${D}`, { token });
expect('週彙整：含剛建立的預約 + availableSlots 陣列', () => {
  assert.equal(wk.status, 200);
  assert.ok(Array.isArray(wk.data.bookings) && wk.data.bookings.some(b => b.member_name === 'CRA客'));
  assert.ok(Array.isArray(wk.data.availableSlots));
  assert.ok(Array.isArray(wk.data.groupSessions));
});
const pv2 = await req('POST', '/api/coach/register/preview', { token, body: { coachId, memberId: mid, packageId: pkgId, startAt: `${D}T09:00:00`, recurrence: null } });
expect('方案用罄後預覽 → 409 package_invalid', () => { assert.equal(pv2.status, 409); assert.equal(pv2.data.error, 'package_invalid'); });
clean();
console.log('[coach-register-api] done');
