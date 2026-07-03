# 後台「薪資計算」頁籤 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 管理後台新增「薪資計算」頁籤——依期別（上月6號～當月5號）計算各教練一對一級距抽成薪資＋團課固定比例抽成薪資，即時報表＋CSV 匯出。

**Architecture:** 新 `src/services/payrollService.js` 承載全部計算（SQL 彙總＋級距邏輯），server.js 加一支 `GET /api/admin/payroll`，四個抽成參數存 `app_settings` 並擴充既有 settings API；前端在 admin.html/admin.js 加頁籤（開機一次載入、切頁籤只切顯示，比照現有慣例）。

**Tech Stack:** Node.js ESM + Express + node:sqlite（prepared statements）；前端 vanilla JS + 既有 `.data-table` 樣式；測試為 repo 慣例的 script 式 ✓/✗（unit 直連 DB、API 打 localhost:3000）。

**Spec:** `docs/superpowers/specs/2026-07-03-admin-payroll-tab-design.md`（計算規則以 spec 為準）

## Global Constraints

- UI 文案一律繁體中文，引號用「」。
- 期別範圍：結算月 `YYYY-MM` = 前月 `06T00:00:00`（含）～ 當月 `06T00:00:00`（不含）；字串比較。
- 每堂實收 = `max(0, COALESCE(original_amount,0) − COALESCE(discount_amount,0))`；`original_amount IS NULL` → 計 0 並列入 unpriced。1對1/1對2 同規則。
- 級距整月回溯：堂數 `> threshold` → 全部套 `pctHigh`；`≤ threshold` → `pctLow`。薪資 = `Math.round(revenue × pct / 100)`。
- 團課另計不併級距：confirmed 且 `on_leave=0` 報名 × `COALESCE(amount_due, 範本 price_per_session)`，× `groupPct`。
- settings key（app_settings、schema INSERT OR IGNORE 預設）：`payroll_tier_threshold`=40（0–999）、`payroll_pct_low`=50、`payroll_pct_high`=60、`payroll_group_pct`=50（各 0–100，整數）。
- commit message 結尾：`Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`。
- 單一任務只跑該任務的測試檔（`node tests/<file>`），完整 `npm test` 留到最後（會清掉 demo 資料，跑完要 `node src/db/seed-demo.js` 重種）。
- API 測試需先起 server（`npm start` 於背景、BASE=http://localhost:3000、admin 帳號 `admin@chinup.local`/`admin1234`）。
- 手機 RWD 覆蓋 CSS 一律放 **admin.html inline `<style>`**（蓋過外部 overlay，PR #76 教訓）。
- 不動其他頁籤／既有端點行為。

---

### Task 1: 薪資設定（schema 預設值 + settings API 擴充）

**Files:**
- Modify: `src/db/schema.js`（`group_order_expiry_hours` 那行 INSERT 之後）
- Modify: `src/server.js`（`settingsPayload()` 與 `PATCH /api/admin/settings`）
- Test: `tests/payroll-settings-api.test.js`（新檔）
- Modify: `package.json`（`test:api` 鏈尾加 `&& node tests/payroll-settings-api.test.js`）

**Interfaces:**
- Produces: `GET /api/admin/settings` 回傳含 `payroll_tier_threshold`/`payroll_pct_low`/`payroll_pct_high`/`payroll_group_pct`（Number）；`PATCH` 同名鍵可寫入（整數，threshold 0–999、pct 0–100，越界 `400 invalid_<key>`）。

- [ ] **Step 1: schema.js 加四筆預設值**

在 `INSERT OR IGNORE INTO app_settings (key, value) VALUES ('group_order_expiry_hours', '72');` 之後加：

```sql
INSERT OR IGNORE INTO app_settings (key, value) VALUES ('payroll_tier_threshold', '40');
INSERT OR IGNORE INTO app_settings (key, value) VALUES ('payroll_pct_low', '50');
INSERT OR IGNORE INTO app_settings (key, value) VALUES ('payroll_pct_high', '60');
INSERT OR IGNORE INTO app_settings (key, value) VALUES ('payroll_group_pct', '50');
```

- [ ] **Step 2: server.js `settingsPayload()` 加四鍵**

```js
    payroll_tier_threshold: Number(getSetting('payroll_tier_threshold') || '40'),
    payroll_pct_low: Number(getSetting('payroll_pct_low') || '50'),
    payroll_pct_high: Number(getSetting('payroll_pct_high') || '60'),
    payroll_group_pct: Number(getSetting('payroll_group_pct') || '50'),
```

- [ ] **Step 3: PATCH 驗證（放在 `group_order_expiry_hours` 驗證區塊之後、`tx(...)` 之前）**

```js
  // 薪資抽成參數：整數；門檻 0–999、比例 0–100
  for (const [key, min, max] of [
    ['payroll_tier_threshold', 0, 999],
    ['payroll_pct_low', 0, 100],
    ['payroll_pct_high', 0, 100],
    ['payroll_group_pct', 0, 100],
  ]) {
    if (b[key] !== undefined) {
      const n = Number(b[key]);
      if (!Number.isInteger(n) || n < min || n > max) return res.status(400).json({ error: `invalid_${key}` });
      writes.push([key, String(n)]);
    }
  }
```

- [ ] **Step 4: 寫測試 `tests/payroll-settings-api.test.js`**（比照 `tests/settings-gcal-api.test.js` 的 req/expect helper 樣式）

```js
// 薪資設定四鍵：GET 預設值、PATCH 驗證與寫入、寫後還原。
import assert from 'node:assert/strict';
const BASE = process.env.BASE || 'http://localhost:3000';
async function req(method, path, { body, token } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers['Authorization'] = `Bearer ${token}`;
  const res = await fetch(BASE + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text(); let data; try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  return { status: res.status, data };
}
function expect(label, fn){ try{fn();console.log(`  ✓ ${label}`);}catch(e){console.log(`  ✗ ${label}`);console.error(e);process.exitCode=1;} }
console.log('[payroll-settings-api test] start');
const login = await req('POST', '/api/auth/login', { body: { email: 'admin@chinup.local', password: 'admin1234' } });
const token = login.data?.token;

const g0 = await req('GET', '/api/admin/settings', { token });
expect('GET 含四個 payroll 鍵（預設 40/50/60/50）', () => {
  assert.equal(g0.status, 200);
  assert.equal(typeof g0.data.payroll_tier_threshold, 'number');
  assert.equal(typeof g0.data.payroll_pct_low, 'number');
  assert.equal(typeof g0.data.payroll_pct_high, 'number');
  assert.equal(typeof g0.data.payroll_group_pct, 'number');
});
const orig = { payroll_tier_threshold: g0.data.payroll_tier_threshold, payroll_pct_low: g0.data.payroll_pct_low,
  payroll_pct_high: g0.data.payroll_pct_high, payroll_group_pct: g0.data.payroll_group_pct };

const p1 = await req('PATCH', '/api/admin/settings', { token,
  body: { payroll_tier_threshold: 30, payroll_pct_low: 45, payroll_pct_high: 65, payroll_group_pct: 55 } });
expect('PATCH 四鍵寫入成功', () => {
  assert.equal(p1.status, 200);
  assert.equal(p1.data.payroll_tier_threshold, 30);
  assert.equal(p1.data.payroll_pct_low, 45);
  assert.equal(p1.data.payroll_pct_high, 65);
  assert.equal(p1.data.payroll_group_pct, 55);
});
for (const [k, bad] of [['payroll_tier_threshold', 1000], ['payroll_pct_low', -1], ['payroll_pct_high', 101], ['payroll_group_pct', 'x']]) {
  const r = await req('PATCH', '/api/admin/settings', { token, body: { [k]: bad } });
  expect(`${k}=${bad} → 400`, () => assert.equal(r.status, 400));
}
const noTok = await req('PATCH', '/api/admin/settings', { body: { payroll_pct_low: 10 } });
expect('未登入 PATCH → 401', () => assert.equal(noTok.status, 401));
await req('PATCH', '/api/admin/settings', { token, body: orig }); // 還原
console.log('[payroll-settings-api test] done');
```

- [ ] **Step 5: `package.json` 的 `test:api` 鏈尾加 `&& node tests/payroll-settings-api.test.js`**

- [ ] **Step 6: 起 server 跑測試**

```bash
npm start &   # 背景；等 1-2 秒
node tests/payroll-settings-api.test.js   # 預期全 ✓、exit 0
kill %1
```

- [ ] **Step 7: Commit**

```bash
git add src/db/schema.js src/server.js tests/payroll-settings-api.test.js package.json
git commit -m "feat: 薪資抽成參數設定（app_settings 四鍵 + settings API 擴充）"
```

---

### Task 2: payrollService 計算核心 + unit 測試

**Files:**
- Create: `src/services/payrollService.js`
- Test: `tests/payroll-service.test.js`（新檔）
- Modify: `package.json`（`test` 鏈尾加 `&& node tests/payroll-service.test.js`）

**Interfaces:**
- Consumes: Task 1 的四個 settings key（`getSetting`）。
- Produces:
  - `periodRange(period: 'YYYY-MM') → { lo, hi, displayStart, displayEnd }`（格式不合丟 `ApiError(400,'invalid_period')`）
  - `defaultPeriod(now?: string) → 'YYYY-MM'`（日 ≤5 → 當月；≥6 → 次月）
  - `computePayroll({ period? }) → { period, range:{start,end}, settings:{threshold,pctLow,pctHigh,groupPct}, coaches:[…], totals:{…} }`（形狀見 spec）

- [ ] **Step 1: 寫 `src/services/payrollService.js`**

```js
// 薪資計算：期別（上月6號～當月5號）內各教練一對一級距抽成 + 團課固定比例抽成。
// 純即時計算（不存快照）；規則見 docs/superpowers/specs/2026-07-03-admin-payroll-tab-design.md。
import { db, nowLocal } from '../db/connection.js';
import { ApiError } from './registration.js';
import { getSetting } from './discountService.js';

const PERIOD_RE = /^\d{4}-(0[1-9]|1[0-2])$/;
const pad = (n) => String(n).padStart(2, '0');

/** 結算月 YYYY-MM → 範圍：前月06T00:00:00（含）～當月06T00:00:00（不含）。display* 為含端點的顯示日期。 */
export function periodRange(period) {
  if (!PERIOD_RE.test(period || '')) throw new ApiError(400, 'invalid_period');
  const [y, m] = period.split('-').map(Number);
  const py = m === 1 ? y - 1 : y;
  const pm = m === 1 ? 12 : m - 1;
  return {
    lo: `${py}-${pad(pm)}-06T00:00:00`,
    hi: `${y}-${pad(m)}-06T00:00:00`,
    displayStart: `${py}-${pad(pm)}-06`,
    displayEnd: `${y}-${pad(m)}-05`,
  };
}

/** 今天所屬期別：日 ≤5 → 當月；≥6 → 次月。 */
export function defaultPeriod(now = nowLocal()) {
  const y = Number(now.slice(0, 4)), m = Number(now.slice(5, 7)), d = Number(now.slice(8, 10));
  if (d <= 5) return `${y}-${pad(m)}`;
  return m === 12 ? `${y + 1}-01` : `${y}-${pad(m + 1)}`;
}

function intSetting(key, dflt) {
  const raw = getSetting(key);
  const n = raw == null || raw === '' ? NaN : Number(raw);
  return Number.isInteger(n) ? n : dflt;
}

const coachesStmt = db.prepare('SELECT id, display_name, is_active FROM coaches ORDER BY created_at ASC, id ASC');
const bookingsStmt = db.prepare(`
  SELECT b.id, b.coach_id, b.start_at, b.session_type, b.package_id,
         b.original_amount, b.discount_amount, u.name AS member_name
  FROM bookings b JOIN users u ON u.id = b.member_id
  WHERE b.status = 'confirmed' AND b.start_at >= ? AND b.start_at < ?
  ORDER BY b.coach_id ASC, b.start_at ASC
`);
const groupSessionsStmt = db.prepare(`
  SELECT s.id, s.coach_id, s.start_at, t.name AS course_name,
         COUNT(r.id) AS headcount,
         COALESCE(SUM(COALESCE(r.amount_due, t.price_per_session)), 0) AS revenue
  FROM course_sessions s
  JOIN course_templates t ON t.id = s.template_id
  LEFT JOIN registrations r ON r.session_id = s.id AND r.status = 'confirmed' AND r.on_leave = 0
  WHERE s.coach_id IS NOT NULL AND s.status != 'cancelled' AND s.start_at >= ? AND s.start_at < ?
  GROUP BY s.id
  ORDER BY s.coach_id ASC, s.start_at ASC
`);

/** 全教練當期薪資彙總＋逐堂明細。教練清單：啟用者全列（含0堂）；停用者僅期內有資料時列出。 */
export function computePayroll({ period } = {}) {
  const p = period || defaultPeriod();
  const { lo, hi, displayStart, displayEnd } = periodRange(p);
  const settings = {
    threshold: intSetting('payroll_tier_threshold', 40),
    pctLow: intSetting('payroll_pct_low', 50),
    pctHigh: intSetting('payroll_pct_high', 60),
    groupPct: intSetting('payroll_group_pct', 50),
  };
  const now = nowLocal();

  const byCoach = new Map(coachesStmt.all().map((c) => [c.id, {
    coachId: c.id, displayName: c.display_name, isActive: c.is_active,
    oneOnOne: { sessions: 0, revenue: 0, unpriced: 0, future: 0, pct: settings.pctLow, salary: 0, details: [] },
    group: { headcount: 0, revenue: 0, pct: settings.groupPct, salary: 0, details: [] },
    total: 0,
  }]));

  for (const b of bookingsStmt.all(lo, hi)) {
    const c = byCoach.get(b.coach_id);
    if (!c) continue;
    const unpriced = b.original_amount == null;
    const amount = Math.max(0, (b.original_amount || 0) - (b.discount_amount || 0));
    const future = b.start_at > now;
    c.oneOnOne.sessions += 1;
    c.oneOnOne.revenue += amount;
    if (unpriced) c.oneOnOne.unpriced += 1;
    if (future) c.oneOnOne.future += 1;
    c.oneOnOne.details.push({
      bookingId: b.id, startAt: b.start_at, memberName: b.member_name, sessionType: b.session_type,
      source: b.package_id ? 'package' : 'walkin', amount, unpriced, future,
    });
  }

  for (const s of groupSessionsStmt.all(lo, hi)) {
    const c = byCoach.get(s.coach_id);
    if (!c) continue;
    c.group.headcount += s.headcount;
    c.group.revenue += s.revenue;
    c.group.details.push({ sessionId: s.id, startAt: s.start_at, courseName: s.course_name,
      headcount: s.headcount, revenue: s.revenue });
  }

  const coaches = [];
  for (const c of byCoach.values()) {
    const o = c.oneOnOne;
    o.pct = o.sessions > settings.threshold ? settings.pctHigh : settings.pctLow;
    o.salary = Math.round(o.revenue * o.pct / 100);
    c.group.salary = Math.round(c.group.revenue * settings.groupPct / 100);
    c.total = o.salary + c.group.salary;
    if (c.isActive || o.sessions > 0 || c.group.details.length > 0) coaches.push(c);
  }

  const totals = coaches.reduce((t, c) => ({
    oneOnOneSessions: t.oneOnOneSessions + c.oneOnOne.sessions,
    oneOnOneRevenue: t.oneOnOneRevenue + c.oneOnOne.revenue,
    oneOnOneSalary: t.oneOnOneSalary + c.oneOnOne.salary,
    groupHeadcount: t.groupHeadcount + c.group.headcount,
    groupRevenue: t.groupRevenue + c.group.revenue,
    groupSalary: t.groupSalary + c.group.salary,
    total: t.total + c.total,
  }), { oneOnOneSessions: 0, oneOnOneRevenue: 0, oneOnOneSalary: 0, groupHeadcount: 0, groupRevenue: 0, groupSalary: 0, total: 0 });

  return { period: p, range: { start: displayStart, end: displayEnd }, settings, coaches, totals };
}
```

- [ ] **Step 2: 寫測試 `tests/payroll-service.test.js`**

測試期別用 `2031-02`（範圍 2031-01-06～2031-02-05，遠離其他測試資料）；資料以 email 前綴 `pr-%` 建立並於開頭清理；settings 改動後於結尾還原。

```js
// 薪資計算 service：期別解析/預設期/邊界/級距回溯/折扣/無單價/取消排除/團課規則/教練清單/設定生效。
import assert from 'node:assert/strict';
const { db } = await import('../src/db/connection.js');
const { setSetting } = await import('../src/services/discountService.js');
const { periodRange, defaultPeriod, computePayroll } = await import('../src/services/payrollService.js');

function expect(label, fn){ try{fn();console.log(`  ✓ ${label}`);}catch(e){console.log(`  ✗ ${label}`);console.error(e);process.exitCode=1;} }
console.log('[payroll-service test] start');

// ── 清理本測試資料（範圍鎖 2031 年，避免碰其他測試）──
db.exec(`
  DELETE FROM registrations WHERE session_id IN (SELECT id FROM course_sessions WHERE start_at LIKE '2031-%');
  DELETE FROM course_sessions WHERE start_at LIKE '2031-%';
  DELETE FROM course_templates WHERE name LIKE 'PR測試%';
  DELETE FROM bookings WHERE start_at LIKE '2031-%';
  DELETE FROM customer_packages WHERE member_id IN (SELECT id FROM users WHERE email LIKE 'pr-%');
  DELETE FROM coaches WHERE user_id IN (SELECT id FROM users WHERE email LIKE 'pr-%');
  DELETE FROM notifications WHERE user_id IN (SELECT id FROM users WHERE email LIKE 'pr-%');
  DELETE FROM users WHERE email LIKE 'pr-%';
`);

// ── 期別工具 ──
expect('periodRange：2031-02 → 2031-01-06 ~ 2031-02-06（不含）', () => {
  const r = periodRange('2031-02');
  assert.equal(r.lo, '2031-01-06T00:00:00');
  assert.equal(r.hi, '2031-02-06T00:00:00');
  assert.equal(r.displayStart, '2031-01-06');
  assert.equal(r.displayEnd, '2031-02-05');
});
expect('periodRange：1 月跨年', () => {
  const r = periodRange('2031-01');
  assert.equal(r.lo, '2030-12-06T00:00:00');
  assert.equal(r.hi, '2031-01-06T00:00:00');
});
expect('periodRange：格式不合 → invalid_period', () => {
  assert.throws(() => periodRange('2031-13'), /invalid_period/);
  assert.throws(() => periodRange('2031/02'), /invalid_period/);
  assert.throws(() => periodRange(''), /invalid_period/);
});
expect('defaultPeriod：日≤5 當月、≥6 次月、12月跨年', () => {
  assert.equal(defaultPeriod('2026-07-03T10:00:00'), '2026-07');
  assert.equal(defaultPeriod('2026-07-05T23:59:59'), '2026-07');
  assert.equal(defaultPeriod('2026-07-06T00:00:00'), '2026-08');
  assert.equal(defaultPeriod('2026-12-10T08:00:00'), '2027-01');
});

// ── 建測試資料 ──
const uid = (name, email) => Number(db.prepare("INSERT INTO users (name,email,role,phone) VALUES (?,?,'user',NULL)").run(name, email).lastInsertRowid);
const cuid = (email) => Number(db.prepare("INSERT INTO users (name,email,role) VALUES ('教練帳','"+email+"','coach')").run().lastInsertRowid);
const mkCoach = (email, name, active) => Number(db.prepare('INSERT INTO coaches (user_id, display_name, is_active) VALUES (?,?,?)').run(cuid(email), name, active).lastInsertRowid);

const coachA = mkCoach('pr-a@x.com', 'PR教練A', 1);   // 一對一主角
const coachB = mkCoach('pr-b@x.com', 'PR教練B', 1);   // 團課主角
const coachC = mkCoach('pr-c@x.com', 'PR教練C', 0);   // 停用、無資料 → 不列
const coachD = mkCoach('pr-d@x.com', 'PR教練D', 0);   // 停用、有資料 → 列出
const m1 = uid('PR會員一', 'pr-m1@x.com');
const m2 = uid('PR會員二', 'pr-m2@x.com');

const addBooking = ({ coach = coachA, member = m1, startAt, orig = 1000, disc = null, status = 'confirmed', type = '1on1', pkg = null }) =>
  db.prepare(`INSERT INTO bookings (coach_id, member_id, start_at, end_at, status, session_type, original_amount, discount_amount, package_id)
              VALUES (?,?,?,?,?,?,?,?,?)`)
    .run(coach, member, startAt, startAt.slice(0, 11) + String(Number(startAt.slice(11, 13)) + 1).padStart(2, '0') + startAt.slice(13), status, type, orig, disc, pkg);

// 邊界：期外兩筆、期內兩端
addBooking({ startAt: '2031-01-05T23:00:00' });                  // 前一期 → 不算
addBooking({ startAt: '2031-02-06T00:00:00' });                  // 下一期 → 不算
addBooking({ startAt: '2031-01-06T00:00:00' });                  // 期內（下界）
addBooking({ startAt: '2031-02-05T21:00:00' });                  // 期內（上界日）
// 折扣（1對2）：2000-200=1800
addBooking({ startAt: '2031-01-07T10:00:00', orig: 2000, disc: 200, type: '1on2' });
// 無單價：計0、unpriced+1
addBooking({ startAt: '2031-01-08T10:00:00', orig: null, member: m2 });
// 取消：不算
addBooking({ startAt: '2031-01-09T10:00:00', status: 'cancelled' });
// 停用教練 D 一筆 → 需列出
addBooking({ coach: coachD, startAt: '2031-01-10T10:00:00', orig: 1500 });

const find = (r, id) => r.coaches.find((c) => c.coachId === id);

expect('邊界與彙總：A=4堂（2×1000+1800+0）、取消/期外排除、unpriced=1', () => {
  const r = computePayroll({ period: '2031-02' });
  const a = find(r, coachA);
  assert.equal(a.oneOnOne.sessions, 4);
  assert.equal(a.oneOnOne.revenue, 3800);
  assert.equal(a.oneOnOne.unpriced, 1);
  assert.equal(a.oneOnOne.pct, 50);                       // 4 ≤ 40
  assert.equal(a.oneOnOne.salary, 1900);
  assert.equal(a.oneOnOne.details.length, 4);
  const d1on2 = a.oneOnOne.details.find((d) => d.sessionType === '1on2');
  assert.equal(d1on2.amount, 1800);
  assert.equal(d1on2.source, 'walkin');
});
expect('教練清單：啟用0堂列出、停用有資料列出、停用無資料不列', () => {
  const r = computePayroll({ period: '2031-02' });
  assert.ok(find(r, coachB));                              // 啟用、0 堂
  assert.equal(find(r, coachB).oneOnOne.sessions, 0);
  assert.ok(find(r, coachD));                              // 停用、有資料
  assert.equal(find(r, coachD).isActive, 0);
  assert.equal(find(r, coachC), undefined);                // 停用、無資料
});

// ── 級距（用設定門檻縮小到 5，避免灌 41 筆）──
setSetting('payroll_tier_threshold', '5');
expect('級距：恰=門檻 → 低比例', () => {
  addBooking({ startAt: '2031-01-11T10:00:00' });          // A 第 5 堂（confirmed）
  const a = find(computePayroll({ period: '2031-02' }), coachA);
  assert.equal(a.oneOnOne.sessions, 5);
  assert.equal(a.oneOnOne.pct, 50);
});
expect('級距：>門檻 → 全部堂數回溯高比例', () => {
  addBooking({ startAt: '2031-01-12T10:00:00' });          // A 第 6 堂
  const a = find(computePayroll({ period: '2031-02' }), coachA);
  assert.equal(a.oneOnOne.sessions, 6);
  assert.equal(a.oneOnOne.pct, 60);
  assert.equal(a.oneOnOne.salary, Math.round(a.oneOnOne.revenue * 0.6));
});
expect('級距比例設定生效（pctHigh 70）', () => {
  setSetting('payroll_pct_high', '70');
  const a = find(computePayroll({ period: '2031-02' }), coachA);
  assert.equal(a.oneOnOne.pct, 70);
});
setSetting('payroll_tier_threshold', '40');                // 還原
setSetting('payroll_pct_high', '60');

// ── 團課 ──
const tplId = Number(db.prepare(`
  INSERT INTO course_templates (name, min_capacity, max_capacity, day_of_week, start_time, recurrence,
    cycle_start_date, cycle_end_date, price_per_session, coach_id)
  VALUES ('PR測試團課', 1, 10, 1, '19:00', 'weekly', '2031-01-01', '2031-03-01', 400, ?)`).run(coachB).lastInsertRowid);
const mkSession = (startAt, status = 'open', coach = coachB) => Number(db.prepare(`
  INSERT INTO course_sessions (template_id, session_date, start_at, end_at, registration_deadline, status, coach_id)
  VALUES (?,?,?,?,?,?,?)`).run(tplId, startAt.slice(0, 10), startAt, startAt.slice(0, 11) + '20:00:00', startAt, status, coach).lastInsertRowid);
const mkReg = (sessionId, userId, { status = 'confirmed', amountDue = 400, onLeave = 0 } = {}) =>
  db.prepare('INSERT INTO registrations (session_id, user_id, status, amount_due, on_leave) VALUES (?,?,?,?,?)')
    .run(sessionId, userId, status, amountDue, onLeave);

const gm = [];
for (let i = 0; i < 5; i++) gm.push(uid(`PR團員${i}`, `pr-g${i}@x.com`));
const s1 = mkSession('2031-01-13T19:00:00');
mkReg(s1, gm[0]); mkReg(s1, gm[1]);                              // 2 名 confirmed ×400
mkReg(s1, gm[2], { onLeave: 1 });                                 // 請假 → 排除
mkReg(s1, gm[3], { status: 'cancelled' });                        // 取消 → 排除
mkReg(s1, gm[4], { amountDue: null });                            // NULL → 回退範本價 400
const s2 = mkSession('2031-01-20T19:00:00', 'cancelled');
mkReg(s2, gm[0]);                                                 // 取消場次 → 整場排除
mkSession('2031-02-10T19:00:00');                                 // 期外場次 → 排除

expect('團課：confirmed 且非請假 ×COALESCE(amount_due,範本價)、取消場次/期外排除、固定 50%', () => {
  const b = find(computePayroll({ period: '2031-02' }), coachB);
  assert.equal(b.group.headcount, 3);                       // gm0+gm1+gm4
  assert.equal(b.group.revenue, 1200);                      // 400×3
  assert.equal(b.group.pct, 50);
  assert.equal(b.group.salary, 600);
  assert.equal(b.group.details.length, 1);                  // 只有 s1
  assert.equal(b.group.details[0].courseName, 'PR測試團課');
  assert.equal(b.total, b.oneOnOne.salary + 600);
});
expect('團課比例不受一對一級距影響（groupPct 40 生效）', () => {
  setSetting('payroll_group_pct', '40');
  const b = find(computePayroll({ period: '2031-02' }), coachB);
  assert.equal(b.group.salary, 480);
  setSetting('payroll_group_pct', '50');                    // 還原
});
expect('totals = 各教練加總', () => {
  const r = computePayroll({ period: '2031-02' });
  const sum = r.coaches.reduce((s, c) => s + c.total, 0);
  assert.equal(r.totals.total, sum);
  assert.equal(r.totals.groupRevenue, r.coaches.reduce((s, c) => s + c.group.revenue, 0));
});
console.log('[payroll-service test] done');
```

- [ ] **Step 3: 跑測試（先跑一次看 fail → 實作已就緒則直接全 ✓）**

```bash
node tests/payroll-service.test.js   # 預期全 ✓、exit 0
```

- [ ] **Step 4: `package.json` 的 `test` 鏈尾加 `&& node tests/payroll-service.test.js`**

- [ ] **Step 5: Commit**

```bash
git add src/services/payrollService.js tests/payroll-service.test.js package.json
git commit -m "feat: payrollService 薪資計算核心（期別/級距回溯/團課另計）"
```

---

### Task 3: `GET /api/admin/payroll` 端點 + API 測試

**Files:**
- Modify: `src/server.js`（import + settings 區塊附近加 route）
- Test: `tests/payroll-api.test.js`（新檔）
- Modify: `package.json`（`test:api` 鏈尾加 `&& node tests/payroll-api.test.js`）

**Interfaces:**
- Consumes: Task 2 `computePayroll({ period? })`。
- Produces: `GET /api/admin/payroll?period=YYYY-MM`（requireAdmin）→ computePayroll 回傳值原樣 JSON；`period` 缺省用預設期；格式不合 → `400 invalid_period`。

- [ ] **Step 1: server.js 加 import 與 route**

import（併入既有 services import 區）：

```js
import { computePayroll } from './services/payrollService.js';
```

route（放在「--- Admin: Settings ---」區塊之前）：

```js
// --- Admin: Payroll（薪資計算，即時報表）---
app.get('/api/admin/payroll', requireAdmin, asyncHandler((req, res) => {
  res.json(computePayroll({ period: req.query.period ? String(req.query.period) : undefined }));
}));
```

- [ ] **Step 2: 寫測試 `tests/payroll-api.test.js`**（req/expect helper 同 Task 1）

```js
// 薪資 API：權限、period 驗證、回傳形狀。
import assert from 'node:assert/strict';
const BASE = process.env.BASE || 'http://localhost:3000';
async function req(method, path, { body, token } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers['Authorization'] = `Bearer ${token}`;
  const res = await fetch(BASE + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text(); let data; try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  return { status: res.status, data };
}
function expect(label, fn){ try{fn();console.log(`  ✓ ${label}`);}catch(e){console.log(`  ✗ ${label}`);console.error(e);process.exitCode=1;} }
console.log('[payroll-api test] start');
const login = await req('POST', '/api/auth/login', { body: { email: 'admin@chinup.local', password: 'admin1234' } });
const token = login.data?.token;

const noTok = await req('GET', '/api/admin/payroll');
expect('未登入 → 401', () => assert.equal(noTok.status, 401));

const bad = await req('GET', '/api/admin/payroll?period=2026-13', { token });
expect('period 格式不合 → 400 invalid_period', () => {
  assert.equal(bad.status, 400);
  assert.equal(bad.data.error, 'invalid_period');
});

const r0 = await req('GET', '/api/admin/payroll', { token });
expect('缺省 period → 200，回預設期與完整形狀', () => {
  assert.equal(r0.status, 200);
  assert.match(r0.data.period, /^\d{4}-\d{2}$/);
  assert.ok(r0.data.range?.start && r0.data.range?.end);
  for (const k of ['threshold', 'pctLow', 'pctHigh', 'groupPct']) assert.equal(typeof r0.data.settings[k], 'number');
  assert.ok(Array.isArray(r0.data.coaches));
  assert.equal(typeof r0.data.totals.total, 'number');
});

const r1 = await req('GET', '/api/admin/payroll?period=2031-02', { token });
expect('指定 period → 200 且 range 正確', () => {
  assert.equal(r1.status, 200);
  assert.equal(r1.data.period, '2031-02');
  assert.equal(r1.data.range.start, '2031-01-06');
  assert.equal(r1.data.range.end, '2031-02-05');
});
expect('coaches 元素形狀（若有教練）', () => {
  const c = r0.data.coaches[0];
  if (!c) return; // 空庫允許
  assert.ok('coachId' in c && 'displayName' in c && 'total' in c);
  assert.ok(Array.isArray(c.oneOnOne.details) && Array.isArray(c.group.details));
});
console.log('[payroll-api test] done');
```

- [ ] **Step 3: `package.json` 的 `test:api` 鏈尾加 `&& node tests/payroll-api.test.js`**

- [ ] **Step 4: 起 server 跑 Task 1 + Task 3 測試**

```bash
npm start &
node tests/payroll-settings-api.test.js && node tests/payroll-api.test.js   # 全 ✓
kill %1
```

- [ ] **Step 5: Commit**

```bash
git add src/server.js tests/payroll-api.test.js package.json
git commit -m "feat: GET /api/admin/payroll 薪資彙總端點"
```

---

### Task 4: 前端「薪資計算」頁籤（admin.html + admin.js）

**Files:**
- Modify: `public/admin.html`（tab 按鈕、`#apanel-payroll` panel、inline RWD CSS）
- Modify: `public/admin.js`（薪資區塊 JS：載入/渲染/期別導覽/設定編輯/展開明細/CSV）

**Interfaces:**
- Consumes: `GET /api/admin/payroll?period=`（Task 3 形狀）、`PATCH /api/admin/settings`（Task 1 四鍵）；`app.js` 的 `api/toast/escapeHtml`。
- Produces: 純 UI，無對外介面。

- [ ] **Step 1: admin.html — `#admin-tabs` 內「LINE 管理」按鈕後加**

```html
    <button data-atab="payroll" class="tab" style="white-space:nowrap;">薪資計算</button>
```

- [ ] **Step 2: admin.html — 最後一個 `apanel-*` panel 結尾之後（同層）加 panel**

```html
  <div id="apanel-payroll" class="tab-panel hidden">

  <!-- 期別導覽 -->
  <section class="mb-6">
    <div class="flex items-center justify-between flex-wrap gap-3">
      <div>
        <h2 class="section-title">薪資計算</h2>
        <div id="pr-period-label" class="subtle text-sm mt-1">—</div>
      </div>
      <div class="flex items-center gap-2">
        <button id="pr-prev" class="btn btn-ghost btn-sm">◀ 上一期</button>
        <button id="pr-current" class="btn btn-ghost btn-sm">本期</button>
        <button id="pr-next" class="btn btn-ghost btn-sm">下一期 ▶</button>
      </div>
    </div>
    <p class="subtle text-sm mt-2">薪資週期為上月 6 號至當月 5 號；依教練預約行事曆即時計算，非結算存檔。</p>
  </section>

  <!-- 抽成設定 -->
  <section class="card mb-6">
    <div class="flex items-center justify-between">
      <h3 class="font-bold">抽成設定</h3>
      <button id="pr-settings-toggle" class="btn btn-ghost btn-sm">編輯</button>
    </div>
    <div id="pr-settings-summary" class="subtle text-sm mt-1">載入中…</div>
    <div id="pr-settings-form" class="hidden mt-4">
      <div class="grid grid-cols-2 md:grid-cols-4 gap-3">
        <label class="text-sm">級距門檻（堂）
          <input id="pr-threshold" type="number" min="0" max="999" class="form-input mt-1">
        </label>
        <label class="text-sm">門檻內抽成 %
          <input id="pr-pct-low" type="number" min="0" max="100" class="form-input mt-1">
        </label>
        <label class="text-sm">超過門檻抽成 %
          <input id="pr-pct-high" type="number" min="0" max="100" class="form-input mt-1">
        </label>
        <label class="text-sm">團課抽成 %
          <input id="pr-group-pct" type="number" min="0" max="100" class="form-input mt-1">
        </label>
      </div>
      <div class="mt-3 flex gap-2">
        <button id="pr-settings-save" class="btn btn-primary btn-sm">儲存並重算</button>
        <button id="pr-settings-cancel" class="btn btn-ghost btn-sm">取消</button>
      </div>
    </div>
  </section>

  <!-- 彙總表 -->
  <section class="mb-10">
    <div class="flex items-center justify-between mb-4">
      <h2 class="section-title">教練薪資彙總</h2>
      <button id="pr-export" class="btn btn-ghost btn-sm">匯出 CSV</button>
    </div>
    <div class="card p-0 overflow-hidden">
      <div id="pr-table"><div class="p-4 subtle">載入中…</div></div>
    </div>
  </section>

  </div>
```

- [ ] **Step 3: admin.html — inline `<style>`（既有 .data-table RWD 區塊之後）加薪資表手機標籤與明細樣式**

```css
/* 薪資彙總表：手機卡片化欄位標籤（沿用 .data-table RWD 機制） */
.pr-warn-badge{ display:inline-block; font-size:11px; font-weight:700; padding:1px 7px; border-radius:999px;
  background:#fffbeb; color:#a16207; border:1px solid #fcd34d; margin-left:6px; white-space:nowrap; }
.pr-info-badge{ display:inline-block; font-size:11px; font-weight:700; padding:1px 7px; border-radius:999px;
  background:#f1f5f9; color:#64748b; border:1px solid #e2e8f0; margin-left:6px; white-space:nowrap; }
.pr-total-cell{ font-weight:800; color:var(--brand-700); }
#pr-table tr.pr-row{ cursor:pointer; }
#pr-table tr.pr-grand td{ font-weight:800; background:#f8fafc; }
#pr-table tr.pr-detail-row > td{ background:#f8fafc; cursor:default; }
.pr-detail-block{ padding:10px 4px; }
.pr-detail-block h4{ font-size:12px; font-weight:800; letter-spacing:.06em; color:var(--ink-mute); margin:10px 0 6px; }
.pr-detail-block table{ width:100%; font-size:13px; }
.pr-detail-block td{ padding:4px 8px; border-bottom:1px dashed var(--line); }
@media (max-width: 767.98px) {
  #pr-table td.pr-c-sess::before{ content:"1對1堂數"; }
  #pr-table td.pr-c-rev::before{ content:"1對1實收"; }
  #pr-table td.pr-c-pct::before{ content:"適用％"; }
  #pr-table td.pr-c-sal::before{ content:"1對1薪資"; }
  #pr-table td.pr-c-ghead::before{ content:"團課人次"; }
  #pr-table td.pr-c-grev::before{ content:"團課實收"; }
  #pr-table td.pr-c-gsal::before{ content:"團課薪資"; }
  #pr-table td.pr-c-total::before{ content:"應發合計"; }
  #pr-table tr.pr-detail-row{ display:block; }
  .pr-detail-block table, .pr-detail-block tbody, .pr-detail-block tr{ display:table; width:100%; }
  .pr-detail-block td{ display:table-cell; }
  .pr-detail-block td::before{ content:none; }
}
```

- [ ] **Step 4: admin.js — 檔尾 `loadOneOnOnePrice();` 呼叫群附近加 `loadPayroll();`，並加整個薪資區塊**

```js
// ─── 薪資計算頁籤 ───────────────────────────────────────────
let prPeriod = null;   // 'YYYY-MM'；null=後端預設本期
let prData = null;
let prDefaultPeriod = null;
const prNT = (n) => 'NT$' + Number(n || 0).toLocaleString('zh-TW');
const prDT = (s) => `${s.slice(5, 10).replace('-', '/')} ${s.slice(11, 16)}`;   // 'MM/DD HH:MM'

function prShift(period, delta) {
  const [y, m] = period.split('-').map(Number);
  const d = new Date(y, m - 1 + delta, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

async function loadPayroll() {
  const box = document.getElementById('pr-table');
  box.innerHTML = '<div class="p-4 subtle">計算中…</div>';
  try {
    const q = prPeriod ? `?period=${encodeURIComponent(prPeriod)}` : '';
    prData = await api(`/api/admin/payroll${q}`);
    prPeriod = prData.period;
    if (!prDefaultPeriod && !q) prDefaultPeriod = prData.period;
    renderPayroll();
  } catch (e) {
    box.innerHTML = `<div class="p-4 text-sm" style="color:#b91c1c;">載入失敗：${escapeHtml(e.message)}</div>`;
  }
}

function renderPayroll() {
  const d = prData;
  const [py, pm] = d.period.split('-');
  document.getElementById('pr-period-label').textContent =
    `${py} 年 ${Number(pm)} 月期（${d.range.start.replace(/-/g, '/')} – ${d.range.end.replace(/-/g, '/')}）`;
  const s = d.settings;
  document.getElementById('pr-settings-summary').textContent =
    `一對一：${s.threshold} 堂（含）以內抽 ${s.pctLow}%，超過 ${s.threshold} 堂全部堂數抽 ${s.pctHigh}%；團體課固定抽 ${s.groupPct}%（不併入級距）。`;
  document.getElementById('pr-threshold').value = s.threshold;
  document.getElementById('pr-pct-low').value = s.pctLow;
  document.getElementById('pr-pct-high').value = s.pctHigh;
  document.getElementById('pr-group-pct').value = s.groupPct;

  const box = document.getElementById('pr-table');
  if (!d.coaches.length) {
    box.innerHTML = '<div class="empty-state"><p>本期沒有教練資料</p></div>';
    return;
  }
  const t = d.totals;
  box.innerHTML = `
    <table class="w-full text-sm data-table">
      <thead><tr>
        <th class="text-left p-3">教練</th>
        <th class="text-right p-3">1對1堂數</th>
        <th class="text-right p-3">1對1實收</th>
        <th class="text-right p-3">適用％</th>
        <th class="text-right p-3">1對1薪資</th>
        <th class="text-right p-3">團課人次</th>
        <th class="text-right p-3">團課實收</th>
        <th class="text-right p-3">團課薪資</th>
        <th class="text-right p-3">應發合計</th>
      </tr></thead>
      <tbody>
        ${d.coaches.map((c, i) => {
          const o = c.oneOnOne;
          const badges =
            (c.isActive ? '' : '<span class="pr-info-badge">已停用</span>') +
            (o.unpriced ? `<span class="pr-warn-badge">${o.unpriced} 堂無單價</span>` : '') +
            (o.future ? `<span class="pr-info-badge">${o.future} 堂未上課</span>` : '');
          return `
          <tr class="pr-row" data-idx="${i}">
            <td class="p-3 cell-name"><span class="font-medium">${escapeHtml(c.displayName)}</span>${badges}</td>
            <td class="p-3 text-right pr-c-sess">${o.sessions}</td>
            <td class="p-3 text-right pr-c-rev subtle">${prNT(o.revenue)}</td>
            <td class="p-3 text-right pr-c-pct">${o.pct}%</td>
            <td class="p-3 text-right pr-c-sal">${prNT(o.salary)}</td>
            <td class="p-3 text-right pr-c-ghead">${c.group.headcount}</td>
            <td class="p-3 text-right pr-c-grev subtle">${prNT(c.group.revenue)}</td>
            <td class="p-3 text-right pr-c-gsal">${prNT(c.group.salary)}</td>
            <td class="p-3 text-right pr-c-total pr-total-cell">${prNT(c.total)}</td>
          </tr>`;
        }).join('')}
        <tr class="pr-grand">
          <td class="p-3 cell-name"><span class="font-medium">全店總計</span></td>
          <td class="p-3 text-right pr-c-sess">${t.oneOnOneSessions}</td>
          <td class="p-3 text-right pr-c-rev">${prNT(t.oneOnOneRevenue)}</td>
          <td class="p-3 text-right pr-c-pct">—</td>
          <td class="p-3 text-right pr-c-sal">${prNT(t.oneOnOneSalary)}</td>
          <td class="p-3 text-right pr-c-ghead">${t.groupHeadcount}</td>
          <td class="p-3 text-right pr-c-grev">${prNT(t.groupRevenue)}</td>
          <td class="p-3 text-right pr-c-gsal">${prNT(t.groupSalary)}</td>
          <td class="p-3 text-right pr-c-total pr-total-cell">${prNT(t.total)}</td>
        </tr>
      </tbody>
    </table>`;

  box.querySelectorAll('tr.pr-row').forEach((tr) => tr.addEventListener('click', () => prToggleDetail(tr)));
}

const SRC_LABEL = { package: '方案', walkin: '散客' };
const TYPE_LABEL = { '1on1': '1對1', '1on2': '1對2' };

function prToggleDetail(tr) {
  const next = tr.nextElementSibling;
  if (next && next.classList.contains('pr-detail-row')) { next.remove(); return; }
  tr.closest('tbody').querySelectorAll('.pr-detail-row').forEach((r) => r.remove());
  const c = prData.coaches[Number(tr.dataset.idx)];
  const o = c.oneOnOne;
  const oneRows = o.details.map((x) => `
    <tr><td>${prDT(x.startAt)}${x.future ? '<span class="pr-info-badge">未上課</span>' : ''}</td>
        <td>${escapeHtml(x.memberName)}</td>
        <td>${TYPE_LABEL[x.sessionType] || x.sessionType}·${SRC_LABEL[x.source]}</td>
        <td class="text-right">${x.unpriced ? '<span class="pr-warn-badge">無單價</span>' : prNT(x.amount)}</td></tr>`).join('');
  const grpRows = c.group.details.map((x) => `
    <tr><td>${prDT(x.startAt)}</td>
        <td>${escapeHtml(x.courseName)}</td>
        <td>${x.headcount} 人</td>
        <td class="text-right">${prNT(x.revenue)}</td></tr>`).join('');
  const row = document.createElement('tr');
  row.className = 'pr-detail-row';
  row.innerHTML = `<td colspan="9" class="cell-span"><div class="pr-detail-block">
      <h4>一對一明細（${o.sessions} 堂・實收 ${prNT(o.revenue)}）</h4>
      ${oneRows ? `<table><tbody>${oneRows}</tbody></table>` : '<div class="subtle text-sm">本期無一對一堂數</div>'}
      <h4>團體課明細（${c.group.headcount} 人次・實收 ${prNT(c.group.revenue)}）</h4>
      ${grpRows ? `<table><tbody>${grpRows}</tbody></table>` : '<div class="subtle text-sm">本期無授課團課場次</div>'}
    </div></td>`;
  tr.after(row);
}

function prExportCsv() {
  if (!prData) return;
  const rows = [['教練', '1對1堂數', '1對1實收', '適用%', '1對1薪資', '團課人次', '團課實收', '團課薪資', '應發合計']];
  for (const c of prData.coaches) {
    rows.push([c.displayName, c.oneOnOne.sessions, c.oneOnOne.revenue, c.oneOnOne.pct + '%',
      c.oneOnOne.salary, c.group.headcount, c.group.revenue, c.group.salary, c.total]);
  }
  const t = prData.totals;
  rows.push(['全店總計', t.oneOnOneSessions, t.oneOnOneRevenue, '', t.oneOnOneSalary, t.groupHeadcount, t.groupRevenue, t.groupSalary, t.total]);
  const csv = '\uFEFF' + rows.map((r) => r.map((v) => `"${String(v).replace(/"/g, '""')}"`).join(',')).join('\r\n');   // BOM：Excel 中文相容
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
  a.download = `薪資_${prData.period}.csv`;
  a.click();
  URL.revokeObjectURL(a.href);
}

document.getElementById('pr-prev').addEventListener('click', () => { prPeriod = prShift(prPeriod, -1); loadPayroll(); });
document.getElementById('pr-next').addEventListener('click', () => { prPeriod = prShift(prPeriod, 1); loadPayroll(); });
document.getElementById('pr-current').addEventListener('click', () => { prPeriod = prDefaultPeriod; loadPayroll(); });
document.getElementById('pr-export').addEventListener('click', prExportCsv);
document.getElementById('pr-settings-toggle').addEventListener('click', () => {
  document.getElementById('pr-settings-form').classList.toggle('hidden');
});
document.getElementById('pr-settings-cancel').addEventListener('click', () => {
  document.getElementById('pr-settings-form').classList.add('hidden');
  if (prData) renderPayroll();   // 還原輸入值
});
document.getElementById('pr-settings-save').addEventListener('click', async () => {
  const body = {
    payroll_tier_threshold: Number(document.getElementById('pr-threshold').value),
    payroll_pct_low: Number(document.getElementById('pr-pct-low').value),
    payroll_pct_high: Number(document.getElementById('pr-pct-high').value),
    payroll_group_pct: Number(document.getElementById('pr-group-pct').value),
  };
  try {
    await api('/api/admin/settings', { method: 'PATCH', body });
    toast('抽成設定已儲存');
    document.getElementById('pr-settings-form').classList.add('hidden');
    loadPayroll();
  } catch (e) {
    toast(`儲存失敗：${e.message}`);
  }
});
```

並在檔尾開機載入呼叫群（`loadOneOnOnePrice();` 之後）加一行：

```js
loadPayroll();
```

- [ ] **Step 5: 手動驗證（實作者做基本檢查即可，正式 smoke 由人工執行）**

```bash
node src/db/seed-demo.js      # 確保 demo 資料在
npm start &                    # http://localhost:3000
# 瀏覽 /admin.html → 登入 admin@chinup.local/admin1234 → 「薪資計算」頁籤：
#   期別導覽/設定編輯/彙總表/展開明細/CSV 下載不報 console error
kill %1
```

- [ ] **Step 6: Commit**

```bash
git add public/admin.html public/admin.js
git commit -m "feat: 後台薪資計算頁籤 UI（期別導覽/抽成設定/彙總表/明細/CSV）"
```

---

## 收尾（controller 執行，非任務）

1. 全套測試：`npm test`（unit 鏈）→ 起 server 跑 `npm run test:api` → 全綠。
2. `node src/db/seed-demo.js` 重種 demo 資料。
3. Final holistic code review subagent（跨任務整合、安全、規格符合）。
4. Push 分支 + 開 draft PR（Summary / Test plan / Design refs / Deviations，結尾 🤖 Generated with [Claude Code](https://claude.com/claude-code)）。
5. 起 preview server 供人工 smoke（390px 手機視窗檢查表）→ 業主確認後才 ready + 合併。
