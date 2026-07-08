# 登錄預約全覽教練配色 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 「全部教練」週曆各教練時間塊塗管理者指定色（Google 24 色盤）；後台教練管理設色；單教練模式與教練個人視角不變。

**Spec:** `docs/superpowers/specs/2026-07-08-register-week-colors-design.md`（色卡 24 hex 以 spec 為準）

## Global Constraints

- 顏色驗證：值 ∈ COACH_COLORS 或 null/''（清除）→ 否則 400 `invalid_color`；DB 存原 hex 字串或 NULL。
- 週曆上色**只在 isAll**；`coach_color` 為 NULL 的塊維持現行樣式。
- commit message 結尾：`Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`。

---

### Task 1: 後端（欄位遷移＋色卡＋PATCH＋週資料＋測試）

**Files:**
- Modify: `src/db/schema.js`（coaches CREATE TABLE 加 `color TEXT,`——放 `sort_order` 之後）
- Modify: `src/db/connection.js`（既有 addColumnIfMissing 呼叫群加 `addColumnIfMissing('coaches', 'color', 'TEXT');`）
- Modify: `src/services/coachService.js`（`COACH_COLORS` export＋`updateCoach` 支援 color）
- Modify: `src/server.js`（PATCH /api/admin/coaches/:id 接 color；確認 GET /api/admin/coaches 的 SELECT 含 color）
- Test: `tests/coach-color.test.js`（新檔，npm test 鏈）＋ `package.json`

**Interfaces:**
- Produces: `coaches.color`；`COACH_COLORS`（24 hex，順序照 spec）；`PATCH /api/admin/coaches/:id` body 可帶 `color`；`GET /api/admin/coaches` 每列含 `color`；week API bookings 含 `coach_color`。

- [ ] **Step 1: 遷移**（schema.js＋connection.js 各一行，照上）

- [ ] **Step 2: coachService.js**

檔頂附近加（hex 陣列逐字照 spec 的 COACH_COLORS 區塊，含 Google 色名註解）：

```js
/** Google 日曆官方 24 色盤（登錄預約全覽的教練配色；順序照後台色卡排版）。 */
export const COACH_COLORS = [ /* …spec 的 24 hex 照抄… */ ];
```

`updateCoach(id, fields)` 加 color 處理（先讀現行實作的部分更新語意，照同模式）：

```js
  // color：undefined=不動；null/'' = 清除；其餘須在 COACH_COLORS 內
  if (fields.color !== undefined) {
    const c = fields.color === '' ? null : fields.color;
    if (c !== null && !COACH_COLORS.includes(c)) throw new ApiError(400, 'invalid_color');
    // …併入該函式現行的 UPDATE 欄位組裝…
  }
```

- [ ] **Step 3: server.js PATCH 接 color**

`const { display_name, specialty, bio, sort_order, is_active } = req.body || {};` 加 `color`；`svcUpdateCoach(id, { …, color })`。並確認 `GET /api/admin/coaches`（server.js:671 附近）回傳含 `color`（該查詢若列舉欄位需補 `c.color`；`SELECT c.*` 則已含）。

- [ ] **Step 4: coachCalendarService.js `BK_COLS` 加 `c.color AS coach_color`**

- [ ] **Step 5: 寫 `tests/coach-color.test.js`**（service 直連：updateCoach 合法/非法/清除；getCoachWeek all 模式 bookings 帶 coach_color 正確與 NULL；資料 `cc-%` 前綴、2036 年、開頭清理結尾還原）＋掛 `npm test` 鏈

- [ ] **Step 6: 跑測試（新檔＋`node tests/coach-week-all.test.js` 回歸）＋ commit**

```bash
git commit -m "feat: 教練行事曆顏色欄位與色卡（Google 24 色、PATCH 驗證、週資料帶色）"
```

---

### Task 2: 前端（後台色卡 UI＋全覽週曆上色）

**Files:**
- Modify: `public/admin.js`（`loadCoachMgmt`，約 1006-1040 行）
- Modify: `public/coach.js`（週格渲染 `.reg-bk` 一行，約 630 行）
- Modify: `public/style.css`（reg 區塊）

**Interfaces:**
- Consumes: Task 1 全部。

- [ ] **Step 1: admin.js 色卡（COACH_COLORS 前端鏡像常數＋swatch UI）**

`loadCoachMgmt` 上方加：

```js
// Google 日曆 24 色盤（與後端 coachService.COACH_COLORS 一致；順序＝色卡排版）
const COACH_COLORS = [ /* …同 spec 24 hex… */ ];
```

每列改為（左側加顏色鈕；row.innerHTML 開頭）：

```js
      <button data-id="${c.id}" class="coach-color-dot${c.color ? '' : ' coach-color-none'}" title="行事曆顏色"
              style="${c.color ? `background:${c.color};` : ''}"></button>
```

列後加隱藏面板（appendChild row 之後同層插入）：

```js
    const panel = document.createElement('div');
    panel.className = 'coach-color-panel hidden';
    panel.dataset.for = c.id;
    panel.innerHTML = `
      <div class="coach-color-grid">
        ${COACH_COLORS.map(col => `<button class="coach-color-opt${c.color === col ? ' is-current' : ''}" data-id="${c.id}" data-color="${col}" style="background:${col};" title="${col}">${c.color === col ? '✓' : ''}</button>`).join('')}
      </div>
      <button class="btn btn-ghost btn-sm coach-color-default" data-id="${c.id}">預設（不指定）</button>`;
    wrap.appendChild(panel);
```

事件（loadCoachMgmt 尾端既有 querySelectorAll 群旁）：

```js
  wrap.querySelectorAll('.coach-color-dot').forEach(b => b.addEventListener('click', () => {
    const p = wrap.querySelector(`.coach-color-panel[data-for="${b.dataset.id}"]`);
    const wasHidden = p.classList.contains('hidden');
    wrap.querySelectorAll('.coach-color-panel').forEach(x => x.classList.add('hidden'));
    if (wasHidden) p.classList.remove('hidden');
  }));
  const setColor = async (id, color) => {
    await api(`/api/admin/coaches/${id}`, { method: 'PATCH', body: { color } });
    toast('顏色已更新', 'success');
    loadCoachMgmt();
  };
  wrap.querySelectorAll('.coach-color-opt').forEach(b => b.addEventListener('click', () => setColor(b.dataset.id, b.dataset.color)));
  wrap.querySelectorAll('.coach-color-default').forEach(b => b.addEventListener('click', () => setColor(b.dataset.id, null)));
```

- [ ] **Step 2: coach.js 全覽上色（週格 `.reg-bk` 那行）**

```js
          const colored = isAll && b.coach_color;
          const style = colored ? ` style="background:${escapeHtml(b.coach_color)};"` : '';
          return `<div class="reg-bk${colored ? ' reg-bk-colored' : ''}" data-bk="${b.id}"${style}>${escapeHtml(b.member_name)} <span class="reg-sub">${tag}</span>${coachLbl}</div>`;
```

（`isAll` 已存在於該 scope；只動這一個 template。）

- [ ] **Step 3: style.css（reg 區塊附近）**

```css
.reg-bk-colored{color:#fff;}
.reg-bk-colored .reg-sub{color:rgba(255,255,255,.85);}
.reg-bk-colored:hover{filter:brightness(.92);}
/* 後台教練色卡 */
.coach-color-dot{width:22px;height:22px;border-radius:50%;border:2px solid var(--line);flex:none;cursor:pointer;}
.coach-color-dot.coach-color-none{background:#fff;position:relative;}
.coach-color-dot.coach-color-none::after{content:"";position:absolute;inset:4px;border-radius:50%;border:2px solid #93c5fd;}
.coach-color-panel{margin:-4px 0 10px;padding:12px;border:1px solid var(--line);border-radius:12px;background:#fff;}
.coach-color-grid{display:grid;grid-template-columns:repeat(13,26px);gap:8px;margin-bottom:10px;}
.coach-color-opt{width:26px;height:26px;border-radius:50%;border:none;cursor:pointer;color:#fff;font-size:13px;font-weight:800;line-height:1;}
.coach-color-opt:hover{transform:scale(1.15);}
@media (max-width:640px){.coach-color-grid{grid-template-columns:repeat(8,26px);}}
```

（現行 `.reg-bk` 若以 CSS 指定 background，inline style 特異度較高會正確覆蓋；hover 若有 background 變化，`.reg-bk-colored:hover` 的 filter 方案避免蓋回原色——實作時看現行 `.reg-bk:hover` 調整。）

- [ ] **Step 4: Playwright 驗證＋commit**

```bash
# demo：後台教練管理給王教練設 #039BE5 →
#   登錄預約「全部教練」：王教練塊 style 含 #039BE5、class 含 reg-bk-colored；未設色教練塊無
#   單教練模式（選王教練）：塊無 inline background（不上色）
#   後台色卡：當前色打勾、按「預設」清除後圓點變空心；0 pageerror
git commit -m "feat: 全覽週曆教練配色 UI（後台色卡＋時間塊上色）"
```

---

## 收尾（controller）

全套測試＋re-seed → 小型 review → push + draft PR + preview smoke。
