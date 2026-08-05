# 綁定 LINE 直達頁（/line-bind）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 一條固定超連結 `/line-bind` 讓客人不經「我的課表」直接完成 LINE 綁定：填電話姓名→拿 6 碼→一鍵開 LINE 自動帶碼送出。

**Architecture:** 新增獨立門面頁 `public/line-bind.html`（天藍海報白紙卡、inline module script、自帶 fetch）重用既有 `POST /api/public/line/bind-code`；後端只加一個 `app_settings.line_official_id` 設定（schema seed、settings GET/PATCH、產碼回應多帶一欄）與 `GET /line-bind` 乾淨路由；門面三頁頁尾加入口；後台「收款與 LINE 設定」卡多一個輸入欄。

**Tech Stack:** Node ESM + Express + node:sqlite；前端 vanilla JS + Tailwind CDN + colors_and_type/style/facade CSS；plain-node assert API 測試（需本地 server 跑著）。

**Spec:** `docs/superpowers/specs/2026-08-05-line-bind-page-design.md`

## Global Constraints

- 分支 `feature/line-bind-page`（已存在，spec 已 commit `f78ebfd`）。
- **零改動**：`requestPublicBindCode` 驗證邏輯（403/409/限流）、webhook 綁定流程、`public/my-schedule.js`/我的課表彈窗。
- 繁體中文文案；門面頁遵循天藍海報語彙（方角、白紙 sheet 內必有墨色、White-on-Sky 純白、無 emoji 裝飾）。
- oaMessage 深連結格式：`https://line.me/R/oaMessage/{encodeURIComponent(@id)}/?{encodeURIComponent(code)}`。
- `line_official_id` 空字串＝未設定＝綁定頁退回複製模式；非空存檔時自動補 `@` 前綴。
- API 測試檔直接打 `BASE`（預設 `http://localhost:3000`）並以 `import { db }` 直寫 fixtures——**跑 API 測試前 server 必須以 `LINE_MOCK=1 GCAL_MOCK=1 GMAIL_MOCK=1 npm start` 跑著**；測試會動到 `data/app.db`（demo DB 共用，收尾任務會 reseed）。
- 單元測試套件照舊 fresh DB gate（本計畫不新增單元測試檔）。
- Commit 訊息結尾加 `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`。

---

### Task 1: 後端 — `line_official_id` 設定鏈與 `/line-bind` 路由（TDD）

**Files:**
- Modify: `tests/public-line-bind-api.test.js`（fixtures 區與檢查 1 之後）
- Modify: `tests/discount-admin-api.test.js`（[9]/[10] settings 段落）
- Modify: `src/services/discountService.js:154` 附近（helper）
- Modify: `src/db/schema.js`（`line_official_url` seed 行之後）
- Modify: `src/server.js`（import 行 86、settingsPayload 1412 附近、PATCH 1448-1452 之後、`/checkin` 路由區塊之後）
- Modify: `src/services/lineBindingService.js`（import 與 `requestPublicBindCode` 回傳）

**Interfaces:**
- Consumes: 既有 `getSetting`/`setSetting`（discountService）、`settingsPayload()`、`requestPublicBindCode()`。
- Produces: `getLineOfficialId(): string`（discountService named export）；`POST /api/public/line/bind-code` 回應新欄 `line_official_id`；`GET/PATCH /api/admin/settings` 新欄 `line_official_id`；`GET /line-bind` 送出 `public/line-bind.html`。Task 2 的頁面依賴回應欄位名 `line_official_id`／`line_official_url`。

- [ ] **Step 1: 寫失敗測試（公開產碼回應帶 line_official_id）**

`tests/public-line-bind-api.test.js`：fixtures 區（`db.prepare("INSERT INTO users (name,phone,role) VALUES ('PLB 教練','0961000003','coach')").run();` 之後）加一行設定：

```js
db.prepare("INSERT OR REPLACE INTO app_settings (key, value) VALUES ('line_official_id','@plbtest')").run();
```

檢查 1 的 `expect('回 line_official_url 欄位', …)` 之後加：

```js
expect('回 line_official_id 欄位＝設定值（一鍵開 LINE 深連結用）', () => assert.equal(ok.data.line_official_id, '@plbtest'));
```

檔尾 cleanup 區（找到既有 `DELETE FROM users WHERE phone LIKE '0961%'` 的收尾清理處；若無收尾清理則加在最後一個 expect 之後）加：

```js
db.prepare("INSERT OR REPLACE INTO app_settings (key, value) VALUES ('line_official_id','')").run();
```

- [ ] **Step 2: 寫失敗測試（admin settings 讀寫與 @ 正規化）**

`tests/discount-admin-api.test.js`：[9] 段 `expect('one_on_one_price default 1500', …)` 之後加：

```js
expect('settings 含 line_official_id 欄位', () => assert.ok('line_official_id' in settingsRes.data));
```

[10] 段結尾（`expect('public price now 1800', …)` 之後）加：

```js
// ── [10b] PATCH /api/admin/settings — line_official_id（@ 自動補全／原樣／清除） ──
console.log('[10b] PATCH /api/admin/settings → line_official_id');
const idNoAt = await req('PATCH', '/api/admin/settings', { token: adminToken, body: { line_official_id: 'chinup_test' } });
expect('未帶 @ 自動補全', () => { assert.equal(idNoAt.status, 200); assert.equal(idNoAt.data?.line_official_id, '@chinup_test'); });
const idAt = await req('PATCH', '/api/admin/settings', { token: adminToken, body: { line_official_id: '@chinup_test2' } });
expect('帶 @ 原樣保存', () => assert.equal(idAt.data?.line_official_id, '@chinup_test2'));
const idClear = await req('PATCH', '/api/admin/settings', { token: adminToken, body: { line_official_id: '' } });
expect('空字串清除', () => assert.equal(idClear.data?.line_official_id, ''));
```

- [ ] **Step 3: 跑測試確認失敗**

Server 以 `LINE_MOCK=1 GCAL_MOCK=1 GMAIL_MOCK=1 npm start` 跑著（背景），然後：

```bash
node tests/public-line-bind-api.test.js && node tests/discount-admin-api.test.js
```

Expected: 新增的 expect 標 ✗（`line_official_id` 欄位不存在），process exitCode 1；既有項全 ✓。

- [ ] **Step 4: 實作**

`src/services/discountService.js`——`getLineOfficialUrl`（154 行）之後加：

```js
export function getLineOfficialId() { return getSetting('line_official_id') || ''; }
```

`src/db/schema.js`——`INSERT OR IGNORE INTO app_settings (key, value) VALUES ('line_official_url', '');` 之後加：

```sql
INSERT OR IGNORE INTO app_settings (key, value) VALUES ('line_official_id', '');
```

`src/server.js` 86 行 import——在 `getLineOfficialUrl,` 之後插入 `getLineOfficialId,`。

`src/server.js` `settingsPayload()`——`line_official_url: getLineOfficialUrl(),` 之後加：

```js
    line_official_id: getLineOfficialId(),
```

`src/server.js` PATCH——`line_official_url` 分支（`writes.push(['line_official_url', url]); // 空字串代表清除（不顯示按鈕）` 與其閉合 `}`）之後加：

```js
  if (b.line_official_id !== undefined) {
    let v = String(b.line_official_id).trim();
    if (v && !v.startsWith('@')) v = '@' + v;
    writes.push(['line_official_id', v]); // 空字串代表未設定（綁定頁退回複製模式）
  }
```

`src/server.js` 路由——`/checkin` 的 `app.get` 區塊之後、`app.use(express.static(...))` 之前加：

```js
app.get('/line-bind', (req, res) =>
  res.sendFile(resolve(__dirname, '../public/line-bind.html'))
);
```

`src/services/lineBindingService.js`——import 行 `import { getLineOfficialUrl } from './discountService.js';` 改為：

```js
import { getLineOfficialUrl, getLineOfficialId } from './discountService.js';
```

`requestPublicBindCode` 回傳行改為：

```js
  return { code, expires_at, line_official_url: getLineOfficialUrl(), line_official_id: getLineOfficialId() };
```

- [ ] **Step 5: 跑測試確認通過**

Server 重啟（schema seed 於開機執行）後：

```bash
node tests/public-line-bind-api.test.js && node tests/discount-admin-api.test.js
```

Expected: 全 ✓、exit 0。另 `curl -s -o /dev/null -w "%{http_code}" http://localhost:3000/line-bind` 得 404（頁面檔 Task 2 才建）——**路由已掛但 sendFile 404 屬預期**；若 Express 對缺檔 sendFile 回 500 也屬預期，Task 2 後轉 200。

- [ ] **Step 6: Commit**

```bash
git add tests/public-line-bind-api.test.js tests/discount-admin-api.test.js src/services/discountService.js src/db/schema.js src/server.js src/services/lineBindingService.js
git commit -m "feat: line_official_id 設定鏈＋/line-bind 路由（綁定直達頁後端）"
```

---

### Task 2: 前端頁 `public/line-bind.html`

**Files:**
- Create: `public/line-bind.html`

**Interfaces:**
- Consumes: `POST /api/public/line/bind-code`（body `{phone, name}`；200 → `{code, expires_at, line_official_url, line_official_id}`；403 `not_found_or_mismatch`；409 `already_bound`；429）。
- Produces: 無（終端頁）。Task 3 的入口連結指向 `/line-bind`。

- [ ] **Step 1: 建立完整頁面（逐字）**

```html
<!DOCTYPE html>
<html lang="zh-TW">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>綁定 LINE 通知 - CHINUP Performance</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Archivo:wght@600;700;800;900&family=Inter:wght@400;500;600;700;800&family=Noto+Sans+TC:wght@400;500;600;700&display=swap" rel="stylesheet">
<script src="https://cdn.tailwindcss.com"></script>
<link rel="stylesheet" href="/colors_and_type.css">
<link rel="stylesheet" href="/style.css">
<link rel="stylesheet" href="/facade.css">
<style>
  /* 門面「天藍海報」— 綁定：sky 場地上一張白紙 sheet（同 login pattern） */
  body { min-height: 100vh; min-height: 100dvh; }
  .bind-kick {
    font-family: "Archivo","Noto Sans TC",sans-serif; font-weight: 800;
    font-size: 11px; letter-spacing: .28em; text-transform: uppercase;
    color: #fff; margin-bottom: 14px;
  }
  .bind-card {
    background: #fff; color: var(--ink);
    border: 0; border-radius: 0;
    padding: 30px 26px 26px;
    max-width: 400px; width: 100%;
  }
  .bind-code {
    font-family: "Archivo","Noto Sans TC",sans-serif; font-weight: 900;
    font-size: 44px; letter-spacing: .14em; text-align: center;
    font-variant-numeric: tabular-nums; user-select: all;
    margin: 6px 0 2px; color: var(--ink);
  }
  .bind-step {
    font-family: "Archivo","Noto Sans TC",sans-serif; font-weight: 800;
    font-size: 11px; letter-spacing: .18em; text-transform: uppercase;
    color: var(--ink-mute); margin: 18px 0 8px;
  }
  .bind-note { font-size: 12px; color: var(--ink-mute); text-align: center; margin-bottom: 4px; }
  .btn-line-join, .btn-line-send {
    display: block; width: 100%; text-align: center; text-decoration: none;
    border-radius: 0; padding: 12px 18px; font-weight: 700; font-size: 14px;
    cursor: pointer; border: 1px solid var(--line); background: #fff; color: var(--ink);
  }
  .btn-line-join:hover { background: #f9fafb; }
  .btn-line-send {
    background: #06c755; border-color: #06c755; color: #fff;
    font-family: "Archivo","Noto Sans TC",sans-serif; font-weight: 900; letter-spacing: .08em;
  }
  .btn-line-send:hover { filter: brightness(.95); }
</style>
</head>
<body class="flex flex-col items-center justify-center p-6">

<div class="bind-kick">LINE Notifications</div>
<div class="bind-card">
  <div class="text-center mb-6">
    <img src="/logo.png" alt="CHINUP Performance" style="width:68px;height:68px;margin:0 auto 12px;display:block;object-fit:contain;">
    <h1 class="text-2xl font-bold" style="letter-spacing:-0.02em;">綁定 LINE，通知不漏接</h1>
    <p class="subtle mt-1">預約成立、上課提醒、候補遞補都會直接傳到你的 LINE</p>
  </div>

  <form id="bind-form" class="space-y-4" novalidate>
    <div>
      <label class="form-label" for="bd-phone">電話（預約時填的）</label>
      <input id="bd-phone" type="tel" inputmode="numeric" required class="form-input" placeholder="09xxxxxxxx" autocomplete="tel">
    </div>
    <div>
      <label class="form-label" for="bd-name">姓名（預約時填的）</label>
      <input id="bd-name" type="text" required class="form-input" placeholder="請輸入真實姓名" autocomplete="name">
    </div>
    <div id="bd-err" class="text-sm" style="color:#dc2626;display:none;"></div>
    <button type="submit" class="btn btn-primary w-full" id="bd-submit">取得綁定碼</button>
  </form>

  <section id="bd-result" hidden>
    <div id="bd-already" hidden>
      <p style="text-align:center;font-weight:700;margin:10px 0 4px;">✓ 此帳號已綁定 LINE</p>
      <p class="bind-note">之後的預約與提醒會直接傳到你的 LINE，可以關閉此頁了。</p>
    </div>
    <div id="bd-codewrap" hidden>
      <div class="bind-step">Step 1 · 還不是好友請先加入</div>
      <a id="bd-join" class="btn-line-join" target="_blank" rel="noopener" hidden>加入 CHINUP 官方 LINE</a>
      <p id="bd-nojoin" class="bind-note" hidden>尚未設定官方 LINE 連結，請洽櫃台。</p>
      <div class="bind-step">Step 2 · 你的綁定碼</div>
      <div id="bd-code" class="bind-code"></div>
      <p class="bind-note">15 分鐘內有效</p>
      <div class="bind-step">Step 3 · 傳送給官方帳號</div>
      <a id="bd-send" class="btn-line-send" hidden>開啟 LINE 傳送綁定碼</a>
      <div id="bd-copymode" hidden>
        <button type="button" id="bd-copy" class="btn btn-primary w-full">複製綁定碼</button>
        <p class="bind-note" style="margin-top:8px;">到官方帳號聊天室貼上 6 位數綁定碼送出即完成。</p>
      </div>
      <p class="bind-note" style="margin-top:14px;">送出後即完成綁定，可關閉此頁。</p>
    </div>
  </section>
</div>

<script type="module">
const form = document.getElementById('bind-form');
const err = document.getElementById('bd-err');
const result = document.getElementById('bd-result');

function showErr(msg) { err.textContent = msg; err.style.display = 'block'; }

form.addEventListener('submit', async (ev) => {
  ev.preventDefault();
  err.style.display = 'none';
  const phone = document.getElementById('bd-phone').value.trim();
  const name = document.getElementById('bd-name').value.trim();
  if (!phone || !name) { showErr('請填寫電話與姓名'); return; }
  const btn = document.getElementById('bd-submit');
  btn.disabled = true; btn.textContent = '產生綁定碼中…';
  try {
    const res = await fetch('/api/public/line/bind-code', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ phone, name }),
    });
    let data = null; try { data = await res.json(); } catch { /* no body */ }
    if (res.status === 409) { form.hidden = true; result.hidden = false; document.getElementById('bd-already').hidden = false; return; }
    if (res.status === 403) { showErr('查無資料，請用預約時填的電話與姓名'); return; }
    if (res.status === 429) { showErr('操作太頻繁，請稍後再試'); return; }
    if (!res.ok || !data?.code) { showErr(`發生錯誤（${res.status}），請稍後再試`); return; }

    form.hidden = true; result.hidden = false;
    document.getElementById('bd-codewrap').hidden = false;
    document.getElementById('bd-code').textContent = String(data.code);

    if (data.line_official_url) {
      const join = document.getElementById('bd-join');
      join.href = data.line_official_url; join.hidden = false;
    } else {
      document.getElementById('bd-nojoin').hidden = false;
    }

    if (data.line_official_id) {
      const send = document.getElementById('bd-send');
      send.href = `https://line.me/R/oaMessage/${encodeURIComponent(data.line_official_id)}/?${encodeURIComponent(String(data.code))}`;
      send.hidden = false;
    } else {
      document.getElementById('bd-copymode').hidden = false;
      document.getElementById('bd-copy').addEventListener('click', async () => {
        try { await navigator.clipboard.writeText(String(data.code)); document.getElementById('bd-copy').textContent = '已複製 ✓'; }
        catch { showErr('複製失敗，請長按上方數字手動複製'); }
      });
    }
  } catch {
    showErr('連線失敗，請稍後再試');
  } finally {
    btn.disabled = false; btn.textContent = '取得綁定碼';
  }
});
</script>
</body>
</html>
```

- [ ] **Step 2: 驗證頁面可送達**

Server 跑著時：

```bash
curl -s -o /dev/null -w "%{http_code}\n" http://localhost:3000/line-bind
curl -s -o /dev/null -w "%{http_code}\n" http://localhost:3000/line-bind.html
```

Expected: 兩者皆 `200`。

- [ ] **Step 3: Commit**

```bash
git add public/line-bind.html
git commit -m "feat: /line-bind 綁定直達頁（產碼＋一鍵開 LINE 帶碼／複製退回模式）"
```

---

### Task 3: 門面三頁頁尾入口＋facade 頁尾連結樣式

**Files:**
- Modify: `public/facade.css`（`.fa-foot` 規則之後）
- Modify: `public/index.html`（`<script type="module" src="/app.js"></script>` 之前）
- Modify: `public/group.html`（`<div id="toast" class="toast"></div>` 之前）
- Modify: `public/coaches.html`（`<div id="toast" class="toast"></div>` 之前）

**Interfaces:**
- Consumes: Task 2 的 `/line-bind` 頁。
- Produces: 三個門面頁頁尾 `<footer class="fa-foot">` 內含 `/line-bind` 連結。

- [ ] **Step 1: facade.css 加頁尾連結樣式**

`.fa-foot { padding: 30px 0 60px; color: #fff; font-size: 12px; }` 之後加：

```css
.fa-foot { text-align: center; }
.fa-foot a { color: #fff; text-decoration: underline; text-underline-offset: 3px; }
```

（`.fa-foot` 現無任何頁面使用中的置左版面，直接補置中與連結樣式即可。）

- [ ] **Step 2: 三頁插入頁尾（逐字，同一段）**

插入內容（三頁相同）：

```html
<footer class="fa-foot">
  <a href="/line-bind">綁定 LINE 通知</a>
</footer>
```

- `public/index.html`：插在 `<script type="module" src="/app.js"></script>` 該行之前。
- `public/group.html`：插在 `<div id="toast" class="toast"></div>` 該行之前。
- `public/coaches.html`：插在 `<div id="toast" class="toast"></div>` 該行之前。

- [ ] **Step 3: 驗證**

```bash
grep -c 'href="/line-bind"' public/index.html public/group.html public/coaches.html
```

Expected: 三檔各 `1`。

- [ ] **Step 4: Commit**

```bash
git add public/facade.css public/index.html public/group.html public/coaches.html
git commit -m "feat: 門面三頁頁尾加「綁定 LINE 通知」入口"
```

---

### Task 4: 後台「收款與 LINE 設定」卡新增官方帳號 ID 欄

**Files:**
- Modify: `public/admin.html:663` 之後（`#line-official-url` input 下一行）
- Modify: `public/admin.js`（`loadOneOnOnePrice` 載入區＋`save-bank-line` 儲存 handler）

**Interfaces:**
- Consumes: Task 1 的 `GET/PATCH /api/admin/settings` 新欄 `line_official_id`。
- Produces: 後台輸入欄 `#line-official-id`。

- [ ] **Step 1: admin.html 插入欄位**

原（662-663 行）：

```html
      <label class="form-label" for="line-official-url">官方 LINE 加入連結（成功頁「加入官方 LINE」按鈕；留空則不顯示按鈕）</label>
      <input id="line-official-url" type="url" class="form-input mb-3" style="width:100%;" placeholder="https://lin.ee/xxxxxxx">
```

改為（原兩行保留，其後插入兩行）：

```html
      <label class="form-label" for="line-official-url">官方 LINE 加入連結（成功頁「加入官方 LINE」按鈕；留空則不顯示按鈕）</label>
      <input id="line-official-url" type="url" class="form-input mb-3" style="width:100%;" placeholder="https://lin.ee/xxxxxxx">
      <label class="form-label" for="line-official-id">LINE 官方帳號 ID（@開頭，例：@chinup；供綁定頁「開啟 LINE 傳送綁定碼」一鍵帶碼，留空則退回複製模式）</label>
      <input id="line-official-id" type="text" class="form-input mb-3" style="width:100%;" placeholder="@chinup">
```

- [ ] **Step 2: admin.js 載入區**

原（`loadOneOnOnePrice` 內）：

```js
    const lineInput = document.getElementById('line-official-url');
    if (lineInput) lineInput.value = r.line_official_url ?? '';
```

改為：

```js
    const lineInput = document.getElementById('line-official-url');
    if (lineInput) lineInput.value = r.line_official_url ?? '';
    const lineIdInput = document.getElementById('line-official-id');
    if (lineIdInput) lineIdInput.value = r.line_official_id ?? '';
```

- [ ] **Step 3: admin.js 儲存 handler**

原：

```js
  const bank_info = (document.getElementById('bank-info')?.value || '').trim();
  const line_official_url = (document.getElementById('line-official-url')?.value || '').trim();
```

改為：

```js
  const bank_info = (document.getElementById('bank-info')?.value || '').trim();
  const line_official_url = (document.getElementById('line-official-url')?.value || '').trim();
  const line_official_id = (document.getElementById('line-official-id')?.value || '').trim();
```

原：

```js
    await api('/api/admin/settings', { method: 'PATCH', body: { bank_info, line_official_url, group_order_expiry_hours: expiryHours } });
```

改為：

```js
    await api('/api/admin/settings', { method: 'PATCH', body: { bank_info, line_official_url, line_official_id, group_order_expiry_hours: expiryHours } });
```

（`@` 正規化在後端做，前端不驗證。）

- [ ] **Step 4: 語法檢查**

```bash
node --check public/admin.js
```

Expected: 無輸出（通過）。

- [ ] **Step 5: Commit**

```bash
git add public/admin.html public/admin.js
git commit -m "feat: 後台收款與 LINE 設定卡新增官方帳號 ID 欄（一鍵帶碼用）"
```

---

### Task 5: 收尾 — 全測試、瀏覽器實測、draft PR

**Files:**
- 無新改動（驗證與交付）

- [ ] **Step 1: 單元測試全綠（fresh DB）**

```bash
DB_PATH="$(mktemp -d)/t.db" npm test
```

Expected: 全部通過（本計畫未動單元測試覆蓋的服務邏輯；此步是回歸保險）。

- [ ] **Step 2: API 測試（server 需跑著）＋觸動檔案全綠**

```bash
LINE_MOCK=1 GCAL_MOCK=1 GMAIL_MOCK=1 npm start  # 背景
node tests/public-line-bind-api.test.js && node tests/discount-admin-api.test.js && node tests/settings-gcal-api.test.js
```

Expected: 全 ✓。

- [ ] **Step 3: 瀏覽器實測（localhost）**

1. `/line-bind` 四態：demo 客戶（先 `npm run seed` 取 demo 資料）電話＋姓名 → 6 碼＋Step 1/2/3 版面；後台填 `@test` 後重測 → 綠色「開啟 LINE 傳送綁定碼」按鈕 href 為 `https://line.me/R/oaMessage/%40test/?######`；清空 ID → 複製模式；錯名 → 403 訊息；已綁 fixture → ✓ 已綁定；連按 11 次觸發 429 訊息（可略）。
2. 門面三頁頁尾出現「綁定 LINE 通知」白字連結、點擊到頁。
3. 後台折扣碼頁籤 → 收款與 LINE 設定卡：新欄顯示、存 `chinup_x` 後重新載入顯示 `@chinup_x`（後端補 @）。
4. 我的課表綁定彈窗照舊無回歸。
5. 對 `/line-bind` 跑一次文字對比度掃描（白紙卡上全墨色、藍底上全白色）。

- [ ] **Step 4: reseed demo DB（API 測試弄髒後）**

```bash
npm run seed
```

- [ ] **Step 5: Draft PR**

```bash
git push -u origin feature/line-bind-page
```

以 REST API 開 draft PR（title「綁定 LINE 直達頁 /line-bind：一鍵開 LINE 自動帶碼」，body 摘要 spec 決策＋測試證據＋smoke 清單），待業主 smoke 後才 merge。

**Expected 完成態:** 分支上 4 個 feature commit＋spec commit；draft PR open；業主上後台填真實 `@id` 後一鍵帶碼生效。
