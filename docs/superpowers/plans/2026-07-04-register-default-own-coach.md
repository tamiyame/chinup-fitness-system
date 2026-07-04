# 登錄預約週曆教練下拉預設本人 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 登錄預約頁籤的教練選擇器預設「登入者自己的教練身份」（自己不在啟用清單時回退「全部教練」）。

**Architecture:** 純前端 `public/coach.js`：`setupCoachPicker()` 記下 `myCoachId`；`renderRegister()` 對 `regViewCoachId` 做一次性初始化（DOM select 語意驗證選項存在）。

**Spec:** `docs/superpowers/specs/2026-07-04-register-default-own-coach-design.md`

## Global Constraints

- 純前端、只動 `public/coach.js`；非管理者流程零改動。
- commit message 結尾：`Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`。

---

### Task 1: coach.js 預設本人

**Files:**
- Modify: `public/coach.js`（`setupCoachPicker` 約 119–141 行、`regViewCoachId` 宣告約 507 行、`renderRegister` 選擇器區塊約 561–575 行）

- [ ] **Step 1: `setupCoachPicker()` 記錄自己的教練 id**

在 `let self = null; try { self = await api('/api/coach/me'); } …` 之後加一行：

```js
  myCoachId = self?.id ?? null; // 登錄預約頁籤「預設選自己」用（登入者自己的教練身份）
```

並在模組層（`let regViewCoachId …` 附近）宣告：

```js
let myCoachId = null; // 管理者登入者自己的教練 id（setupCoachPicker 填入；無教練檔案為 null）
```

- [ ] **Step 2: `regViewCoachId` 宣告改為未初始化**

```js
let regViewCoachId = null; // 管理者登錄分頁檢視：null=未初始化（首次渲染時預設自己）；'all' 或 coachId 字串；一般教練不使用
```

- [ ] **Step 3: `renderRegister()` 選擇器區塊改為（整段取代原 561–575 行的 if (isAdmin) 區塊）**

```js
  // 管理者：填充教練選擇器（全部教練 + 各 active coach）；首次渲染預設「登入者自己」（教練身份為主），
  // 自己無教練檔案或未啟用（不在選項內）→ 回退「全部教練」。
  if (isAdmin) {
    const picker = $('reg-coach-picker');
    if (!regCoachOptionsCache) {
      let opts = '<option value="all">全部教練</option>';
      try {
        const all = await api('/api/admin/coaches');
        opts += all.filter(c => c.is_active).map(c => `<option value="${c.id}">${escapeHtml(c.display_name)}</option>`).join('');
      } catch {}
      regCoachOptionsCache = opts;
    }
    picker.innerHTML = regCoachOptionsCache;
    if (regViewCoachId === null) {
      regViewCoachId = 'all';
      if (myCoachId != null) {
        picker.value = String(myCoachId);
        if (picker.value === String(myCoachId)) regViewCoachId = String(myCoachId); // 選項存在才預設自己
      }
    }
    picker.value = regViewCoachId;
    picker.onchange = () => { regViewCoachId = picker.value; renderRegister(); };
  }
```

- [ ] **Step 4: 驗證**

```bash
node --check public/coach.js
# Playwright（playwright 模組：/Users/ryansheu/.npm/_npx/5c6d8c4f680fcd0a/node_modules/playwright/index.mjs）：
#   node src/db/seed-demo.js；LINE_MOCK=1 npm start 背景；admin@chinup.local 登入 /coach.html
#   → 切「登錄預約」頁籤 → 斷言 #reg-coach-picker 的 value 不是 'all'、選中文字是登入者教練名
#   → 行事曆只出現該教練的預約 → 切回「全部教練」→ 出現多教練 → 0 pageerror
```

- [ ] **Step 5: Commit**

```bash
git add public/coach.js
git commit -m "feat: 登錄預約週曆教練下拉預設登入者本人"
```
