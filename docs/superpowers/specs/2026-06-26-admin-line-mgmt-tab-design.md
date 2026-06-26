# 後台「LINE 管理」頁籤 + 合併總覽到課程 — 設計文件

> 日期：2026-06-26
> 範圍：單一 PR。後端加 1 支 admin per-user 解綁端點（重用既有 `unbindByUserId`）+ 1 支 api 測試；其餘純前端（`admin.html` + `admin.js`）。
> 業主已拍板（見「已拍板決策」）。

## 問題 / 動機
1. 客戶綁定 LINE 時可能輸錯電話 → LINE 綁到錯誤帳號（實例：陳怡君 LINE 綁在打錯字的空帳號 id 38／0628685158，正確帳號 id 12／0928685158 反而沒綁）。管理者目前**只能「清空全體綁定」**（`/api/admin/line/reset-all`），無法針對單一使用者解綁。需要一個可視化的「LINE 管理」頁籤逐人查看綁定狀況並單獨解綁。
2. 後台「總覽」頁籤內容（統計卡＋備份列）與「課程」相關，業主要把「總覽」併入「課程」頁，減少頁籤數。

## 已拍板決策（業主，2026-06-26）
1. LINE 管理列出**全部使用者**（含教練/管理者），每列標角色徽章。
2. 清單要**搜尋（姓名/電話）＋ 狀態篩選（全部／已綁／未綁）**。
3. 「總覽」內容移到「課程」頁**最下方**；移除「總覽」頁籤；**預設開啟分頁改「課程」**。
4. 解除綁定只解綁（清 `line_user_id`+綁定碼），**不代產新碼**（使用者自行重綁）。

## 背景（已查證，含 file:line）
- 後台頁籤：`admin.html` `#admin-tabs` 內 `<button data-atab="X" class="tab">`（行 279–287，順序：overview/courses/orders/members/coaches/discounts/notifs）；面板 `<div id="apanel-X" class="tab-panel [hidden]">`。切換邏輯 `admin.js:1601-1610`（通用：toggle `tab-active` + 顯示對應 `apanel-`）。預設 active＝HTML 寫死（overview 按鈕帶 `tab-active`、`#apanel-overview` 不 hidden）。
- 總覽面板 `#apanel-overview`（admin.html 289–309）：統計卡 section（`#stat-templates/#stat-sessions/#stat-regs/#stat-waitlist`）＋備份列 section（`#backup-summary`、`#btn-backup-manage`）。課程面板 `#apanel-courses`（310–331）：課程分類 + 課程範本。
- 使用者資料：`GET /api/admin/users`（requireAdmin，server.js:530）回**所有** user，含 `id,name,email,phone,role,is_admin,has_google,line_user_id,archived_at,created_at`。`admin.js` `loadUsers()`（~460）已 `allUsers = await api('/api/admin/users')` 後 `renderUsersTable()`。頁載入時 `loadUsers()` 與其他 loader 並列呼叫（admin.js:~1589）。
- 角色徽章現成邏輯（`renderUserRow`，admin.js:~505）：`is_admin`→「管理者」(badge-confirmed)，否則 `ROLE_LABEL[role]`/`ROLE_BADGE[role]`（教練/會員）。表格樣式 `.data-table`、徽章 `.badge-*`、會員搜尋 `#user-search`＋`#show-archived`＋`#users-table`（admin.html 374–386）。
- LINE 解綁服務：`lineBindingService.unbindByUserId(userId)`（**已存在**，清 `line_user_id`+`line_bind_code`+`line_bind_expires_at`；server.js 已 import，DELETE /api/my/line 在用）。全體重置 `resetAllLineBindings`（保留不動）。

## 架構

### #2 LINE 管理頁籤

**後端**（`src/server.js`，緊接 reset-all 端點 542 之後）：
```js
app.delete('/api/admin/users/:id/line', requireAdmin, asyncHandler((req, res) => {
  const id = Number(req.params.id);
  const u = db.prepare('SELECT id, line_user_id FROM users WHERE id = ?').get(id);
  if (!u) return res.status(404).json({ error: 'user_not_found' });
  const was_bound = !!u.line_user_id;
  unbindByUserId(id);
  res.json({ ok: true, was_bound });
});
```
（`unbindByUserId` 已 import；冪等：未綁也回 200 was_bound:false。）

**前端 `admin.html`**：
- `#admin-tabs`：**移除** `overview` 按鈕（見 #3）；末端（notifs 之後）加 `<button data-atab="line" class="tab">LINE 管理</button>`。
- 新增面板 `<div id="apanel-line" class="tab-panel hidden">`：標題「LINE 綁定管理」＋ 搜尋框 `#line-search`（姓名/電話）＋ 狀態篩選 `#line-filter`（select：全部/已綁定/未綁定）＋ `#line-table`（`.data-table` 容器）。沿用會員頁排版。

**前端 `admin.js`**：
- 新增 `renderLineTable()`：以 `allUsers` 為來源，依 `#line-search`（name/phone, lowercase includes）+ `#line-filter`（all/bound/unbound，bound=`!!line_user_id`）過濾；畫 `.data-table`：欄＝ID｜姓名（封存加「已封存」徽章+列淡化）｜角色徽章（重用 is_admin/ROLE_LABEL/ROLE_BADGE 規則）｜電話｜LINE 狀態（已綁定 badge-confirmed 綠／未綁定 badge-completed 灰）｜操作（已綁定列才有 `.btn-danger.btn-sm` 「解除綁定」，`data-line-uid`）。**列出全部使用者（含封存）**。
- 解綁互動：表格用事件委派監聽「解除綁定」→ `confirm('確定解除「<姓名>」(<電話>) 的 LINE 綁定？')` → `await api('/api/admin/users/'+id+'/line',{method:'DELETE'})` → toast 成功 → 就地把 `allUsers.find(id).line_user_id=null` → `renderLineTable()`。失敗 toast。
- 搜尋 `input`、篩選 `change` → `renderLineTable()`（一次性綁定，仿 `usersWired`）。
- 資料來源：在 `loadUsers()` 取得 `allUsers` 後，於 `renderUsersTable()` 旁**加呼叫 `renderLineTable()`**（同一份 fetch 餵兩張表，零額外請求）。

**測試**：`tests/admin-user-line-unbind-api.test.js`（掛 `test:api`）：建一 user 設 `line_user_id` → admin DELETE → 200 `was_bound:true` 且該 user `line_user_id` 變 NULL；非 admin token → 403；不存在 id → 404。

### #3 合併總覽到課程
- `admin.html`：移除 `<button data-atab="overview">`；把 `#apanel-overview` 內**統計卡 section + 備份列 section**整段搬到 `#apanel-courses` **末端**（課程範本 section 之後、`</div>` 收尾前）；刪除清空後的 `#apanel-overview` 容器。
- 預設分頁：`課程` 按鈕加 `tab-active`、`#apanel-courses` **移除 `hidden`**（其餘面板維持 hidden）。
- `admin.js`：切換邏輯通用、不需改；統計/備份 loader 抓的 DOM id 不變（只是位置移動）→ JS 不需改。**plan 需驗**：admin.js 無任何處硬引用 `data-atab="overview"`、`#apanel-overview`、或假設預設面板為 overview。

## 安全/權限
- 解綁端點 `requireAdmin`（與 reset-all 同級）。非 admin → 403。
- 解綁只清自己系統的 `line_user_id`（不呼叫 LINE 平台）；冪等。
- 前端表格全欄 `escapeHtml`（沿用既有）。

## 不動
- LINE webhook / `consumeCode` / 公開綁定流程 / `resetAllLineBindings` / 其他頁籤與功能。
- 不代產綁定碼、不做帳號合併（陳怡君 id 38 空帳號之後可另行封存）。

## 測試
- 後端新端點：上述 api 測試。
- 前端：`node --check public/admin.js`；瀏覽器 smoke（控制者）：LINE 管理頁列出、搜尋/篩選正確、解綁某人→狀態翻為未綁定+DB 清空；總覽內容出現在課程頁最下方、預設開課程頁、其他頁籤正常。

## 收尾（功能上線後）
- 用本工具於 prod 解除陳怡君 id 38（0628685158）的綁定，請她以正確號碼 0928685158（id 12）重新綁定；空帳號 id 38 可封存。

## 不做（YAGNI）
- 不做批次解綁（已有 reset-all 處理全體）。
- 不做解綁後代產碼/代綁。
- 不做帳號合併工具。
- LINE 管理不分頁（搜尋+篩選足夠；資料量小）。
