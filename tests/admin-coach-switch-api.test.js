// 管理者代選教練讀寫 /api/coach/me*：admin 帶 coachId 操作他人教練；
// 非 admin 帶 coachId 被忽略（落回自己）；壞 coachId → 404。
// server 需帶 LINE_MOCK=1 GCAL_MOCK=1 GMAIL_MOCK=1。
import assert from 'node:assert/strict';
import { db } from '../src/db/connection.js';
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

console.log('[admin-coach-switch-api test] start');
// FK-safe 清理（notifications → bookings → coaches → users）
db.exec(`
  DELETE FROM coach_availability_rules WHERE coach_id IN (SELECT id FROM coaches WHERE user_id IN (SELECT id FROM users WHERE email LIKE 'acsw-%'));
  DELETE FROM coach_availability_exceptions WHERE coach_id IN (SELECT id FROM coaches WHERE user_id IN (SELECT id FROM users WHERE email LIKE 'acsw-%'));
  DELETE FROM coaches WHERE user_id IN (SELECT id FROM users WHERE email LIKE 'acsw-%');
  DELETE FROM users WHERE email LIKE 'acsw-%';
`);
// 目標教練 C（有 1 條班表規則）
const cUid = Number(db.prepare("INSERT INTO users (name,email,role) VALUES ('ACSW Target','acsw-c@x.com','coach')").run().lastInsertRowid);
const cId = Number(db.prepare("INSERT INTO coaches (user_id, display_name, is_active) VALUES (?, 'ACSW-C', 1)").run(cUid).lastInsertRowid);
db.prepare("INSERT INTO coach_availability_rules (coach_id, day_of_week, start_time, end_time, effective_from) VALUES (?,1,'09:00','10:00','2000-01-01')").run(cId);
// 非管理者教練 D（有自己的教練檔案、0 條規則）
const dUid = Number(db.prepare("INSERT INTO users (name,email,role,is_admin,password_hash) VALUES ('ACSW NonAdmin','acsw-d@x.com','coach',0,?)").run(hashPassword('coachpass123')).lastInsertRowid);
const dId = Number(db.prepare("INSERT INTO coaches (user_id, display_name, is_active) VALUES (?, 'ACSW-D', 1)").run(dUid).lastInsertRowid);

const login = await req('POST', '/api/auth/login', { body: { email: 'admin@chinup.local', password: 'admin1234' } });
const token = login.data?.token;
expect('admin login ok', () => assert.ok(token));
const dlogin = await req('POST', '/api/auth/login', { body: { email: 'acsw-d@x.com', password: 'coachpass123' } });
const dtoken = dlogin.data?.token;
expect('non-admin coach login ok', () => assert.ok(dtoken));

// admin 帶 coachId 讀 C 的 record / rules
const meC = await req('GET', `/api/coach/me?coachId=${cId}`, { token });
expect('admin coachId → 讀到 C 的 record', () => { assert.equal(meC.status, 200); assert.equal(meC.data.id, cId); });
const rulesC = await req('GET', `/api/coach/me/rules?coachId=${cId}`, { token });
expect('admin coachId → 讀到 C 的 1 條規則', () => { assert.equal(rulesC.status, 200); assert.equal(rulesC.data.length, 1); });

// admin 帶 coachId 寫入 C：新增規則 + PATCH profile
const addRuleC = await req('POST', '/api/coach/me/rules', { token, body: { coachId: cId, day_of_week: 2, start_time: '14:00', end_time: '15:00' } });
expect('admin coachId → 新增 C 的規則 201', () => assert.equal(addRuleC.status, 201));
const rulesC2 = await req('GET', `/api/coach/me/rules?coachId=${cId}`, { token });
expect('C 現在有 2 條規則（寫入落在 C）', () => assert.equal(rulesC2.data.length, 2));
const patchC = await req('PATCH', '/api/coach/me/profile', { token, body: { coachId: cId, display_name: 'ACSW-C2', specialty: '改過', bio: null } });
expect('admin coachId → PATCH C 的 profile 200', () => { assert.equal(patchC.status, 200); assert.equal(patchC.data.display_name, 'ACSW-C2'); });

// 非管理者 D 帶 coachId=C → 被忽略，只拿到自己（D 的 0 條規則，非 C 的）
const dReadC = await req('GET', `/api/coach/me/rules?coachId=${cId}`, { token: dtoken });
expect('非管理者帶 coachId 被忽略 → 拿到自己(0 條)', () => { assert.equal(dReadC.status, 200); assert.equal(dReadC.data.length, 0); });
const dMe = await req('GET', `/api/coach/me?coachId=${cId}`, { token: dtoken });
expect('非管理者帶 coachId → 仍是自己的 record', () => assert.equal(dMe.data.id, dId));

// 壞 coachId（admin）→ 404 coach_not_found
const bad = await req('GET', '/api/coach/me/rules?coachId=99999999', { token });
expect('admin 壞 coachId → 404 coach_not_found', () => { assert.equal(bad.status, 404); assert.equal(bad.data.error, 'coach_not_found'); });

db.exec(`
  DELETE FROM coach_availability_rules WHERE coach_id IN (${cId}, ${dId});
  DELETE FROM coach_availability_exceptions WHERE coach_id IN (${cId}, ${dId});
  DELETE FROM coaches WHERE id IN (${cId}, ${dId});
  DELETE FROM users WHERE id IN (${cUid}, ${dUid});
`);
console.log('[admin-coach-switch-api test] done');
