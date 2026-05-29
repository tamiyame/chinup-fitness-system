import assert from 'node:assert/strict';
const BASE = process.env.BASE || 'http://localhost:3000';
async function req(method, path, { body, token } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers['Authorization'] = `Bearer ${token}`;
  const res = await fetch(BASE + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text(); let data; try { data = text?JSON.parse(text):null; } catch { data = text; }
  return { status: res.status, data };
}
function expect(label, fn){ try{fn();console.log(`  ✓ ${label}`);}catch(e){console.log(`  ✗ ${label}`);console.error(e);process.exitCode=1;} }

console.log('[public-api test] start');

// group-courses 公開可讀（無 token）
const courses = await req('GET', '/api/public/group-courses');
expect('group-courses 200 + array', () => { assert.equal(courses.status, 200); assert(Array.isArray(courses.data)); });

// 1v1 anon booking：需要一個 active coach + 一個可預約時段（此處假設環境已有；否則 skip 細節驗 user 自動建立）
// 用 lookup-free 流程驗證：送一個未來時段（先用 admin 在後台建好 coach/rule，CI 可改用 group flow）
// 這裡聚焦驗證 my 查詢 + 取消的 403 路徑：
const my = await req('POST', '/api/public/my', { body: { phone: '0900000000', name: 'Admin' } });
// 0900000000 是 admin（role!=user 但仍是 users 列）；姓名對 → 200；驗結構
expect('my 200 with items/remaining', () => {
  assert.equal(my.status, 200);
  assert(Array.isArray(my.data.items));
  assert(typeof my.data.group_remaining === 'number');
});
const myBad = await req('POST', '/api/public/my', { body: { phone: '0900000000', name: '亂打' } });
expect('my wrong name → 403', () => assert.equal(myBad.status, 403));

// 新電話、無資料 → 403（查無）
const myNew = await req('POST', '/api/public/my', { body: { phone: '0996000000', name: '新客' } });
expect('my unknown phone → 403', () => assert.equal(myNew.status, 403));

// invalid phone on booking
// createBookingAnon 先驗 coach 存在 (404) 再驗 phone (400)，故需用實際存在的 active coach id
// 才能命中 invalid_phone 的 400 路徑；coach id 因 migration rebuild 非固定，動態取得。
const activeCoaches = await req('GET', '/api/coaches');
const coachId = Array.isArray(activeCoaches.data) && activeCoaches.data[0] ? activeCoaches.data[0].id : null;
expect('an active coach exists for booking test', () => assert(coachId, 'no active coach seeded; cannot exercise booking 400 path'));
const badBook = await req('POST', '/api/public/bookings', { body: { coachId, startAt: '2030-01-01T10:00:00', name:'x', phone:'abc' } });
expect('booking invalid phone → 400', () => assert.equal(badBook.status, 400));

console.log('[public-api test] done');
