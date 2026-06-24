// 管理者於過去日期預約（校正/補登記）：availability?backfill=1（admin 限定）
// + 用正常端點 /api/public/bookings 預約過去時段（比照正常：待核對、會發通知）。
// server 需帶 LINE_MOCK=1 GCAL_MOCK=1 GMAIL_MOCK=1。
import assert from 'node:assert/strict';
import { db } from '../src/db/connection.js';
import { addRule } from '../src/services/availabilityService.js';
import { hashPassword } from '../src/services/auth.js';
const BASE = process.env.BASE || 'http://localhost:3000';
async function req(method, path, { body, token } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers['Authorization'] = `Bearer ${token}`;
  const res = await fetch(BASE + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text(); let data; try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  return { status: res.status, data };
}
function expect(label, fn){ try{fn();console.log(`  ✓ ${label}`);}catch(e){console.log(`  ✗ ${label}`);console.error(e);process.exitCode=1;} }
const pad = n => String(n).padStart(2,'0');
const fmtDate = d => `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}`;

console.log('[admin-backfill-api test] start');
// FK-safe 清理（notifications → bookings → coaches → users），避免前次中斷殘留造成 FK 失敗
db.exec(`
  DELETE FROM notifications WHERE user_id IN (SELECT id FROM users WHERE email LIKE 'abfa-%' OR phone LIKE '0957%');
  DELETE FROM bookings WHERE coach_id IN (SELECT id FROM coaches WHERE user_id IN (SELECT id FROM users WHERE email LIKE 'abfa-%'));
  DELETE FROM bookings WHERE member_id IN (SELECT id FROM users WHERE phone LIKE '0957%' OR email LIKE 'abfa-%');
  DELETE FROM coaches WHERE user_id IN (SELECT id FROM users WHERE email LIKE 'abfa-%');
  DELETE FROM users WHERE email LIKE 'abfa-%' OR phone LIKE '0957%';
`);
const uid = Number(db.prepare("INSERT INTO users (name,email,role) VALUES ('ABFA Coach','abfa-c@x.com','coach')").run().lastInsertRowid);
const coachId = Number(db.prepare("INSERT INTO coaches (user_id, display_name, is_active) VALUES (?, 'ABFA', 1)").run(uid).lastInsertRowid);

const past = new Date(Date.now() - 7*86400000);
const pastDate = fmtDate(past);
addRule({ coachId, dayOfWeek: past.getDay(), startTime: '09:00', endTime: '18:00', effectiveFrom: '2000-01-01' });
const pastStart = `${pastDate}T10:00:00`;
const pastStart2 = `${pastDate}T14:00:00`;

const login = await req('POST', '/api/auth/login', { body: { email: 'admin@chinup.local', password: 'admin1234' } });
const token = login.data?.token;
expect('admin login ok', () => assert.ok(token));

// 管理者帶 backfill=1 → 看到過去 slot（past:true、remain 為數值，容量照常）
const avAdmin = await req('GET', `/api/coaches/${coachId}/availability?from=${pastDate}&to=${pastDate}&backfill=1`, { token });
expect('admin + backfill=1 → 過去 slot past:true、remain 數值', () => {
  assert.equal(avAdmin.status, 200);
  const hit = avAdmin.data.find(s => s.start === pastStart);
  assert.ok(hit); assert.equal(hit.past, true); assert.equal(typeof hit.remain, 'number');
});

// 無 token 帶 backfill=1 → 忽略，無過去時段
const avAnon = await req('GET', `/api/coaches/${coachId}/availability?from=${pastDate}&to=${pastDate}&backfill=1`);
expect('無 token + backfill=1 → 過去日期空清單', () => { assert.equal(avAnon.status, 200); assert.equal(avAnon.data.length, 0); });

// 登入但非管理者（coach、is_admin=0）：backfill 應被忽略
const coachUid = Number(db.prepare("INSERT INTO users (name,email,role,is_admin,password_hash) VALUES ('ABFA NonAdmin','abfa-coach@x.com','coach',0,?)").run(hashPassword('coachpass123')).lastInsertRowid);
const clogin = await req('POST', '/api/auth/login', { body: { email: 'abfa-coach@x.com', password: 'coachpass123' } });
const ctoken = clogin.data?.token;
expect('非管理者 coach 登入 ok', () => assert.ok(ctoken));
const avCoach = await req('GET', `/api/coaches/${coachId}/availability?from=${pastDate}&to=${pastDate}&backfill=1`, { token: ctoken });
expect('非管理者 + backfill=1 → 過去日期空清單（忽略）', () => { assert.equal(avCoach.status, 200); assert.equal(avCoach.data.length, 0); });

// 匿名（非管理者）用正常端點預約過去時段 → 擋下（slot_unavailable）
const bkAnon = await req('POST', '/api/public/bookings', { body: { coachId, startAt: pastStart, name:'過去客', phone:'0957000001' } });
expect('匿名預約過去時段 → 409 slot_unavailable', () => assert.equal(bkAnon.status, 409));

// 管理者用正常端點預約過去時段 → 201（比照正常：建立 confirmed、待核對）
const bkAdmin = await req('POST', '/api/public/bookings', { token, body: { coachId, startAt: pastStart, name:'過去客', phone:'0957000001' } });
expect('管理者預約過去時段 → 201', () => assert.equal(bkAdmin.status, 201));
const bid = bkAdmin.data?.id;

// 容量/重疊「比照正常」：同教練同一過去時段已被預約 → 管理者再約該時段也擋下（不可超量）
const bkDup = await req('POST', '/api/public/bookings', { token, body: { coachId, startAt: pastStart, name:'過去客二', phone:'0957000002' } });
expect('管理者重複預約同一過去時段 → 409（容量/重疊照常）', () => assert.equal(bkDup.status, 409));

// 出現在顧客課表、paid=false（待核對，比照正常）
const my = await req('POST', '/api/public/my', { body: { phone: '0957000001', name: '過去客' } });
expect('過去預約出現在課表、paid=false（待核對，比照正常）', () => {
  const item = my.data.items.find(x => x.kind === 'booking' && x.id === bid);
  assert.ok(item); assert.equal(item.paid, false);
});

db.exec(`
  DELETE FROM notifications WHERE user_id IN (SELECT id FROM users WHERE email LIKE 'abfa-%' OR phone LIKE '0957%');
  DELETE FROM bookings WHERE coach_id = ${coachId};
  DELETE FROM coaches WHERE id = ${coachId};
  DELETE FROM users WHERE id = ${uid} OR phone LIKE '0957%' OR email LIKE 'abfa-%';
`);
console.log('[admin-backfill-api test] done');
