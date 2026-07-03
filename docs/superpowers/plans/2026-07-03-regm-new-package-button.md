# 登錄彈窗「新增方案」按鈕＋單價顯示 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 登錄預約彈窗「選擇方案」旁加「＋ 新增方案」按鈕（有方案時也能當場開新方案、建立後自動選取），方案下拉加顯單價（無金額顯「無單價」）。

**Architecture:** 純前端：`public/coach.js` 抽共用開方案表單 helper 供「無方案直出」與「按鈕展開」兩處重用；`loadRegmPackages` 加 `selectId` 參數支援自動選取；`public/style.css` regm 區塊加一條 head-row 樣式。後端 API 不動。

**Tech Stack:** vanilla JS；既有 `btn-secondary`/`btn-sm`/`.regm-*` 樣式。

**Spec:** `docs/superpowers/specs/2026-07-03-regm-new-package-button-design.md`

## Global Constraints

- 後端零改動；編輯預約彈窗（`#bke-*`）零改動。
- 單價口徑：`Math.round(amount / total_sessions)`；`amount == null` → `無單價`。
- UI 文案繁體中文。
- commit message 結尾：`Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`。

---

### Task 1: coach.js 重構＋按鈕＋單價（單一交付物）

**Files:**
- Modify: `public/coach.js`（`loadRegmPackages` 約 916–925 行、`renderRegmPicked` 約 954–1030 行）
- Modify: `public/style.css`（regm 區塊約 1185–1193 行附近）

**Interfaces:**
- Consumes: `POST /api/coach/packages`（201 回新方案物件含 `id`）、`GET /api/coach/packages?memberId=`（欄位含 `amount`/`total_sessions`/`is_valid`）。

- [ ] **Step 1: `loadRegmPackages` 加 selectId 參數**

```js
async function loadRegmPackages(selectId = null) {
  const picked = $('regm-picked');
  picked.innerHTML = '<p class="regm-sub">載入方案中…</p>';
  let all = [];
  try { all = await api(`/api/coach/packages?memberId=${regmCustomer.id}`); }
  catch (e) { picked.innerHTML = `<p class="regm-sub" style="color:#dc2626;">${escapeHtml(e.message)}</p>`; return; }
  regmPackages = all.filter(p => p.is_valid);
  regmPackageId = selectId && regmPackages.some(p => p.id === selectId)
    ? selectId
    : (regmPackages.length ? regmPackages[0].id : null);
  renderRegmPicked();
}
```

- [ ] **Step 2: 抽共用開方案表單 helper（放在 `renderRegmPicked` 之前）**

```js
/** 開方案表單（無方案直出 &「＋ 新增方案」展開共用）。onCreated(pkg) 於建立成功後呼叫。 */
function regmNewPkgFormHtml() {
  return `
      <div class="regm-newpkg">
        <select id="regm-np-type" class="form-select"><option value="1on1">一對一</option><option value="1on2">一對二</option></select>
        <input id="regm-np-total" class="form-input" type="number" min="1" placeholder="堂數" />
        <input id="regm-np-amount" class="form-input" type="number" min="0" placeholder="金額（可空）" />
        <input id="regm-np-expiry" class="form-input" type="date" />
        <select id="regm-np-discount" class="form-select"></select>
        <button id="regm-np-create" class="btn-primary">建立方案</button>
      </div>`;
}
function bindRegmNewPkgForm(onCreated) {
  getDiscountCodes().then(codes => { const el = document.getElementById('regm-np-discount'); if (el) el.innerHTML = discountOptionsHtml(codes); });
  $('regm-np-create').onclick = async () => {
    const total = Number($('regm-np-total').value);
    if (!Number.isInteger(total) || total <= 0) { toast('請填正確堂數', 'error'); return; }
    const amt = $('regm-np-amount').value;
    try {
      const pkg = await api('/api/coach/packages', { method: 'POST', body: { memberId: regmCustomer.id, sessionType: $('regm-np-type').value, totalSessions: total, amount: amt === '' ? null : Number(amt), expiresAt: $('regm-np-expiry').value || null, discountCode: document.getElementById('regm-np-discount')?.value || null } });
      toast('方案已建立', 'success');
      onCreated(pkg);
    } catch (e) { toast(`建立失敗：${e.message}`, 'error'); }
  };
}
```

- [ ] **Step 3: `renderRegmPicked` 無方案分支改用 helper（行為不變）**

```js
  if (!regmPackages.length) {
    picked.innerHTML = `
      <div class="regm-nopkg">此客人沒有可用方案，請先開一個：</div>` + regmNewPkgFormHtml();
    bindRegmNewPkgForm((pkg) => loadRegmPackages(pkg.id));
    return;
  }
```

- [ ] **Step 4: 有方案分支——單價選項＋head row＋展開表單**

選項組改為（單價與無單價）：

```js
  const opts = regmPackages.map(p => {
    const unit = p.amount != null
      ? `單價 NT$${Math.round(p.amount / p.total_sessions).toLocaleString('zh-TW')}`
      : '無單價';
    return `<option value="${p.id}">${PKG_TYPE[p.session_type] || escapeHtml(p.session_type)}・剩 ${escapeHtml(String(p.remaining_sessions))}/${escapeHtml(String(p.total_sessions))}・${unit}${p.expires_at ? '・到期 ' + escapeHtml(p.expires_at) : ''}</option>`;
  }).join('');
```

`picked.innerHTML` 開頭兩行（label＋select）改為：

```js
    <div class="regm-pkg-head">
      <label class="regm-label">選擇方案</label>
      <button id="regm-np-toggle" class="btn-secondary btn-sm" type="button">＋ 新增方案</button>
    </div>
    <div id="regm-np-box" class="hidden">${regmNewPkgFormHtml()}</div>
    <select id="regm-pkg" class="form-select">${opts}</select>
```

（其餘循環 UI 與按鈕列不動。）

innerHTML 之後的 select 綁定改為（支援自動選取指定方案）：

```js
  const sel = $('regm-pkg');
  if (regmPackageId && regmPackages.some(p => p.id === regmPackageId)) sel.value = String(regmPackageId);
  sel.onchange = () => { regmPackageId = Number(sel.value); };
  regmPackageId = Number(sel.value);
```

並在（原 `$('regm-pkg').onchange` 區塊之後、週幾勾選之前）加：

```js
  $('regm-np-toggle').onclick = () => $('regm-np-box').classList.toggle('hidden');
  bindRegmNewPkgForm((pkg) => loadRegmPackages(pkg.id));
```

- [ ] **Step 5: style.css regm 區塊（`.regm-label` 附近）加 head row**

```css
.regm-pkg-head{display:flex;align-items:center;justify-content:space-between;gap:8px;}
.regm-pkg-head .regm-label{margin-bottom:0;}
```

- [ ] **Step 6: 驗證**

```bash
node --check public/coach.js
# Playwright（沿用 /Users/ryansheu/.npm/_npx/5c6d8c4f680fcd0a/node_modules/playwright/index.mjs）：
#   demo 資料 + server → 管理者登入 → /coach.html → 點行事曆空格開登錄彈窗
#   → 搜尋有方案客人 → 斷言 #regm-pkg option 文字含「單價 NT$」或「無單價」
#   → 點「＋ 新增方案」→ #regm-np-box 顯示 → 填堂數10/金額15000 → 建立
#   → 斷言重繪後 #regm-pkg 選中值 = 新方案 id、選項含「單價 NT$1,500」
#   → 無方案客人（新建一個）→ 表單直出照舊；pageerrors = 0
```

- [ ] **Step 7: Commit**

```bash
git add public/coach.js public/style.css
git commit -m "feat: 登錄彈窗加「新增方案」按鈕＋方案下拉顯示單價"
```

---

## 收尾（controller）

1. `npm test`＋`test:api` 迴歸（後端未動應全綠）→ `node src/db/seed-demo.js` 重種。
2. Final review（小 diff）。
3. Push + draft PR + preview 給業主 smoke。
