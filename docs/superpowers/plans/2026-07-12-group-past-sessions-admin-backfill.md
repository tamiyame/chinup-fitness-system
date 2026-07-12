# 團課灰色歷史場次（PR-A）＋ 後台補報名/取消含部分退款（PR-B）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 公開團課報名頁列出不可報名場次（灰色、不可點）；後台課程範本 drawer 讓管理者補報名/取消單筆報名，並連動待核對/已核對匯款訂單（含 `group_order_refunds` 部分退款明細）。

**Architecture:** 兩張互不依賴的 PR。PR-A 只動 `getPublicGroupCourses`（SQL 述詞放寬＋`selectable`/`state` 旗標）與 group.js/group.html 第三種「停用列」。PR-B 新增 `group_order_refunds` 表、兩個 service 函式（`adminBackfillRegistration`/`adminCancelRegistration`）、兩條 requireAdmin 路由、`promoteWaitlist` 過去場次守門，與 admin drawer 的補報名面板/取消鈕。

**Tech Stack:** Node（ESM、`node:sqlite`）+ Express、原生前端（無框架）、tests 為 plain-node assert 腳本（`npm test` unit / `npm run test:api` 需先起 server）。

**Spec:** `docs/superpowers/specs/2026-07-12-group-past-sessions-admin-backfill-design.md`（已 commit 在 `feature/group-public-past-sessions` 分支）。

## Global Constraints

- 所有回覆/文案/commit message 繁體中文；commit 結尾加 `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`。
- 時間一律 `nowLocal()` 產生的 `YYYY-MM-DDTHH:MM:SS` 字串做字典序比較；禁止引入 ISO/UTC。
- 新後台端點一律 `requireAdmin`；錯誤用 `ApiError(status, code)`（400 參數不合法、404 不存在、409 衝突）。
- 寫入都在單一 `tx()` 內；通知（`notifyCourseCoach`）重用既有 TEMPLATES type，不新增 type。
- 補報名不支援折扣碼；通知只發教練、客人一律不通知（業主已定案）。
- migration 只增不改：新表寫進 `SCHEMA` 字串（CREATE TABLE IF NOT EXISTS），開機自動套用。
- 前端不引入新色；公開頁遵循既有 token（`--line`/`--surface`/`.badge-closed` 灰系）。
- `npm test` 會清掉 `data/app.db` 的 demo 資料 → 跑完測試、預覽前先 `npm run seed`。
- 合併前先 `git push`（squash 取 origin HEAD）；兩張 PR 都改 package.json 測試鏈同一行，後合的那張要先 rebase main。
- repo：`https://github.com/tamiyame/chinup-fitness-system.git`；無 `gh` CLI，開 PR 用 GitHub API＋osxkeychain PAT。

---

# PART A — PR-A：公開報名頁灰色歷史場次

工作目錄：主 repo `~/projects/chinup-fitness-system`，分支 `feature/group-public-past-sessions`（已存在，含 spec commit `a116a92`）。

### Task 1: `getPublicGroupCourses` 回傳完整週期＋`selectable`/`state`

**Files:**
- Modify: `src/services/groupOrderService.js:438-468`（`getPublicGroupCourses`）
- Test: `tests/group-public-past.test.js`（新檔）
- Modify: `package.json:12`（"test" 鏈尾端）

**Interfaces:**
- Consumes: 既有 `sessionOccupied(sessionId)`、`nowLocal()`、`createTemplate`（測試用）。
- Produces: 每個 session 物件多兩個欄位 — `selectable: boolean`、`state: 'selectable'|'ended'|'not_held'|'deadline_passed'`；範本過濾條件改為「至少一個 selectable」。Task 2 的前端依賴這兩個欄位。

- [ ] **Step 1: 寫失敗測試** — 建立 `tests/group-public-past.test.js`：

```js
import assert from 'node:assert/strict';
import { db } from '../src/db/connection.js';
import { createTemplate } from '../src/services/courseService.js';
import { getPublicGroupCourses } from '../src/services/groupOrderService.js';

function reset() {
  db.exec(`
    DELETE FROM registrations;
    DELETE FROM group_orders;
    DELETE FROM course_sessions;
    DELETE FROM course_templates;
  `);
}
function expect(label, fn) {
  try { fn(); console.log(`  ✓ ${label}`); }
  catch (e) { console.log(`  ✗ ${label}`); console.error(e); process.exitCode = 1; }
}
function dstr(days) { const d = new Date(); d.setDate(d.getDate() + days); const p = (n) => String(n).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`; }
function dt(days, time) { return `${dstr(days)}T${time}`; }

console.log('[group-public-past test] start');
reset();

const tpl = createTemplate({
  name: '灰列班', min_capacity: 1, max_capacity: 3,
  day_of_week: ((new Date()).getDay() + 2) % 7, start_time: '19:00',
  recurrence: 'weekly', cycle_start_date: dstr(1), cycle_end_date: dstr(50),
  registration_deadline_hours: 1, price_per_session: 500,
});
const sess = db.prepare('SELECT * FROM course_sessions WHERE template_id = ? ORDER BY start_at ASC').all(tpl.templateId);
assert.ok(sess.length >= 6, `need >= 6 sessions, got ${sess.length}`);
const [s1, s2, s3, s4, s5, s6] = sess;

// s1 過去已成班（已結束）；s2 過去流課（未開課）；s3 未來已成班（已截止）；
// s4 未來 open 但暫停（隱藏）；s5 可報名；s6 未來 open 但截止時間已過（deadline 空窗）
const upd = db.prepare('UPDATE course_sessions SET session_date=?, start_at=?, end_at=?, registration_deadline=?, status=?, is_open=? WHERE id=?');
upd.run(dstr(-7), dt(-7, '19:00:00'), dt(-7, '20:00:00'), dt(-7, '18:00:00'), 'confirmed', 1, s1.id);
upd.run(dstr(-14), dt(-14, '19:00:00'), dt(-14, '20:00:00'), dt(-14, '18:00:00'), 'cancelled', 1, s2.id);
db.prepare("UPDATE course_sessions SET status='confirmed' WHERE id=?").run(s3.id);
db.prepare("UPDATE course_sessions SET is_open=0 WHERE id=?").run(s4.id);
db.prepare('UPDATE course_sessions SET registration_deadline=? WHERE id=?').run(dt(-1, '18:00:00'), s6.id);

const t = getPublicGroupCourses().find((x) => x.id === tpl.templateId);
expect('範本仍列出（尚有可報名場次）', () => assert.ok(t));
const by = Object.fromEntries(t.sessions.map((s) => [s.id, s]));

expect('過去已成班 → ended、不可選', () => { assert.equal(by[s1.id].state, 'ended'); assert.equal(by[s1.id].selectable, false); });
expect('過去流課 → not_held', () => assert.equal(by[s2.id].state, 'not_held'));
expect('未來已成班 → deadline_passed', () => assert.equal(by[s3.id].state, 'deadline_passed'));
expect('未來暫停中 → 完全隱藏', () => assert.equal(by[s4.id], undefined));
expect('可報名場次 selectable=true / state=selectable', () => { assert.equal(by[s5.id].selectable, true); assert.equal(by[s5.id].state, 'selectable'); });
expect('截止已過但尚未判定 → deadline_passed、不可選', () => { assert.equal(by[s6.id].state, 'deadline_passed'); assert.equal(by[s6.id].selectable, false); });
expect('排序時間升冪（過去在前）', () => {
  const starts = t.sessions.map((s) => s.start_at);
  assert.deepEqual(starts, [...starts].sort());
});
expect('灰色列仍帶容量資訊', () => { assert.equal(typeof by[s1.id].occupied, 'number'); assert.equal(by[s1.id].max_capacity, 3); });

// 全數不可選 → 範本不列出
db.prepare("UPDATE course_sessions SET status='confirmed' WHERE template_id=? AND status='open'").run(tpl.templateId);
expect('無可報名場次的範本不列出', () => {
  assert.equal(getPublicGroupCourses().find((x) => x.id === tpl.templateId), undefined);
});

console.log('[group-public-past test] done');
```

- [ ] **Step 2: 跑測試確認失敗**

Run: `cd ~/projects/chinup-fitness-system && node tests/group-public-past.test.js`
Expected: FAIL — `state`/`selectable` 為 undefined（「過去已成班 → ended」等多項 ✗；範本也可能因舊過濾而找不到）。

- [ ] **Step 3: 實作** — 置換 `src/services/groupOrderService.js` 的 `getPublicGroupCourses`（`:438-468`）内 sessions 查詢與回傳（templates 查詢不動）：

```js
  return templates.map((t) => {
    // 完整週期：過去/已截止/流課場次一併回傳（前端灰色顯示、不可點）。
    // 唯一仍隱藏的是「未來、open、被管理者暫停(is_open=0)」的場次（暫停＝對客人完全隱藏）。
    const sessions = db.prepare(`
      SELECT id, session_date, start_at, end_at, status, registration_deadline, is_open
      FROM course_sessions
      WHERE template_id = ? AND NOT (start_at > ? AND status = 'open' AND is_open = 0)
      ORDER BY start_at ASC
    `).all(t.id, now).map((s) => {
      const occupied = sessionOccupied(s.id);
      // 額滿徽章顯示目前候補人數用
      const waitlistCount = db.prepare("SELECT COUNT(*) AS c FROM registrations WHERE session_id=? AND status='waitlisted'").get(s.id).c;
      // selectable 比照送單側 validateSelectable，另補截止時間（processDeadlines 整點批次前的空窗）
      const selectable = s.status === 'open' && s.is_open === 1 && s.start_at > now
        && (!s.registration_deadline || s.registration_deadline > now);
      const state = selectable ? 'selectable'
        : s.status === 'cancelled' ? 'not_held'
        : s.start_at <= now ? 'ended'
        : 'deadline_passed';
      return {
        ...s, occupied, max_capacity: t.max_capacity,
        is_full: occupied >= t.max_capacity,
        waitlist_count: waitlistCount,
        price_per_session: t.price_per_session,
        selectable, state,
      };
    });
    return { ...t, sessions };
  }).filter((t) => t.sessions.some((s) => s.selectable));
```

同檔案頂端 JSDoc（`:437`）改為：`/** 公開：所有「尚有可報名場次」的 published template，回完整週期（不可報名場次帶 state 供灰色顯示）。 */`

- [ ] **Step 4: 跑測試確認通過**

Run: `node tests/group-public-past.test.js`
Expected: 全部 ✓、exit 0。

- [ ] **Step 5: 掛進測試鏈＋跑鄰近既有測試**

`package.json` line 12 `"test"` 尾端（`gym-slots.test.js` 之後）追加 `&& node tests/group-public-past.test.js`。

Run: `node tests/group-order-service.test.js && node tests/group-order-tuning.test.js && node tests/discount-group.test.js`
Expected: 既有 unit 測試全 ✓ — `getPublicGroupCourses` 的舊呼叫者只多收欄位、過濾語意不變（原本回傳的場次全都 selectable）。

- [ ] **Step 6: Commit**

```bash
git add tests/group-public-past.test.js src/services/groupOrderService.js package.json
git commit -m "$(cat <<'EOF'
團課公開 API 回傳完整週期：不可報名場次帶 selectable/state 旗標

- 隱藏條件收斂到唯一一種：未來、open、被暫停(is_open=0)
- selectable 補納截止時間（修 processDeadlines 整點空窗最多 59 分鐘）
- 範本顯示門檻改「至少一個可報名場次」

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
EOF
)"
```

### Task 2: group.js/group.html 灰色停用列

**Files:**
- Modify: `public/group.js`（`renderTemplate:161-180`、`renderSessionRow:202-241`、`syncSelectAll:124-131`、`selectAllToggle:133-158`、`loadCourses` 綁定 `:351`）
- Modify: `public/group.html`（`:50` `.sess-row-cap` 規則後加 CSS）

**Interfaces:**
- Consumes: Task 1 的 `s.selectable` / `s.state`。
- Produces: 純顯示層，無下游依賴。送單防呆仍靠伺服器 `validateSelectable`。

- [ ] **Step 1: group.html 加停用列 CSS** — 在 `:50`（`.sess-row-cap { … }`）之後插入：

```css
.sess-row.sess-row-disabled { opacity: .55; cursor: default; }
.sess-row.sess-row-disabled:hover { border-color: var(--line); background: var(--surface); }
```

- [ ] **Step 2: `renderSessionRow` 加第三分支** — 在 `const pct = …`（`group.js:208`）之後、`if (s.is_full)` 之前插入：

```js
  // 不可報名場次：灰色唯讀列（無 checkbox、不可點）。已結束/已截止保留容量數字當紀錄，流課只顯徽章。
  if (s.state && s.state !== 'selectable') {
    const label = { ended: '已結束', not_held: '未開課', deadline_passed: '已截止' }[s.state] || '不可報名';
    return `
    <div class="sess-row sess-row-disabled" data-sid="${s.id}">
      <div class="sess-row-info">
        <div class="sess-row-date">${escapeHtml(dateStr)}</div>
        <div class="sess-row-time">${escapeHtml(timeStr)}</div>
      </div>
      <div style="text-align:right;">
        ${s.state === 'not_held' ? '' : `<div class="sess-row-cap">${escapeHtml(capStr)}</div>`}
        <span class="badge badge-closed" style="font-size:11px;margin-top:3px;display:inline-flex;">${label}</span>
      </div>
    </div>`;
  }
```

- [ ] **Step 3: 全選/同步只計可報名場次** — 三處 `filter` 同步改：
  - `renderTemplate:162`：`const nonFull = tpl.sessions.filter(s => s.state === 'selectable' && !s.is_full);`
  - `syncSelectAll:127`：`const nonFull = tpl.sessions.filter(s => s.state === 'selectable' && !s.is_full);`
  - `selectAllToggle:134`：`const nonFull = tpl.sessions.filter(s => s.state === 'selectable' && !s.is_full);`

  「N 場」徽章（`:171` `sessionCount = tpl.sessions.length`）**不改**——現在含灰色列，與眼前列表一致（業主核可語意）。

- [ ] **Step 4: 點擊綁定跳過停用列** — `loadCourses` 內（`:351`）：

```js
    listEl.querySelectorAll('.sess-row:not(.sess-row-disabled)').forEach(row => {
```

- [ ] **Step 5: 手動驗證**

```bash
npm run seed   # npm test 會清 demo 資料，先補
# 把 seed 裡最早的一個場次改成上週已成班，做出灰色列素材：
node -e "const{DatabaseSync}=require('node:sqlite');const db=new DatabaseSync('data/app.db');const p=n=>String(n).padStart(2,'0');const d=new Date(Date.now()-3*86400000);const ds=\`\${d.getFullYear()}-\${p(d.getMonth()+1)}-\${p(d.getDate())}\`;const s=db.prepare('SELECT id,template_id FROM course_sessions ORDER BY start_at ASC LIMIT 1').get();db.prepare(\"UPDATE course_sessions SET session_date=?,start_at=?,end_at=?,registration_deadline=?,status='confirmed' WHERE id=?\").run(ds,ds+'T19:00:00',ds+'T20:00:00',ds+'T18:00:00',s.id);console.log('aged session',s.id,'of template',s.template_id);"
npm start   # http://localhost:3000/group.html
```

檢查：灰色列在最上、無 checkbox、顯「已結束」徽章與已佔數字；點擊無反應；「N 場」=列出總數；「全選整週期（N 個開放場次）」只計可報名；正常場次選取/候補/送單不受影響。

- [ ] **Step 6: Commit**

```bash
git add public/group.js public/group.html
git commit -m "$(cat <<'EOF'
團課報名頁：不可報名場次灰色列出（已結束／未開課／已截止）

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
EOF
)"
```

### Task 3: PR-A 全套測試＋push＋draft PR

- [ ] **Step 1: 全套 unit 測試**

Run: `npm test`
Expected: 全部檔案 ✓、exit 0。（API 測試在 PR-B 一併跑，PR-A 未動任何 API 行為——`/api/public/group-courses` 只多欄位。）

- [ ] **Step 2: 跑 `tests/public-api.test.js` 驗公開 API 相容**

```bash
LINE_MOCK=1 GCAL_MOCK=1 GMAIL_MOCK=1 node --env-file-if-exists=.env src/server.js & SVPID=$!
sleep 2 && node tests/public-api.test.js; kill $SVPID
```
Expected: ✓。若該檔對 group-courses 形狀有嚴格假設而失敗，修測試期望（多欄位為預期行為）。

- [ ] **Step 3: 重新 seed**（測試又清了 DB）：`npm run seed`

- [ ] **Step 4: Push＋開 draft PR**

```bash
git push -u origin feature/group-public-past-sessions
TOKEN=$(printf 'protocol=https\nhost=github.com\n\n' | git credential fill | sed -n 's/^password=//p')
curl -s -X POST https://api.github.com/repos/tamiyame/chinup-fitness-system/pulls \
  -H "Authorization: token $TOKEN" -H "Accept: application/vnd.github+json" \
  -d @- <<'EOF'
{"title":"團課報名頁：過去／已截止場次灰色列出（不可點選）","head":"feature/group-public-past-sessions","base":"main","draft":true,
"body":"## 摘要\n- 公開團課 API 改回完整週期：過去（已結束／未開課）與已截止未開始的場次一併回傳，帶 `selectable`/`state` 旗標；唯一仍隱藏的是「未來、open、被暫停」場次\n- `selectable` 補納截止時間，修掉 processDeadlines 整點批次前最多 59 分鐘的空窗\n- 報名頁新增灰色停用列（無 checkbox、不可點；已結束／已截止保留已佔數字）；「N 場」徽章＝列出總數；全選僅計可報名場次\n- 範本顯示門檻改「至少一個可報名場次」（整週期結束的課程不再佔版面）\n\n## 測試\n- 新增 `tests/group-public-past.test.js`（state 六情境／排序／範本門檻）\n- `npm test` 全綠；送單側防呆不變（validateSelectable）\n\n## Spec\n`docs/superpowers/specs/2026-07-12-group-past-sessions-admin-backfill-design.md`\n\n🤖 Generated with [Claude Code](https://claude.com/claude-code)"}
EOF
```
Expected: 回傳 JSON 含 `"number"` 與 `"draft": true`。記下 PR 編號。

- [ ] **Step 5: 業主手動 smoke**（合併前 gate）：手機開 prod 前確認 preview 環境或本機驗過 Task 2 Step 5 清單。

---

# PART B — PR-B：後台補報名／取消／部分退款

工作目錄：**另開 worktree**（主 repo 停在 PR-A 分支，plan/spec 檔才讀得到）：

```bash
cd ~/projects/chinup-fitness-system
git worktree add ~/projects/chinup-wt-admin-backfill -b feature/admin-group-backfill main
cd ~/projects/chinup-wt-admin-backfill
```

以下 Task 4-11 全在 `~/projects/chinup-wt-admin-backfill` 執行。

### Task 4: `group_order_refunds` 資料表

**Files:**
- Modify: `src/db/schema.js`（`renewal_reminders` 的 UNIQUE INDEX 之後、SCHEMA 收尾反引號之前）
- Test: `tests/admin-group-reg.test.js`（新檔，此任務先放表結構斷言，後續任務往下加）
- Modify: `package.json:12`（"test" 鏈尾端）

**Interfaces:**
- Produces: 表 `group_order_refunds(id, order_id, registration_id, amount, refunded_at, refunded_by, created_at)`。Task 7 寫入、Task 9 加總。

- [ ] **Step 1: 寫失敗測試** — 建立 `tests/admin-group-reg.test.js`：

```js
import assert from 'node:assert/strict';
import { db } from '../src/db/connection.js';

function expect(label, fn) {
  try { fn(); console.log(`  ✓ ${label}`); }
  catch (e) { console.log(`  ✗ ${label}`); console.error(e); process.exitCode = 1; }
}
function reset() {
  db.exec(`
    DELETE FROM group_order_refunds;
    DELETE FROM discount_redemptions;
    DELETE FROM registrations;
    DELETE FROM group_orders;
    DELETE FROM course_sessions;
    DELETE FROM course_templates;
    DELETE FROM discount_codes WHERE code LIKE 'AGR%';
    DELETE FROM notifications WHERE user_id IN (SELECT id FROM users WHERE phone LIKE '0996%');
    DELETE FROM users WHERE phone LIKE '0996%' OR name LIKE 'AGR-%';
  `);
}
function dstr(days) { const d = new Date(); d.setDate(d.getDate() + days); const p = (n) => String(n).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`; }
function dt(days, time) { return `${dstr(days)}T${time}`; }
function agePast(sessionId, daysAgo = 3) {
  db.prepare("UPDATE course_sessions SET session_date=?, start_at=?, end_at=?, registration_deadline=? WHERE id=?")
    .run(dstr(-daysAgo), dt(-daysAgo, '19:00:00'), dt(-daysAgo, '20:00:00'), dt(-daysAgo, '18:00:00'), sessionId);
}

console.log('[admin-group-reg test] start');

// ── §1 migration ──────────────────────────────────────────────
expect('group_order_refunds 表存在且欄位齊全', () => {
  const cols = db.prepare('PRAGMA table_info(group_order_refunds)').all().map((c) => c.name);
  for (const c of ['id', 'order_id', 'registration_id', 'amount', 'refunded_at', 'refunded_by', 'created_at']) {
    assert.ok(cols.includes(c), `missing column ${c}`);
  }
});

console.log('[admin-group-reg test] done');
```

- [ ] **Step 2: 跑測試確認失敗**

Run: `cd ~/projects/chinup-wt-admin-backfill && node tests/admin-group-reg.test.js`
Expected: FAIL — 表不存在時 `PRAGMA table_info` 回空陣列 → 「missing column id」斷言 ✗（exit code 1）。

- [ ] **Step 3: 實作** — `src/db/schema.js`，在 `idx_renewal_reminders_key` 那行之後、SCHEMA 字串收尾反引號之前加：

```sql
CREATE TABLE IF NOT EXISTS group_order_refunds (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id INTEGER NOT NULL REFERENCES group_orders(id),
  registration_id INTEGER REFERENCES registrations(id) ON DELETE SET NULL,
  amount INTEGER NOT NULL,
  refunded_at TEXT NOT NULL,
  refunded_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_group_order_refunds_order ON group_order_refunds(order_id);
```

（`registration_id` 必須 `ON DELETE SET NULL`：範本刪除會 cascade 刪 registrations，沒有它會 FK 爆掉刪不了範本。）

- [ ] **Step 4: 跑測試確認通過** — `node tests/admin-group-reg.test.js` → ✓。另跑 `node tests/migration.test.js` → ✓（不受影響）。

- [ ] **Step 5: 掛測試鏈＋Commit** — `package.json:12` 尾端追加 `&& node tests/admin-group-reg.test.js`。

```bash
git add src/db/schema.js tests/admin-group-reg.test.js package.json
git commit -m "$(cat <<'EOF'
migration：group_order_refunds 部分退款明細表

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
EOF
)"
```

### Task 5: `promoteWaitlist` 過去場次守門

**Files:**
- Modify: `src/services/groupOrderService.js:364-372`（`promoteWaitlist` 開頭）
- Test: `tests/admin-group-reg.test.js`（追加 §2）

**Interfaces:**
- Produces: `promoteWaitlist(sessionId)` 對 `start_at <= now` 的場次直接 return——保護本 PR 的取消路徑，也修掉既有整單退款/逾期釋出會把候補遞補進已上完場次的 bug。

- [ ] **Step 1: 寫失敗測試** — 檔頂 import 區擴充為：

```js
import { createTemplate } from '../src/services/courseService.js';
import {
  createGroupOrder, confirmGroupOrder, refundGroupOrder, promoteWaitlist, sessionOccupied,
} from '../src/services/groupOrderService.js';
```

（Task 6/7/9/10 會再逐步把 `adminBackfillRegistration`、`adminCancelRegistration`、`listConfirmedPayments`、`getTemplate`、`listRegistrationsBySession` 加進 import——各自任務的紅燈就是從 import error 開始。）

在 `console.log('[admin-group-reg test] done')` 之前追加 §2 測試本體：

```js
// ── §2 promoteWaitlist 過去場次守門 ───────────────────────────
reset();
{
  const tpl = createTemplate({
    name: 'AGR-守門班', min_capacity: 1, max_capacity: 1,
    day_of_week: ((new Date()).getDay() + 2) % 7, start_time: '19:00',
    recurrence: 'weekly', cycle_start_date: dstr(1), cycle_end_date: dstr(15),
    registration_deadline_hours: 1, price_per_session: 500,
  });
  const sid = db.prepare('SELECT id FROM course_sessions WHERE template_id=? ORDER BY start_at ASC').get(tpl.templateId).id;
  const oA = createGroupOrder({ name: 'AGR-甲', phone: '0996200001', paySessionIds: [sid], waitlistSessionIds: [] });
  const actorId = oA.memberId;
  confirmGroupOrder({ orderId: oA.orderId, actorId });
  createGroupOrder({ name: 'AGR-乙', phone: '0996200002', paySessionIds: [], waitlistSessionIds: [sid] });
  agePast(sid);

  promoteWaitlist(sid);
  expect('過去場次：直接呼叫不遞補', () => {
    const b = db.prepare("SELECT r.status FROM registrations r JOIN users u ON u.id=r.user_id WHERE u.phone='0996200002' AND r.session_id=?").get(sid);
    assert.equal(b.status, 'waitlisted');
    assert.equal(db.prepare("SELECT COUNT(*) AS c FROM group_orders o JOIN users u ON u.id=o.member_id WHERE u.phone='0996200002'").get().c, 0);
  });

  refundGroupOrder({ orderId: oA.orderId, actorId });
  expect('過去場次：整單退款也不遞補', () => {
    const b = db.prepare("SELECT r.status FROM registrations r JOIN users u ON u.id=r.user_id WHERE u.phone='0996200002' AND r.session_id=?").get(sid);
    assert.equal(b.status, 'waitlisted');
    assert.equal(db.prepare("SELECT COUNT(*) AS c FROM group_orders o JOIN users u ON u.id=o.member_id WHERE u.phone='0996200002'").get().c, 0);
  });
}
```

- [ ] **Step 2: 跑測試確認失敗** — `node tests/admin-group-reg.test.js`：兩個 §2 斷言 ✗（乙被遞補成 pending 並開了 24h 單）。

- [ ] **Step 3: 實作** — `promoteWaitlist`（`groupOrderService.js:366-367`）在 cancelled 檢查後加一行：

```js
    const s = getSession.get(sessionId);
    if (!s || s.status === 'cancelled') return;
    if (s.start_at <= nowLocal()) return;  // 已開始/已結束不遞補：避免把候補塞進上完的課還開 24h 付款單
```

- [ ] **Step 4: 跑測試確認通過** — `node tests/admin-group-reg.test.js` ✓；回歸 `node tests/refund.test.js && node tests/group-order-tuning.test.js && node tests/group-leave.test.js && node tests/group-order-service.test.js` 全 ✓（它們的遞補情境都是未來場次，不受影響）。

- [ ] **Step 5: Commit**

```bash
git add src/services/groupOrderService.js tests/admin-group-reg.test.js
git commit -m "$(cat <<'EOF'
修：promoteWaitlist 不再遞補已開始/已結束的場次

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
EOF
)"
```

### Task 6: service `adminBackfillRegistration`

**Files:**
- Modify: `src/services/groupOrderService.js`（新函式，放在 `expirePendingOrders` 之後、`getPublicGroupCourses` 之前）
- Test: `tests/admin-group-reg.test.js`（追加 §3；import 補 `adminBackfillRegistration`、`createCustomerNoPhone` 不需要——service 內部處理）

**Interfaces:**
- Consumes: `findOrCreateUserByPhone`（已 import）、`createCustomerNoPhone`（**需在檔頂 import 加入**：`import { findOrCreateUserByPhone, getUserByPhoneAndName, createCustomerNoPhone } from './userService.js';`）、`getGroupOrderExpiryHours`、`insertOrder`/`insertReg`/`reactivateReg`/`getAnyReg`/`sessionIsFull`、`notifyCourseCoach`、`fmtMD`。
- Produces: `adminBackfillRegistration({ sessionId, userId=null, name=null, phone=null, paid=false, actorId })` → `{ ok:true, registrationId, orderId|null, status:'confirmed'|'pending'|'waitlisted' }`。錯誤碼：404 `session_not_found`/`template_not_found`/`user_not_found`、409 `session_cancelled`/`already_registered`/`session_full`、400 `paid_requires_seat`（另 `invalid_phone`/`missing_name`/`phone_unavailable` 由 userService 拋出）。Task 8 路由、Task 10 UI 依賴此契約。

- [ ] **Step 1: 寫失敗測試** — §3 追加（`console.log('… done')` 前）：

```js
// ── §3 adminBackfillRegistration ──────────────────────────────
reset();
{
  const tpl = createTemplate({
    name: 'AGR-補班', min_capacity: 1, max_capacity: 2,
    day_of_week: ((new Date()).getDay() + 2) % 7, start_time: '19:00',
    recurrence: 'weekly', cycle_start_date: dstr(1), cycle_end_date: dstr(40),
    registration_deadline_hours: 1, price_per_session: 500,
  });
  const ss = db.prepare('SELECT id FROM course_sessions WHERE template_id=? ORDER BY start_at ASC').all(tpl.templateId).map((r) => r.id);
  const [sA, sB, sC, sD] = ss;
  const actorId = Number(db.prepare("INSERT INTO users (name, email, role, is_admin) VALUES ('AGR-管理', 'agr-admin@x.com', 'coach', 1)").run().lastInsertRowid);

  // a) 已收款補報（新客人姓名+電話）→ 獨立 paid 單 + confirmed
  const r1 = adminBackfillRegistration({ sessionId: sA, name: 'AGR-丙', phone: '0996300001', paid: true, actorId });
  expect('paid 補報 → confirmed + 獨立已核對訂單', () => {
    assert.equal(r1.status, 'confirmed');
    const o = db.prepare('SELECT * FROM group_orders WHERE id=?').get(r1.orderId);
    assert.equal(o.status, 'paid'); assert.equal(o.paid_by, actorId);
    assert.ok(o.paid_at); assert.equal(o.total_amount, 500); assert.equal(o.original_amount, 500);
    const reg = db.prepare('SELECT * FROM registrations WHERE id=?').get(r1.registrationId);
    assert.equal(reg.status, 'confirmed'); assert.equal(reg.amount_due, 500); assert.equal(reg.order_id, r1.orderId);
    assert.equal(sessionOccupied(sA), 1);
  });

  // b) 待核對補報（無既有單）→ 新 pending 單（72h）
  const r2 = adminBackfillRegistration({ sessionId: sA, name: 'AGR-丁', phone: '0996300002', paid: false, actorId });
  expect('pending 補報 → 新待核對訂單', () => {
    assert.equal(r2.status, 'pending');
    const o = db.prepare('SELECT * FROM group_orders WHERE id=?').get(r2.orderId);
    assert.equal(o.status, 'pending');
    assert.ok(o.expires_at > dt(0, '00:00:00'));
  });

  // c) 同客人再補另一場 → 併入同一張 pending 單、金額累加
  const r3 = adminBackfillRegistration({ sessionId: sB, name: 'AGR-丁', phone: '0996300002', paid: false, actorId });
  expect('pending 補報 → 併單、金額累加', () => {
    assert.equal(r3.orderId, r2.orderId);
    const o = db.prepare('SELECT * FROM group_orders WHERE id=?').get(r2.orderId);
    assert.equal(o.total_amount, 1000); assert.equal(o.original_amount, 1000);
  });

  // d) 滿額未來場次 → 候補（不建單）；paid+滿額 → 400
  //（sA 此刻已滿：丙 confirmed ＋ 丁 pending，cap=2）
  const r4 = adminBackfillRegistration({ sessionId: sA, name: 'AGR-己', phone: '0996300004', paid: false, actorId });
  expect('滿額未來場次 → waitlisted、無訂單', () => {
    assert.equal(r4.status, 'waitlisted'); assert.equal(r4.orderId, null);
    const reg = db.prepare('SELECT * FROM registrations WHERE id=?').get(r4.registrationId);
    assert.equal(reg.order_id, null); assert.equal(reg.amount_due, null);
  });
  expect('滿額 + paid → 400 paid_requires_seat', () => {
    try { adminBackfillRegistration({ sessionId: sA, name: 'AGR-庚', phone: '0996300005', paid: true, actorId }); assert.fail('no throw'); }
    catch (e) { assert.equal(e.status, 400); assert.equal(e.message, 'paid_requires_seat'); }
  });

  // e) 過去場次：未滿可補（paid）；滿了 → 409 session_full
  agePast(sC);
  const r5 = adminBackfillRegistration({ sessionId: sC, name: 'AGR-辛', phone: '0996300006', paid: true, actorId });
  expect('過去未滿場次可補登（confirmed）', () => assert.equal(r5.status, 'confirmed'));
  adminBackfillRegistration({ sessionId: sC, name: 'AGR-壬', phone: '0996300007', paid: true, actorId }); // sC 滿
  expect('過去滿額場次 → 409 session_full', () => {
    try { adminBackfillRegistration({ sessionId: sC, name: 'AGR-癸', phone: '0996300008', paid: true, actorId }); assert.fail('no throw'); }
    catch (e) { assert.equal(e.status, 409); assert.equal(e.message, 'session_full'); }
  });

  // f) 重複 active 報名 → 409
  expect('重複報名 → 409 already_registered', () => {
    try { adminBackfillRegistration({ sessionId: sA, name: 'AGR-丙', phone: '0996300001', paid: true, actorId }); assert.fail('no throw'); }
    catch (e) { assert.equal(e.status, 409); assert.equal(e.message, 'already_registered'); }
  });

  // g) 已取消舊列 → 復原（同一列，不新插）
  db.prepare("UPDATE registrations SET status='cancelled' WHERE id=?").run(r1.registrationId);
  const r6 = adminBackfillRegistration({ sessionId: sA, name: 'AGR-丙', phone: '0996300001', paid: false, actorId });
  expect('cancelled 舊列復原為 pending（UNIQUE 不撞）', () => {
    assert.equal(r6.registrationId, r1.registrationId);
    assert.equal(db.prepare('SELECT status FROM registrations WHERE id=?').get(r1.registrationId).status, 'pending');
  });

  // h) userId 路徑＋員工守門
  const memberId = db.prepare("SELECT id FROM users WHERE phone='0996300001'").get().id;
  const r7 = adminBackfillRegistration({ sessionId: sD, userId: memberId, paid: false, actorId });
  expect('userId 路徑可補報', () => assert.equal(r7.status, 'pending'));
  expect('userId 指到員工 → 404 user_not_found', () => {
    try { adminBackfillRegistration({ sessionId: sD, userId: actorId, paid: false, actorId }); assert.fail('no throw'); }
    catch (e) { assert.equal(e.status, 404); assert.equal(e.message, 'user_not_found'); }
  });

  // i) 無電話客人
  const r8 = adminBackfillRegistration({ sessionId: sD, name: 'AGR-無話', phone: null, paid: true, actorId });
  expect('無電話客人可補報（customer_phone 空字串）', () => {
    const o = db.prepare('SELECT customer_phone FROM group_orders WHERE id=?').get(r8.orderId);
    assert.equal(o.customer_phone, '');
  });

  // j) 未開課場次 → 409
  db.prepare("UPDATE course_sessions SET status='cancelled' WHERE id=?").run(sB);
  expect('cancelled 場次 → 409 session_cancelled', () => {
    try { adminBackfillRegistration({ sessionId: sB, name: 'AGR-子', phone: '0996300009', paid: false, actorId }); assert.fail('no throw'); }
    catch (e) { assert.equal(e.status, 409); assert.equal(e.message, 'session_cancelled'); }
  });
}
```

（`ApiError` 的錯誤碼放在 `message`——與既有測試 `assert.equal(e.status, 409)` + `e.detail` 慣例一致；本檔統一用 `e.message` 斷言碼。）
import 行補上 `adminBackfillRegistration`。

- [ ] **Step 2: 跑測試確認失敗** — `node tests/admin-group-reg.test.js` → import error（函式不存在），預期紅燈。

- [ ] **Step 3: 實作** — `groupOrderService.js`，`expirePendingOrders` 之後加：

```js
/** admin 補報名：管理者從範本 drawer 為客人補一場報名。
 *  paid=true → 獨立「已核對」訂單＋confirmed（已付款的單不事後長大）；
 *  paid=false → 併入該客人未逾期 pending 單（金額累加、期限取 max(now+72h)），無則開新 72h 單；
 *  滿額：未來場次 → 候補（不收款、不建單）；過去場次 → 409（候補對過去無意義）。
 *  不支援折扣碼；只通知教練（業主定案）。 */
export function adminBackfillRegistration({ sessionId, userId = null, name = null, phone = null, paid = false, actorId }) {
  return tx(() => {
    const s = getSession.get(sessionId);
    if (!s) throw new ApiError(404, 'session_not_found');
    if (s.status === 'cancelled') throw new ApiError(409, 'session_cancelled');
    const tpl = getTemplate.get(s.template_id);
    if (!tpl) throw new ApiError(404, 'template_not_found');

    // 解析客人：userId 優先（僅限一般會員）；否則姓名＋電話（選填）find-or-create，與登錄預約同規則
    let user;
    if (userId) {
      user = db.prepare("SELECT * FROM users WHERE id = ? AND role = 'user'").get(userId);
      if (!user) throw new ApiError(404, 'user_not_found');
    } else {
      const hasPhone = phone != null && String(phone).trim() !== '';
      user = hasPhone ? findOrCreateUserByPhone({ phone: String(phone).trim(), name })
                      : createCustomerNoPhone({ name });
    }

    const dup = getAnyReg.get(sessionId, user.id);
    if (dup && ['pending', 'confirmed', 'waitlisted'].includes(dup.status)) {
      throw new ApiError(409, 'already_registered');
    }

    const now = nowLocal();
    const isPast = s.start_at <= now;
    const price = tpl.price_per_session;

    if (sessionIsFull(sessionId)) {
      if (isPast) throw new ApiError(409, 'session_full');
      if (paid) throw new ApiError(400, 'paid_requires_seat'); // UI 已擋，後端防呆
      let regId;
      if (dup) { reactivateReg.run('waitlisted', null, null, dup.id); regId = dup.id; }
      else regId = insertReg.run(sessionId, user.id, 'waitlisted', null, null).lastInsertRowid;
      notifyCourseCoach({ coachId: s.coach_id, sessionId, type: 'course_waitlisted_coach',
        vars: { member_name: user.name, course_name: tpl.name, start_at: s.start_at } });
      return { ok: true, registrationId: Number(regId), orderId: null, status: 'waitlisted' };
    }

    let orderId, regStatus;
    if (paid) {
      orderId = Number(insertOrder.run(user.id, user.name, user.phone || '', price, now).lastInsertRowid);
      db.prepare("UPDATE group_orders SET status='paid', paid_at=?, paid_by=?, original_amount=? WHERE id=?")
        .run(now, actorId, price, orderId);
      regStatus = 'confirmed';
    } else {
      const existing = db.prepare(
        "SELECT id FROM group_orders WHERE member_id=? AND status='pending' AND expires_at >= ? ORDER BY id DESC LIMIT 1"
      ).get(user.id, now);
      const expiry = offsetLocal(getGroupOrderExpiryHours() * 3600_000);
      if (existing) {
        orderId = existing.id;
        db.prepare(`
          UPDATE group_orders
          SET total_amount = total_amount + ?, original_amount = COALESCE(original_amount, 0) + ?,
              expires_at = MAX(expires_at, ?)
          WHERE id = ?
        `).run(price, price, expiry, orderId);
      } else {
        orderId = Number(insertOrder.run(user.id, user.name, user.phone || '', price, expiry).lastInsertRowid);
        db.prepare('UPDATE group_orders SET original_amount = ? WHERE id = ?').run(price, orderId);
      }
      regStatus = 'pending';
    }

    let regId;
    if (dup) { reactivateReg.run(regStatus, orderId, price, dup.id); regId = dup.id; }
    else regId = insertReg.run(sessionId, user.id, regStatus, orderId, price).lastInsertRowid;

    notifyCourseCoach({ coachId: s.coach_id, sessionId, type: 'course_registered_coach',
      vars: { member_name: user.name, course_name: tpl.name, start_at: fmtMD(s.start_at) } });
    return { ok: true, registrationId: Number(regId), orderId, status: regStatus };
  });
}
```

檔頂 userService import 改為：
`import { findOrCreateUserByPhone, getUserByPhoneAndName, createCustomerNoPhone } from './userService.js';`

- [ ] **Step 4: 跑測試確認通過** — `node tests/admin-group-reg.test.js` 全 ✓。

- [ ] **Step 5: Commit**

```bash
git add src/services/groupOrderService.js tests/admin-group-reg.test.js
git commit -m "$(cat <<'EOF'
service：管理者補報名（已收款獨立成單／待核對併單／滿額候補／過去滿額拒絕）

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
EOF
)"
```

### Task 7: service `adminCancelRegistration`

**Files:**
- Modify: `src/services/groupOrderService.js`（新函式，放在 `adminBackfillRegistration` 之後；discountService import 加 `quoteDiscount`）
- Test: `tests/admin-group-reg.test.js`（追加 §4；import 補 `adminCancelRegistration`）

**Interfaces:**
- Consumes: `quoteDiscount({ code, amount })`（**import 加入**：`import { applyDiscountTx, releaseRedemption, getBankInfo, getLineOfficialUrl, getGroupOrderExpiryHours, quoteDiscount } from './discountService.js';`）、`releaseOrderRedemptionIfInactive`、`promoteWaitlist`、`group_order_refunds` 表。
- Produces: `adminCancelRegistration({ registrationId, actorId, refundAmount=null })` → `{ ok:true }`。錯誤碼：404 `registration_not_found`、409 `not_cancellable`、400 `invalid_refund_amount`。Task 8 路由、Task 10 UI 依賴。

- [ ] **Step 1: 寫失敗測試** — §4 追加：

```js
// ── §4 adminCancelRegistration ────────────────────────────────
reset();
{
  db.prepare("INSERT INTO discount_codes (code, discount_type, discount_value, active) VALUES ('AGRF100','fixed',100,1)").run();
  db.prepare("INSERT INTO discount_codes (code, discount_type, discount_value, active) VALUES ('AGRP10','percent',10,1)").run();
  const tpl = createTemplate({
    name: 'AGR-取消班', min_capacity: 1, max_capacity: 2,
    day_of_week: ((new Date()).getDay() + 2) % 7, start_time: '19:00',
    recurrence: 'weekly', cycle_start_date: dstr(1), cycle_end_date: dstr(40),
    registration_deadline_hours: 1, price_per_session: 500,
  });
  const ss = db.prepare('SELECT id FROM course_sessions WHERE template_id=? ORDER BY start_at ASC').all(tpl.templateId).map((r) => r.id);
  const [sA, sB, sC, sD] = ss;
  const actorId = Number(db.prepare("INSERT INTO users (name, email, role, is_admin) VALUES ('AGR-管理2', 'agr-admin2@x.com', 'coach', 1)").run().lastInsertRowid);
  const regOf = (phone, sid) => db.prepare('SELECT r.* FROM registrations r JOIN users u ON u.id=r.user_id WHERE u.phone=? AND r.session_id=?').get(phone, sid);

  // a) pending 多場訂單取消一場 → 金額重算；固定額折扣重新報價
  const o1 = createGroupOrder({ name: 'AGR-取甲', phone: '0996400001', paySessionIds: [sA, sB], waitlistSessionIds: [], discountCode: 'AGRF100' });
  expect('前置：900（1000-100）', () => assert.equal(db.prepare('SELECT total_amount FROM group_orders WHERE id=?').get(o1.orderId).total_amount, 900));
  adminCancelRegistration({ registrationId: regOf('0996400001', sA).id, actorId });
  expect('pending 取消一場 → 重算 500-100=400', () => {
    const o = db.prepare('SELECT * FROM group_orders WHERE id=?').get(o1.orderId);
    assert.equal(o.original_amount, 500); assert.equal(o.discount_amount, 100); assert.equal(o.total_amount, 400);
    assert.equal(regOf('0996400001', sA).status, 'cancelled');
    assert.equal(regOf('0996400001', sB).status, 'pending');
  });

  // b) 百分比折扣重新報價
  const o2 = createGroupOrder({ name: 'AGR-取乙', phone: '0996400002', paySessionIds: [sC, sD], waitlistSessionIds: [], discountCode: 'AGRP10' });
  adminCancelRegistration({ registrationId: regOf('0996400002', sC).id, actorId });
  expect('percent 取消一場 → 500-10%=450', () => {
    assert.equal(db.prepare('SELECT total_amount FROM group_orders WHERE id=?').get(o2.orderId).total_amount, 450);
  });

  // c) 折扣碼停用 → 折扣歸零（建單時碼有效，取消時已停用）
  const o3 = createGroupOrder({ name: 'AGR-取丙', phone: '0996400003', paySessionIds: [sA, sB], waitlistSessionIds: [], discountCode: 'AGRF100' });
  db.prepare("UPDATE discount_codes SET active=0 WHERE code='AGRF100'").run();
  adminCancelRegistration({ registrationId: regOf('0996400003', sA).id, actorId });
  expect('折扣碼失效 → 折扣歸零、應付=新原價', () => {
    const o = db.prepare('SELECT * FROM group_orders WHERE id=?').get(o3.orderId);
    assert.equal(o.original_amount, 500); assert.equal(o.discount_amount, null); assert.equal(o.total_amount, 500);
  });

  // d) 最後一場取消 → 整單取消＋釋放折扣
  adminCancelRegistration({ registrationId: regOf('0996400001', sB).id, actorId });
  expect('最後一場 → 整單取消、redemption 釋放', () => {
    const o = db.prepare('SELECT * FROM group_orders WHERE id=?').get(o1.orderId);
    assert.equal(o.status, 'cancelled'); assert.ok(o.cancelled_at);
    assert.equal(db.prepare("SELECT COUNT(*) AS c FROM discount_redemptions WHERE kind='group_order' AND ref_id=?").get(o1.orderId).c, 0);
  });

  // e) 已收款訂單取消一場 → 部分退款明細（預設 amount_due；可自訂；驗上限）
  const o4 = createGroupOrder({ name: 'AGR-取丁', phone: '0996400004', paySessionIds: [sC, sD], waitlistSessionIds: [] });
  confirmGroupOrder({ orderId: o4.orderId, actorId });
  adminCancelRegistration({ registrationId: regOf('0996400004', sC).id, actorId });
  expect('paid 取消 → 預設退 amount_due=500、訂單維持 paid、金額不動', () => {
    const rows = db.prepare('SELECT * FROM group_order_refunds WHERE order_id=?').all(o4.orderId);
    assert.equal(rows.length, 1); assert.equal(rows[0].amount, 500); assert.equal(rows[0].refunded_by, actorId);
    const o = db.prepare('SELECT * FROM group_orders WHERE id=?').get(o4.orderId);
    assert.equal(o.status, 'paid'); assert.equal(o.total_amount, 1000); assert.equal(o.refunded_at, null);
  });
  expect('自訂退款金額 300', () => {
    adminCancelRegistration({ registrationId: regOf('0996400004', sD).id, actorId, refundAmount: 300 });
    const rows = db.prepare('SELECT amount FROM group_order_refunds WHERE order_id=? ORDER BY id ASC').all(o4.orderId);
    assert.deepEqual(rows.map((r) => r.amount), [500, 300]);
  });
  expect('退款金額超過原價 → 400 invalid_refund_amount', () => {
    const o5 = createGroupOrder({ name: 'AGR-取戊', phone: '0996400005', paySessionIds: [sA], waitlistSessionIds: [] });
    confirmGroupOrder({ orderId: o5.orderId, actorId });
    try { adminCancelRegistration({ registrationId: regOf('0996400005', sA).id, actorId, refundAmount: 600 }); assert.fail('no throw'); }
    catch (e) { assert.equal(e.status, 400); assert.equal(e.message, 'invalid_refund_amount'); }
  });

  // f) 候補列取消：無金流
  const o6 = createGroupOrder({ name: 'AGR-取己', phone: '0996400006', paySessionIds: [], waitlistSessionIds: [sB] });
  adminCancelRegistration({ registrationId: regOf('0996400006', sB).id, actorId });
  expect('waitlisted 取消 → cancelled、無退款列', () => {
    assert.equal(regOf('0996400006', sB).status, 'cancelled');
    assert.equal(db.prepare('SELECT COUNT(*) AS c FROM group_order_refunds').get().c, 2); // e) 的 500＋300 兩筆；600 那次 400 已 rollback
  });

  // g) 舊資料（order_id NULL 的 confirmed）
  const legacyUid = Number(db.prepare("INSERT INTO users (name, phone, role) VALUES ('AGR-舊', '0996400007', 'user')").run().lastInsertRowid);
  const legacyRegId = Number(db.prepare("INSERT INTO registrations (session_id, user_id, status, order_id, amount_due) VALUES (?, ?, 'confirmed', NULL, NULL)").run(sB, legacyUid).lastInsertRowid);
  adminCancelRegistration({ registrationId: legacyRegId, actorId });
  expect('legacy confirmed → 直接 cancelled', () => {
    assert.equal(db.prepare('SELECT status FROM registrations WHERE id=?').get(legacyRegId).status, 'cancelled');
  });

  // h) 已取消再取消 → 409
  expect('重複取消 → 409 not_cancellable', () => {
    try { adminCancelRegistration({ registrationId: legacyRegId, actorId }); assert.fail('no throw'); }
    catch (e) { assert.equal(e.status, 409); assert.equal(e.message, 'not_cancellable'); }
  });

  // i) 取消釋名額 → 未來場次自動遞補
  // sA 此刻佔用者＝戊(confirmed, e)＋庚(pending, 下行)＝2＝cap → 滿
  const o7 = createGroupOrder({ name: 'AGR-取庚', phone: '0996400008', paySessionIds: [sA], waitlistSessionIds: [] });
  createGroupOrder({ name: 'AGR-取辛', phone: '0996400009', paySessionIds: [], waitlistSessionIds: [sA] });
  adminCancelRegistration({ registrationId: regOf('0996400008', sA).id, actorId });
  expect('取消未來場次 → 候補遞補為 pending＋24h 單', () => {
    const b = regOf('0996400009', sA);
    assert.equal(b.status, 'pending');
    assert.ok(b.order_id);
  });
}
```

- [ ] **Step 2: 跑測試確認失敗** — import error / 未定義，紅燈。

- [ ] **Step 3: 實作**：

```js
/** admin 取消單筆報名（範本 drawer 名單列）。
 *  waitlisted → 直接取消；
 *  pending（掛待核對訂單）→ 取消並重算訂單金額（折扣同碼對新小計重新報價、不動用量；
 *    碼已失效 → 折扣歸零）；最後一場 → 整單取消＋釋放折扣；
 *  confirmed＋訂單已收款 → 取消並寫 group_order_refunds 部分退款
 *    （預設該場 amount_due，可帶 refundAmount 調整，0 ≤ 整數 ≤ amount_due）；訂單維持 paid；
 *  confirmed＋無訂單（舊資料）→ 只標取消。
 *  釋名額後遞補（promoteWaitlist 內建過去場次守門）；只通知教練。 */
export function adminCancelRegistration({ registrationId, actorId, refundAmount = null }) {
  return tx(() => {
    const reg = getReg.get(registrationId);
    if (!reg) throw new ApiError(404, 'registration_not_found');
    if (!['pending', 'confirmed', 'waitlisted'].includes(reg.status)) throw new ApiError(409, 'not_cancellable');
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(reg.user_id);
    const s = getSession.get(reg.session_id);
    const tpl = getTemplate.get(s.template_id);
    const order = reg.order_id ? getOrder.get(reg.order_id) : null;
    const wasOccupying = reg.status === 'confirmed' || reg.status === 'pending';
    const now = nowLocal();

    db.prepare("UPDATE registrations SET status='cancelled' WHERE id=?").run(registrationId);

    if (reg.status === 'pending' && order && order.status === 'pending') {
      const remaining = db.prepare(
        "SELECT COALESCE(SUM(amount_due), 0) AS subtotal, COUNT(*) AS c FROM registrations WHERE order_id=? AND status='pending'"
      ).get(order.id);
      if (remaining.c === 0) {
        // 最後一場付款場次 → 整單取消（掛單候補列維持候補，遞補時會開自己的單）
        db.prepare("UPDATE group_orders SET status='cancelled', cancelled_at=? WHERE id=?").run(now, order.id);
        releaseRedemption({ kind: 'group_order', refId: order.id });
      } else {
        let discountAmount = null, finalTotal = remaining.subtotal;
        if (order.discount_code) {
          try {
            const q = quoteDiscount({ code: order.discount_code, amount: remaining.subtotal });
            if (q) { discountAmount = q.discountAmount; finalTotal = q.finalTotal; }
          } catch { /* 折扣碼已失效/停用 → 折扣歸零，應付=新原價 */ }
        }
        db.prepare('UPDATE group_orders SET original_amount=?, discount_amount=?, total_amount=? WHERE id=?')
          .run(remaining.subtotal, discountAmount, finalTotal, order.id);
      }
    } else if (reg.status === 'confirmed' && order && order.paid_at) {
      let amount = reg.amount_due ?? 0;
      if (refundAmount != null) {
        if (!Number.isInteger(refundAmount) || refundAmount < 0 || refundAmount > (reg.amount_due ?? 0)) {
          throw new ApiError(400, 'invalid_refund_amount');
        }
        amount = refundAmount;
      }
      db.prepare('INSERT INTO group_order_refunds (order_id, registration_id, amount, refunded_at, refunded_by) VALUES (?, ?, ?, ?, ?)')
        .run(order.id, registrationId, amount, now, actorId);
    } else {
      // waitlisted 或 legacy confirmed（order_id NULL / 訂單非 paid）：無金流；整單已無 active 列則釋放折扣
      releaseOrderRedemptionIfInactive(reg.order_id);
    }

    if (wasOccupying) {
      notifyCourseCoach({ coachId: s.coach_id, sessionId: reg.session_id, type: 'course_member_cancelled_coach',
        vars: { member_name: user.name, course_name: tpl.name, start_at: s.start_at } });
      promoteWaitlist(reg.session_id);
    }
    return { ok: true };
  });
}
```

discountService import 行補 `quoteDiscount`。

- [ ] **Step 4: 跑測試確認通過** — `node tests/admin-group-reg.test.js` 全 ✓；回歸 `node tests/discount-group.test.js && node tests/refund.test.js` ✓。

- [ ] **Step 5: Commit**

```bash
git add src/services/groupOrderService.js tests/admin-group-reg.test.js
git commit -m "$(cat <<'EOF'
service：管理者取消單筆報名（pending 重算金額／paid 記部分退款／末場整單取消）

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
EOF
)"
```

### Task 8: 路由＋API 測試

**Files:**
- Modify: `src/server.js`（groupOrderService import 區 `:50-58`；路由加在 `PATCH /api/admin/sessions/:id` 區塊 `:474` 之後）
- Test: `tests/admin-group-reg-api.test.js`（新檔）
- Modify: `package.json:13`（"test:api" 鏈尾端追加 `&& node tests/admin-group-reg-api.test.js`）

**Interfaces:**
- Consumes: Task 6/7 的兩個 service 函式。
- Produces: `POST /api/admin/sessions/:id/registrations`（201，body `{userId?|name+phone?, paid}`）與 `POST /api/admin/registrations/:id/cancel`（body `{refundAmount?}`），皆 requireAdmin。Task 10 UI 呼叫。

- [ ] **Step 1: 路由實作** — import 區（`:50-58` 大括號內）加兩行：

```js
  adminBackfillRegistration as svcAdminBackfillReg,
  adminCancelRegistration as svcAdminCancelReg,
```

`server.js:474`（`PATCH /api/admin/sessions/:id` 的 `}));` 之後）加：

```js
// admin 補報名：從範本 drawer 為客人補一場（paid=true 直接已核對；false 走待核對 72h）
app.post('/api/admin/sessions/:id/registrations', requireAdmin, asyncHandler((req, res) => {
  const { userId, name, phone, paid } = req.body || {};
  res.status(201).json(svcAdminBackfillReg({
    sessionId: Number(req.params.id),
    userId: userId != null ? Number(userId) : null,
    name: name != null ? String(name) : null,
    phone: phone != null ? String(phone) : null,
    paid: paid === true,
    actorId: req.user.id,
  }));
}));

// admin 取消單筆報名（已收款訂單 → 記部分退款，可帶 refundAmount 調整）
app.post('/api/admin/registrations/:id/cancel', requireAdmin, asyncHandler((req, res) => {
  const { refundAmount } = req.body || {};
  res.json(svcAdminCancelReg({
    registrationId: Number(req.params.id),
    actorId: req.user.id,
    refundAmount: refundAmount != null ? Number(refundAmount) : null,
  }));
}));
```

- [ ] **Step 2: 寫 API 測試** — `tests/admin-group-reg-api.test.js`（比照 `tests/refund-api.test.js` 樣式）：

```js
// admin 補報名/取消 API：權限守門＋端到端（補報→roster→取消→部分退款）。
// server 需帶 LINE_MOCK=1 GCAL_MOCK=1 GMAIL_MOCK=1。
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
function expect(label, fn) { try { fn(); console.log(`  ✓ ${label}`); } catch (e) { console.log(`  ✗ ${label}`); console.error(e); process.exitCode = 1; } }
function dstr(days) { const d = new Date(); d.setDate(d.getDate() + days); const p = (n) => String(n).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`; }

console.log('[admin-group-reg-api test] start');
db.exec("DELETE FROM users WHERE phone LIKE '0995%'");

const login = await req('POST', '/api/auth/login', { body: { email: 'admin@chinup.local', password: 'admin1234' } });
const token = login.data?.token;
expect('admin login ok', () => assert.ok(token));

const tplRes = await req('POST', '/api/admin/templates', { token, body: {
  name: 'AGRAPI班', min_capacity: 1, max_capacity: 3,
  day_of_week: ((new Date()).getDay() + 2) % 7, start_time: '19:00',
  recurrence: 'weekly', cycle_start_date: dstr(1), cycle_end_date: dstr(20),
  registration_deadline_hours: 1, price_per_session: 600,
} });
expect('範本建立 201', () => assert.equal(tplRes.status, 201));
const tplId = tplRes.data.templateId;
const tpl = await req('GET', `/api/admin/templates/${tplId}`, { token });
const sid = tpl.data.sessions[0].id;

const noAuth = await req('POST', `/api/admin/sessions/${sid}/registrations`, { body: { name: 'x', paid: false } });
expect('無 token 補報 → 401', () => assert.equal(noAuth.status, 401));

const bf = await req('POST', `/api/admin/sessions/${sid}/registrations`, { token, body: { name: 'AGRAPI客', phone: '0995000001', paid: true } });
expect('補報（已收款）→ 201 confirmed', () => { assert.equal(bf.status, 201); assert.equal(bf.data.status, 'confirmed'); assert.ok(bf.data.orderId); });

const roster = await req('GET', `/api/admin/sessions/${sid}/registrations`, { token });
const row = roster.data.find((r) => r.phone === '0995000001');
expect('roster 出現該客人且帶 order_paid_at', () => { assert.ok(row); assert.equal(row.status, 'confirmed'); assert.ok(row.order_paid_at); });

const dup = await req('POST', `/api/admin/sessions/${sid}/registrations`, { token, body: { name: 'AGRAPI客', phone: '0995000001', paid: false } });
expect('重複補報 → 409', () => assert.equal(dup.status, 409));

const noAuthCancel = await req('POST', `/api/admin/registrations/${row.id}/cancel`);
expect('無 token 取消 → 401', () => assert.equal(noAuthCancel.status, 401));

const cxl = await req('POST', `/api/admin/registrations/${row.id}/cancel`, { token, body: { refundAmount: 200 } });
expect('取消＋部分退款 200', () => assert.equal(cxl.status, 200));
expect('退款明細寫入 200 元', () => {
  const r = db.prepare('SELECT amount FROM group_order_refunds WHERE registration_id=?').get(row.id);
  assert.equal(r.amount, 200);
});
const roster2 = await req('GET', `/api/admin/sessions/${sid}/registrations`, { token });
expect('roster 顯示已取消', () => assert.equal(roster2.data.find((r) => r.id === row.id).status, 'cancelled'));

// 收尾：刪測試範本（cascade 清 sessions/regs；refunds.registration_id → NULL）
const del = await req('DELETE', `/api/admin/templates/${tplId}`, { token });
expect('範本刪除 ok（refund 列 ON DELETE SET NULL 不擋 cascade）', () => assert.equal(del.status, 200));

console.log('[admin-group-reg-api test] done');
```

（注意：`order_paid_at` 欄位由 Task 10 Step 1-3 的 roster JOIN 提供——**先做 Task 10 的 Step 1-3 或把該斷言留待 Task 10 後回頭跑**；建議做法：本任務先寫好測試檔，跑 API 測試放在 Task 10 完成後的 Task 11 統一執行。）

- [ ] **Step 3: 掛 test:api 鏈** — `package.json:13` 尾端追加 `&& node tests/admin-group-reg-api.test.js`。

- [ ] **Step 4: Commit**

```bash
git add src/server.js tests/admin-group-reg-api.test.js package.json
git commit -m "$(cat <<'EOF'
API：POST /api/admin/sessions/:id/registrations 補報名＋POST /api/admin/registrations/:id/cancel 取消（requireAdmin）

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
EOF
)"
```

### Task 9: 已核對區塊顯示部分退款

**Files:**
- Modify: `src/services/bookingService.js:384-393`（`listConfirmedPayments` 團課子查詢）
- Modify: `public/admin.js:1371`（金額 span 追加已退）
- Test: `tests/admin-group-reg.test.js`（追加 §5）

**Interfaces:**
- Consumes: `group_order_refunds`。
- Produces: 已核對清單團課列多 `refund_sum: number` 與 `partial_refund: boolean`（前端 `:1360` 既有 `x.partial_refund` badge 邏輯直接吃到）。

- [ ] **Step 1: 寫失敗測試** — §5 追加：

```js
// ── §5 listConfirmedPayments 部分退款 ─────────────────────────
reset();
{
  const tpl = createTemplate({
    name: 'AGR-對帳班', min_capacity: 1, max_capacity: 3,
    day_of_week: ((new Date()).getDay() + 2) % 7, start_time: '19:00',
    recurrence: 'weekly', cycle_start_date: dstr(1), cycle_end_date: dstr(20),
    registration_deadline_hours: 1, price_per_session: 500,
  });
  const ss = db.prepare('SELECT id FROM course_sessions WHERE template_id=? ORDER BY start_at ASC').all(tpl.templateId).map((r) => r.id);
  const actorId = Number(db.prepare("INSERT INTO users (name, email, role, is_admin) VALUES ('AGR-管理3', 'agr-admin3@x.com', 'coach', 1)").run().lastInsertRowid);
  const o = createGroupOrder({ name: 'AGR-帳甲', phone: '0996500001', paySessionIds: [ss[0], ss[1]], waitlistSessionIds: [] });
  confirmGroupOrder({ orderId: o.orderId, actorId });
  const reg = db.prepare('SELECT r.* FROM registrations r JOIN users u ON u.id=r.user_id WHERE u.phone=? AND r.session_id=?').get('0996500001', ss[0]);
  adminCancelRegistration({ registrationId: reg.id, actorId, refundAmount: 300 });
  expect('listConfirmedPayments 團課列帶 refund_sum/partial_refund', () => {
    const row = listConfirmedPayments().find((x) => x.type === 'group_order' && x.id === o.orderId);
    assert.equal(row.refund_sum, 300);
    assert.equal(row.partial_refund, true);
    assert.equal(row.amount, 1000);
    assert.equal(row.refunded_at, null);
  });
  refundGroupOrder({ orderId: o.orderId, actorId });
  expect('整單退款後 partial_refund=false（已退款 badge 優先）', () => {
    const row = listConfirmedPayments().find((x) => x.type === 'group_order' && x.id === o.orderId);
    assert.ok(row.refunded_at);
    assert.equal(row.partial_refund, false);
  });
}
```

- [ ] **Step 2: 跑測試確認失敗** — `refund_sum` undefined，✗。

- [ ] **Step 3: 實作** — `bookingService.js` 團課子查詢改為：

```js
  const orders = db.prepare(`
    SELECT 'group_order' AS type, o.id, o.customer_name, o.customer_phone,
           o.total_amount AS amount,
           (SELECT COUNT(*) FROM registrations r WHERE r.order_id = o.id AND r.amount_due IS NOT NULL) || ' 場次' AS detail,
           NULL AS session_type, o.paid_at, o.refunded_at, pu.name AS paid_by_name,
           (SELECT COALESCE(SUM(gr.amount), 0) FROM group_order_refunds gr WHERE gr.order_id = o.id) AS refund_sum
    FROM group_orders o
    LEFT JOIN users pu ON pu.id = o.paid_by
    WHERE o.paid_at IS NOT NULL
    ORDER BY o.paid_at DESC LIMIT 50
  `).all().map((o) => ({ ...o, partial_refund: !o.refunded_at && o.refund_sum > 0 }));
```

`public/admin.js:1371` 金額 span 內容改為：

```js
${x.amount != null ? 'NT$' + Number(x.amount).toLocaleString() : '—'}${x.refund_sum > 0 ? ' · 已退 NT$' + Number(x.refund_sum).toLocaleString() : ''}
```

（`部分退款` badge 免改——`:1360` 既有 `x.partial_refund` 條件直接生效。）

- [ ] **Step 4: 跑測試確認通過** — `node tests/admin-group-reg.test.js` 全 ✓。

- [ ] **Step 5: Commit**

```bash
git add src/services/bookingService.js public/admin.js tests/admin-group-reg.test.js
git commit -m "$(cat <<'EOF'
已核對匯款：團課列顯示部分退款（已退 NT$ 小計＋部分退款 badge）

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
EOF
)"
```

### Task 10: 範本 drawer UI — 補報名面板＋取消鈕

**Files:**
- Modify: `src/services/courseService.js`（`getTemplate:125-135` 加 `occupied`；`listRegistrationsBySession:163-171` 加訂單 JOIN）
- Modify: `public/admin.js`（`openDrawer:338-399` 重構＋新增 `renderRoster`/`reloadRoster`/`refreshSessionSummary`/`openBackfillPanel`/`localNowStr`；委派 handler `:404-425` 擴充）
- Modify: `public/admin.html`（`:393` `</style>` 前加面板 CSS）
- Test: `tests/admin-group-reg.test.js`（§6 伺服器欄位斷言）

**Interfaces:**
- Consumes: Task 8 的兩個端點、既有 `GET /api/coach/customers/search`（管理者 role=coach 可過 requireCoach）、`GET /api/admin/templates/:id`、`GET /api/admin/sessions/:id/registrations`。
- Produces: `getTemplate().sessions[i].occupied`（滿額提示用）；roster 列多 `order_paid_at`/`order_refunded_at`（退款提示用）。

- [ ] **Step 1: 寫失敗測試** — §6 追加：

```js
// ── §6 drawer 伺服器欄位（occupied / order_paid_at）──────────
reset();
{
  const tpl = createTemplate({
    name: 'AGR-欄位班', min_capacity: 1, max_capacity: 2,
    day_of_week: ((new Date()).getDay() + 2) % 7, start_time: '19:00',
    recurrence: 'weekly', cycle_start_date: dstr(1), cycle_end_date: dstr(15),
    registration_deadline_hours: 1, price_per_session: 500,
  });
  const sid = db.prepare('SELECT id FROM course_sessions WHERE template_id=? ORDER BY start_at ASC').get(tpl.templateId).id;
  const actorId = Number(db.prepare("INSERT INTO users (name, email, role, is_admin) VALUES ('AGR-管理4', 'agr-admin4@x.com', 'coach', 1)").run().lastInsertRowid);
  const o = createGroupOrder({ name: 'AGR-欄甲', phone: '0996600001', paySessionIds: [sid], waitlistSessionIds: [] });
  expect('getTemplate sessions 帶 occupied（含未逾期 pending）', () => {
    const t = getTemplate(tpl.templateId);
    const s = t.sessions.find((x) => x.id === sid);
    assert.equal(s.occupied, 1);       // pending 未逾期 → 佔位
    assert.equal(s.confirmed_count, 0); // 正取仍 0
  });
  confirmGroupOrder({ orderId: o.orderId, actorId });
  expect('roster 列帶 order_paid_at / order_refunded_at', () => {
    const rows = listRegistrationsBySession(sid);
    const row = rows.find((r) => r.phone === '0996600001');
    assert.ok(row.order_paid_at);
    assert.equal(row.order_refunded_at, null);
  });
}
```

（檔頂 courseService import 擴充為：`import { createTemplate, getTemplate, listRegistrationsBySession } from '../src/services/courseService.js';`）

- [ ] **Step 2: 跑測試確認失敗** — `occupied`/`order_paid_at` undefined，✗。

- [ ] **Step 3: 伺服器實作** — `courseService.js`：

`:119`（`liveWaitlistCount`）之後加：

```js
// 補報名 UI 滿額判定用：與 groupOrderService.occupiedStmt 同口徑
// （confirmed 一律算；pending 只在其訂單未逾期時算；不 import 避免服務間耦合）
const liveOccupiedCount = db.prepare(`
  SELECT COUNT(*) AS c
  FROM registrations r
  LEFT JOIN group_orders o ON o.id = r.order_id
  WHERE r.session_id = ? AND r.on_leave = 0
    AND ( r.status = 'confirmed'
          OR (r.status = 'pending' AND o.id IS NOT NULL AND o.expires_at >= ?) )
`);
```

`getTemplate` 改為：

```js
export function getTemplate(id) {
  const t = db.prepare('SELECT * FROM course_templates WHERE id = ?').get(id);
  if (!t) throw new ApiError(404, 'template_not_found');
  const now = nowLocal();
  // 即時計算正取/候補人數（覆蓋可能過時的快取欄位）＋佔位數（滿額判定含未逾期 pending）。
  t.sessions = listSessionsForTemplate.all(id).map((s) => ({
    ...s,
    confirmed_count: liveConfirmedCount.get(s.id).c,
    waitlist_count: liveWaitlistCount.get(s.id).c,
    occupied: liveOccupiedCount.get(s.id, now).c,
  }));
  return t;
}
```

`listRegistrationsBySession` 改為：

```js
export function listRegistrationsBySession(sessionId) {
  return db.prepare(`
    SELECT r.*, u.name AS user_name, u.email, u.phone,
           o.paid_at AS order_paid_at, o.refunded_at AS order_refunded_at
    FROM registrations r
    JOIN users u ON u.id = r.user_id
    LEFT JOIN group_orders o ON o.id = r.order_id
    WHERE r.session_id = ?
    ORDER BY r.registered_at DESC, r.id DESC
  `).all(sessionId);
}
```

- [ ] **Step 4: 跑測試確認通過** — `node tests/admin-group-reg.test.js` 全 ✓；回歸 `node tests/admin-session-counts.test.js` ✓。Commit（伺服器半場）：

```bash
git add src/services/courseService.js tests/admin-group-reg.test.js
git commit -m "$(cat <<'EOF'
drawer 資料強化：getTemplate 帶 occupied、roster 帶訂單付款/退款時間

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
EOF
)"
```

- [ ] **Step 5: admin.html 面板 CSS** — `:393` `</style>` 之前加：

```css
/* ── 範本 drawer：補報名面板 ── */
.backfill-panel { border: 1px solid #e2e8f0; background: #f8fafc; padding: 12px; margin: 8px 0 10px; }
.backfill-panel .form-input { width: 100%; margin-bottom: 8px; }
.bf-results { max-height: 180px; overflow-y: auto; margin-bottom: 6px; }
.bf-result { display: block; width: 100%; text-align: left; padding: 6px 8px; border: 0; background: transparent; cursor: pointer; font-size: 14px; }
.bf-result:hover { background: #eff6ff; }
.bf-paid-row { display: flex; align-items: center; gap: 6px; font-size: 14px; margin: 4px 0; }
```

- [ ] **Step 6: admin.js drawer 改寫** — 依序：

(6a) `openDrawer` 上方（`:337` 附近）加模組狀態與工具：

```js
let drawerTemplateId = null;
const drawerSessions = new Map(); // sid → { start_at, occupied, max }

function localNowStr() {
  const p = (n) => String(n).padStart(2, '0');
  const d = new Date();
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}
```

(6b) `openDrawer` 內：開頭 `drawerTemplateId = templateId; drawerSessions.clear();`；sessions map 前逐場 `drawerSessions.set(s.id, { start_at: s.start_at, occupied: s.occupied, max: t.max_capacity });`。summary 模板改為（右側包一層、count 行加 class 與 data 屬性）：

```js
    c.innerHTML = t.sessions.map(s => {
      drawerSessions.set(s.id, { start_at: s.start_at, occupied: s.occupied, max: t.max_capacity });
      return `
      <details class="session-row">
        <summary>
          <div>
            <div class="font-semibold">${fmtDate(s.start_at)}</div>
            <div class="subtle mt-1 session-counts" data-session-id="${s.id}">正取 ${s.confirmed_count}/${t.max_capacity} · 候補 ${s.waitlist_count}</div>
          </div>
          <div class="flex items-center gap-2">
            ${s.status !== 'cancelled' ? `<button type="button" class="badge badge-confirmed session-backfill" data-session-id="${s.id}" title="為客人補此場報名">補報名</button>` : ''}
            ${s.status === 'open'
              ? `<button type="button" class="badge ${s.is_open === 0 ? 'badge-closed' : 'badge-open'} session-toggle" data-session-id="${s.id}" data-open="${s.is_open === 0 ? '0' : '1'}" title="點擊切換開放／關閉此場次">${s.is_open === 0 ? '關閉' : '開放'}</button>`
              : `<span class="badge badge-${s.status}">${SESSION_STATUS_LABEL[s.status]}</span>`}
          </div>
        </summary>
        <div class="px-5 pb-4 session-roster" data-session-id="${s.id}">
          <div class="subtle">載入中…</div>
        </div>
      </details>`;
    }).join('');
```

(6c) 抽出 `renderRoster` 並讓 toggle handler 用它（取代 `:375-389` 的 inline map）：

```js
function renderRoster(inner, list) {
  if (!list.length) { inner.innerHTML = '<div class="subtle py-2">尚無人報名</div>'; inner.dataset.loaded = '1'; return; }
  inner.innerHTML = list.map(r => {
    const inactive = r.status === 'cancelled' || r.status === 'rejected';
    const cancellable = ['pending', 'confirmed', 'waitlisted'].includes(r.status);
    const needsRefund = r.status === 'confirmed' && r.order_paid_at && !r.order_refunded_at;
    return `
    <div class="reg-row"${inactive ? ' style="opacity:.45"' : ''}>
      <div>
        <div class="font-medium">${escapeHtml(r.user_name)}</div>
        <div class="subtle text-xs">${escapeHtml(r.email || r.phone || '')}</div>
      </div>
      <div class="flex items-center gap-2">
        <span class="badge badge-${r.status}">${REG_STATUS_LABEL[r.status] || r.status}</span>
        ${r.position ? `<span class="subtle text-xs">#${r.position}</span>` : ''}
        ${cancellable ? `<button type="button" class="badge badge-cancelled reg-cancel" data-reg-id="${r.id}" data-user-name="${escapeHtml(r.user_name)}" data-needs-refund="${needsRefund ? '1' : '0'}" data-amount-due="${r.amount_due ?? ''}">取消</button>` : ''}
      </div>
    </div>`;
  }).join('');
  inner.dataset.loaded = '1';
}

async function reloadRoster(sid) {
  const inner = document.querySelector(`#drawer-content .session-roster[data-session-id="${sid}"]`);
  if (!inner) return;
  const list = await api(`/api/admin/sessions/${sid}/registrations`);
  renderRoster(inner, list);
}

async function refreshSessionSummary(sid) {
  try {
    const t = await api(`/api/admin/templates/${drawerTemplateId}`);
    const s = t.sessions.find(x => x.id === sid);
    if (!s) return;
    drawerSessions.set(sid, { start_at: s.start_at, occupied: s.occupied, max: t.max_capacity });
    const el = document.querySelector(`#drawer-content .session-counts[data-session-id="${sid}"]`);
    if (el) el.textContent = `正取 ${s.confirmed_count}/${t.max_capacity} · 候補 ${s.waitlist_count}`;
  } catch { /* 摘要刷新失敗不阻斷主流程 */ }
}
```

toggle handler（`:365-394`）內原本組 roster HTML 的段落換成：

```js
        try {
          const list = await api(`/api/admin/sessions/${sid}/registrations`);
          renderRoster(inner, list);
        } catch (e) {
          inner.innerHTML = `<div class="text-red-500 py-2">名單載入失敗：${escapeHtml(e.message)}</div>`;
        }
```

(6d) 補報名面板：

```js
function openBackfillPanel(sid) {
  const inner = document.querySelector(`#drawer-content .session-roster[data-session-id="${sid}"]`);
  if (!inner) return;
  const det = inner.closest('details');
  det.open = true;
  document.querySelectorAll('.backfill-panel').forEach(p => p.remove()); // 同時只開一個
  const meta = drawerSessions.get(sid) || {};
  const isPast = meta.start_at ? meta.start_at <= localNowStr() : false;
  const isFull = meta.occupied >= meta.max;

  const panel = document.createElement('div');
  panel.className = 'backfill-panel';
  panel.dataset.sessionId = sid;
  panel.innerHTML = `
    <div class="font-semibold mb-2">補報名</div>
    <div class="bf-mode-search">
      <input type="search" class="form-input bf-search" placeholder="搜尋既有客人（姓名或電話）…" autocomplete="off">
      <div class="bf-results"></div>
      <button type="button" class="btn btn-ghost btn-sm bf-show-new">＋ 新增客人</button>
    </div>
    <div class="bf-mode-new" style="display:none;">
      <input type="text" class="form-input bf-name" placeholder="姓名（必填）">
      <input type="tel" class="form-input bf-phone" placeholder="電話（選填，之後可於會員管理補）">
      <button type="button" class="btn btn-ghost btn-sm bf-show-search">← 改搜尋既有客人</button>
    </div>
    <div class="bf-chosen subtle text-sm" style="display:none;"></div>
    <label class="bf-paid-row"><input type="checkbox" class="bf-paid"> 已收款（直接列入已核對匯款）</label>
    <div class="bf-hint subtle text-xs"></div>
    <div class="flex gap-2 mt-2">
      <button type="button" class="btn btn-primary btn-sm bf-submit">送出補報名</button>
      <button type="button" class="btn btn-ghost btn-sm bf-close">關閉</button>
    </div>`;
  inner.parentNode.insertBefore(panel, inner);

  const hint = panel.querySelector('.bf-hint');
  const paidCb = panel.querySelector('.bf-paid');
  const submitBtn = panel.querySelector('.bf-submit');
  if (isFull && isPast) { hint.textContent = '此場已滿且已結束，無法補報名。'; submitBtn.disabled = true; }
  else if (isFull) { hint.textContent = '此場已滿：送出後將列為候補（不收款）。'; paidCb.checked = false; paidCb.disabled = true; }
  else if (isPast) { hint.textContent = '此場已結束：補登歷史報名。'; }

  panel.querySelector('.bf-show-new').addEventListener('click', () => {
    panel.querySelector('.bf-mode-search').style.display = 'none';
    panel.querySelector('.bf-mode-new').style.display = '';
    delete panel.dataset.userId;
    panel.querySelector('.bf-chosen').style.display = 'none';
  });
  panel.querySelector('.bf-show-search').addEventListener('click', () => {
    panel.querySelector('.bf-mode-new').style.display = 'none';
    panel.querySelector('.bf-mode-search').style.display = '';
  });
  panel.querySelector('.bf-close').addEventListener('click', () => panel.remove());

  let searchTimer = null;
  const resultsEl = panel.querySelector('.bf-results');
  panel.querySelector('.bf-search').addEventListener('input', (ev) => {
    clearTimeout(searchTimer);
    const q = ev.target.value.trim();
    if (!q) { resultsEl.innerHTML = ''; return; }
    searchTimer = setTimeout(async () => {
      try {
        const list = await api(`/api/coach/customers/search?q=${encodeURIComponent(q)}`);
        resultsEl.innerHTML = list.length
          ? list.map(u => `<button type="button" class="bf-result" data-user-id="${u.id}" data-name="${escapeHtml(u.name)}">${escapeHtml(u.name)}<span class="subtle text-xs">　${escapeHtml(u.phone || '無電話')}</span></button>`).join('')
          : '<div class="subtle text-xs" style="padding:6px 8px;">查無客人，可點「＋ 新增客人」</div>';
        resultsEl.querySelectorAll('.bf-result').forEach(btn => btn.addEventListener('click', () => {
          panel.dataset.userId = btn.dataset.userId;
          const chosen = panel.querySelector('.bf-chosen');
          chosen.textContent = `已選：${btn.dataset.name}`;
          chosen.style.display = '';
          resultsEl.innerHTML = '';
        }));
      } catch { resultsEl.innerHTML = '<div class="text-red-500 text-xs">搜尋失敗</div>'; }
    }, 250);
  });

  submitBtn.addEventListener('click', async () => {
    const paid = paidCb.checked;
    let body;
    if (panel.dataset.userId) body = { userId: Number(panel.dataset.userId), paid };
    else {
      const name = panel.querySelector('.bf-name').value.trim();
      const phone = panel.querySelector('.bf-phone').value.trim();
      if (!name) { toast('請先選擇客人，或切到「新增客人」填寫姓名', 'error'); return; }
      body = { name, phone: phone || null, paid };
    }
    submitBtn.disabled = true;
    try {
      const r = await api(`/api/admin/sessions/${sid}/registrations`, { method: 'POST', body });
      toast(r.status === 'waitlisted' ? '此場已滿，已列為候補' : paid ? '補報名完成（已收款）' : '補報名完成（待核對匯款）', 'success');
      panel.remove();
      await reloadRoster(sid);
      refreshSessionSummary(sid);
      loadPendingOrders(); loadConfirmedPayments();
    } catch (e) {
      const msgs = { already_registered: '此客人已報名過本場次', session_full: '此場已滿（過去場次不可候補）', paid_requires_seat: '已滿場次只能候補，不能標已收款', session_cancelled: '未開課場次不可補報名', phone_unavailable: '此電話屬員工帳號，不可用於報名', invalid_phone: '電話格式不正確（8–15 碼數字）', missing_name: '請填寫姓名', user_not_found: '找不到此客人' };
      toast(msgs[e.data?.error] || `補報名失敗：${escapeHtml(e.message)}`, 'error');
      submitBtn.disabled = false;
    }
  });
}
```

(6e) 委派 handler（`:404` 既有 `drawer-content` click listener）最上方加兩段（`.session-toggle` 段保留）：

```js
document.getElementById('drawer-content').addEventListener('click', async (e) => {
  const bfBtn = e.target.closest('.session-backfill');
  if (bfBtn) {
    e.preventDefault(); e.stopPropagation();
    openBackfillPanel(Number(bfBtn.dataset.sessionId));
    return;
  }
  const cbtn = e.target.closest('.reg-cancel');
  if (cbtn) {
    e.preventDefault(); e.stopPropagation();
    if (cbtn.disabled) return;
    const regId = Number(cbtn.dataset.regId);
    const sid = Number(cbtn.closest('.session-roster').dataset.sessionId);
    const body = {};
    if (cbtn.dataset.needsRefund === '1') {
      const def = cbtn.dataset.amountDue || '0';
      const input = prompt(`此報名所屬訂單已收款。\n取消「${cbtn.dataset.userName}」並記錄部分退款，金額 NT$（預設為該場原價，可修改）：`, def);
      if (input === null) return;
      const amt = Number(String(input).trim());
      if (!Number.isInteger(amt) || amt < 0) { toast('退款金額需為 0 以上整數', 'error'); return; }
      body.refundAmount = amt;
    } else if (!confirm(`確定取消「${cbtn.dataset.userName}」的此場報名？`)) return;
    cbtn.disabled = true;
    try {
      await api(`/api/admin/registrations/${regId}/cancel`, { method: 'POST', body });
      toast('已取消報名', 'success');
      await reloadRoster(sid);
      refreshSessionSummary(sid);
      loadPendingOrders(); loadConfirmedPayments();
    } catch (err) {
      const msgs = { registration_not_found: '找不到報名', not_cancellable: '此報名狀態不可取消', invalid_refund_amount: '退款金額需為 0～該場原價的整數' };
      toast(msgs[err.data?.error] || `取消失敗：${escapeHtml(err.message)}`, 'error');
      cbtn.disabled = false;
    }
    return;
  }
  const btn = e.target.closest('.session-toggle');
  if (!btn) return;
  /* …既有 toggle 邏輯不動… */
});
```

- [ ] **Step 7: 手動驗證**

```bash
npm run seed
LINE_MOCK=1 GCAL_MOCK=1 GMAIL_MOCK=1 npm start   # http://localhost:3000/admin.html（admin@chinup.local / admin1234）
```

檢查清單：課程頁點範本開 drawer → 每場有「補報名」；搜尋既有客人補報（待核對）→ 名單即時出現「待付款」、待核對區塊出現訂單卡；「已收款」補報 → 名單「正取」、已核對區塊出現；同客人再補第二場（待核對）→ 待核對卡片同一張、金額累加；滿額場次 → 提示候補、已收款勾選鎖住；取消待付款 → 卡片金額縮減/整卡消失；取消已收款正取 → prompt 預填原價、已核對卡出現「部分退款」badge＋「已退 NT$」；候補在取消後自動遞補（未來場次）。

- [ ] **Step 8: Commit**

```bash
git add public/admin.js public/admin.html
git commit -m "$(cat <<'EOF'
範本 drawer：補報名面板（搜尋/新增客人＋已收款勾選）＋名單列取消鈕（含部分退款 prompt）

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
EOF
)"
```

### Task 11: PR-B 全套測試＋push＋draft PR

- [ ] **Step 1: 全套 unit** — `npm test` 全 ✓。

- [ ] **Step 2: API 測試**

```bash
LINE_MOCK=1 GCAL_MOCK=1 GMAIL_MOCK=1 node --env-file-if-exists=.env src/server.js & SVPID=$!
sleep 2 && node tests/admin-group-reg-api.test.js && node tests/refund-api.test.js && node tests/public-api.test.js; kill $SVPID
```
Expected: 全 ✓（全套 `npm run test:api` 亦可，較久）。

- [ ] **Step 3: `npm run seed`**（清完測試資料補 demo）。

- [ ] **Step 4: Push＋開 draft PR**

```bash
git push -u origin feature/admin-group-backfill
TOKEN=$(printf 'protocol=https\nhost=github.com\n\n' | git credential fill | sed -n 's/^password=//p')
curl -s -X POST https://api.github.com/repos/tamiyame/chinup-fitness-system/pulls \
  -H "Authorization: token $TOKEN" -H "Accept: application/vnd.github+json" \
  -d @- <<'EOF'
{"title":"後台範本彈窗：補報名／取消單筆報名（連動待核對/已核對＋部分退款明細）","head":"feature/admin-group-backfill","base":"main","draft":true,
"body":"## 摘要\n- 範本 drawer 每場次「補報名」：搜尋既有客人或就地新增（電話選填）；「已收款」→ 獨立已核對訂單；未勾 → 待核對訂單（可併入該客人未逾期 pending 單，期限取 max(now+72h)）；滿額 → 候補（不收款）；過去場次滿額拒絕\n- 名單列「取消」：待付款 → 訂單金額重算（折扣同碼重新報價、末場整單取消＋釋放折扣）；已收款 → 寫入 `group_order_refunds` 部分退款（預設該場原價、prompt 可改）；已核對區塊顯示「部分退款」badge＋已退小計\n- 修：`promoteWaitlist` 不再遞補已開始/已結束場次（整單退款/逾期釋出同受保護）\n- 通知只發教練（重用既有 templates）；客人不通知（業主定案）\n\n## Migration\n- 新表 `group_order_refunds`（additive、開機自動建；registration_id ON DELETE SET NULL 不擋範本刪除 cascade）\n\n## 測試\n- `tests/admin-group-reg.test.js`（migration／守門／補報 10 情境／取消 9 情境／對帳欄位）\n- `tests/admin-group-reg-api.test.js`（401 守門＋端到端）\n\n## Spec\n`docs/superpowers/specs/2026-07-12-group-past-sessions-admin-backfill-design.md`（在 PR-A 分支）\n\n⚠️ 與 PR-A 同時改了 package.json 測試鏈同一行，後合併者需先 rebase main。\n\n🤖 Generated with [Claude Code](https://claude.com/claude-code)"}
EOF
```

- [ ] **Step 5: 業主手動 smoke**（Task 10 Step 7 清單）→ 通過後 ready for review → squash merge（先 push 再 merge；若 PR-A 已先合，本分支先 `git rebase origin/main` 解 package.json 測試鏈衝突）。

- [ ] **Step 6: 清 worktree**（兩 PR 都合併後）：`git worktree remove ~/projects/chinup-wt-admin-backfill`。
