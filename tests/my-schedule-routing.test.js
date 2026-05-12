// HTTP 路由測試 — Phase 3A redirects + /my-schedule canonical
import assert from 'node:assert/strict';
const BASE = process.env.BASE || 'http://localhost:3000';

async function reqRaw(method, path) {
  const res = await fetch(BASE + path, { method, redirect: 'manual' });
  return { status: res.status, location: res.headers.get('location'), contentType: res.headers.get('content-type') };
}

function expect(label, fn) {
  try { fn(); console.log(`  ✓ ${label}`); }
  catch (e) { console.log(`  ✗ ${label}`); console.error(e); process.exitCode = 1; }
}

console.log('[my-schedule-routing test] start');

// /my.html → 301 /my-schedule
const r1 = await reqRaw('GET', '/my.html');
expect('/my.html status 301', () => assert.equal(r1.status, 301));
expect('/my.html location=/my-schedule', () => assert.equal(r1.location, '/my-schedule'));

// /my-bookings.html → 301 /my-schedule
const r2 = await reqRaw('GET', '/my-bookings.html');
expect('/my-bookings.html status 301', () => assert.equal(r2.status, 301));
expect('/my-bookings.html location=/my-schedule', () => assert.equal(r2.location, '/my-schedule'));

// /my-schedule → 200 + HTML
const r3 = await reqRaw('GET', '/my-schedule');
expect('/my-schedule status 200', () => assert.equal(r3.status, 200));
expect('/my-schedule is HTML', () => assert(r3.contentType && r3.contentType.startsWith('text/html')));

console.log('[my-schedule-routing test] done');
