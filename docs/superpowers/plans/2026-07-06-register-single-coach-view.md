# 登錄預約週曆：選個別教練只顯示該教練 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 管理者在登錄預約選個別教練時只顯示該教練行事曆（改用既有單教練 API 路徑），「全部教練」才全覽；移除淡化他人課的死程式碼。

**Architecture:** 純前端：`coach.js` 的週資料 URL 分流＋週格渲染移除 `other`/`reg-booked-other`；`style.css` 刪兩條死樣式。後端零改動。

**Spec:** `docs/superpowers/specs/2026-07-06-register-single-coach-view-design.md`

## Global Constraints

- 後端零改動；非管理者路徑零影響；「全部教練」模式行為與現狀完全一致（含教練名標籤）。
- commit message 結尾：`Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`。

---

### Task 1: coach.js URL 分流＋渲染清理

**Files:**
- Modify: `public/coach.js`（週資料 URL 約 590 行、週格渲染約 622-628 行）
- Modify: `public/style.css`（約 1168-1169 行）

- [ ] **Step 1: 週資料 URL 分流**

現況（約 590 行）：

```js
    if (isAdmin) url = `/api/coach/week?all=1&start=${start}` + (regViewCoachId !== 'all' ? `&coachId=${regViewCoachId}` : '');
    else url = `/api/coach/week?start=${start}`;
```

改為：

```js
    // 個別教練：走單教練路徑（resolveCoach 代選），只回該教練資料；「全部教練」才 all=1 全覽
    if (isAdmin) url = regViewCoachId !== 'all'
      ? `/api/coach/week?start=${start}&coachId=${regViewCoachId}`
      : `/api/coach/week?all=1&start=${start}`;
    else url = `/api/coach/week?start=${start}`;
```

- [ ] **Step 2: 週格渲染移除淡化死碼**

現況（約 622-628 行）：

```js
        let inner = bks.map(b => {
          const tag = b.session_type === '1on2' ? '1對2' : '1對1';
          const other = targetCoachId != null && b.coach_id !== targetCoachId;
          const coachLbl = (isAll || other) ? `<span class="reg-sub">· ${escapeHtml(b.coach_name || '')}</span>` : '';
          return `<div class="reg-bk${other ? ' reg-booked-other' : ''}" data-bk="${b.id}">${escapeHtml(b.member_name)} <span class="reg-sub">${tag}</span>${coachLbl}</div>`;
        }).join('');
```

改為（單教練資料不再含他人課；教練名只在全覽顯示）：

```js
        let inner = bks.map(b => {
          const tag = b.session_type === '1on2' ? '1對2' : '1對1';
          const coachLbl = isAll ? `<span class="reg-sub">· ${escapeHtml(b.coach_name || '')}</span>` : '';
          return `<div class="reg-bk" data-bk="${b.id}">${escapeHtml(b.member_name)} <span class="reg-sub">${tag}</span>${coachLbl}</div>`;
        }).join('');
```

- [ ] **Step 3: style.css 刪死樣式（1168-1169 行）**

```css
.reg-booked-other{background:#eef2f7;color:#64748b;}
.reg-booked-other:hover{background:#e2e8f0;}
```

整段刪除。並 `grep -rn "reg-booked-other" public/` 確認全 repo 無殘留引用。

- [ ] **Step 4: 驗證**

```bash
node --check public/coach.js
# Playwright（模組路徑 /Users/ryansheu/.npm/_npx/5c6d8c4f680fcd0a/node_modules/playwright/index.mjs）：
#   node src/db/seed-demo.js；LINE_MOCK=1 npm start 背景；admin 登入 /coach.html → 登錄預約
#   → 下拉選「王教練」：斷言頁面無 .reg-booked-other、所有 .reg-bk 無他教練名後綴、
#     週資料請求 URL 不含 all=1（可攔 request 斷言）
#   → 切「全部教練」：斷言出現 ≥2 位教練名的 .reg-sub 標籤、URL 含 all=1
#   → 選回王教練點空格：登錄彈窗照常開啟；0 pageerror
```

- [ ] **Step 5: Commit**

```bash
git add public/coach.js public/style.css
git commit -m "feat: 登錄預約選個別教練只顯示該教練行事曆（全部教練才全覽）"
```
