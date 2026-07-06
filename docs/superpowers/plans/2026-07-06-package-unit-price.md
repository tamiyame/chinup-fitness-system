# 方案單價模式＋消耗統計 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 開方案改「每堂單價」輸入（前端換算總額送既有 API）；管理者可事後修正單價（回寫全部已登錄堂）；會員方案列顯示消耗分解；我的課表加統計列（已上課/請假/即將到來）。

**Architecture:** 後端：packageService 加 `updateUnitPrice` ＋ `listPackagesForMember` 聚合欄位；server.js 加 `PATCH /api/coach/packages/:id/unit-price`（requireAdmin）；groupOrderService 我的課表回應加 `stats`。前端：coach.js／admin.js 兩張開方案表單改單價＋換算列；admin.js 方案列消耗分解＋改單價；my-schedule.js 統計列。

**Spec:** `docs/superpowers/specs/2026-07-06-package-unit-price-design.md`

## Global Constraints

- 送 `POST /api/coach/packages` 的 `amount` 一律＝`單價 × 堂數`（單價空 → null）；後端建立路徑零改動。
- `updateUnitPrice` 回寫條件：`package_id = ? AND status = 'confirmed'`（含過去堂；cancelled 不動）；同 tx 更新 `amount = unitPrice × total_sessions`、`discount_code = NULL`。
- 我的課表 stats 口徑：`one_done`=confirmed 且過去；`group_done`=confirmed、過去、`!on_leave`、`session_status !== 'cancelled'`；`leave_count`=on_leave 全期間；upcoming 沿用既有 `one_on_one_remaining`/`group_remaining`。
- 新 API 測試檔用 `X-Forwarded-For: 10.99.2.3` 假 IP（login 限流慣例）。
- commit message 結尾：`Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`。
- 單任務只跑自己的測試檔；完整套件留 controller（跑完 re-seed demo）。

---

### Task 1: 後端（updateUnitPrice＋消耗欄位＋stats＋測試）

**Files:**
- Modify: `src/services/packageService.js`（`adjustRemaining` 附近加 `updateUnitPrice`；改 `listPackagesForMember`）
- Modify: `src/server.js`（`PATCH /api/coach/packages/:id` 之後加新端點；import 併入）
- Modify: `src/services/groupOrderService.js`（我的課表回應加 `stats`）
- Test: `tests/package-unit-price.test.js`（npm test 鏈）、`tests/package-unit-price-api.test.js`（test:api 鏈）
- Modify: `package.json`（兩鏈尾各附加）

**Interfaces:**
- Produces: `updateUnitPrice({ packageId, unitPrice }) → { ok, amount, unitPrice, rewrittenBookings }`；`listPackagesForMember` 每列多 `completed_sessions`/`upcoming_sessions`；`/api/public/my` 回應多 `stats:{ one_done, group_done, leave_count, one_upcoming, group_upcoming }`；`PATCH /api/coach/packages/:id/unit-price`（requireAdmin）。

- [ ] **Step 1: packageService.js 加 `updateUnitPrice`（放 `adjustRemaining` 之後）**

```js
/** 修正單價（管理者）：amount 改為 unitPrice×total、清除折扣註記，並回寫該方案全部已登錄堂
 *  （含已上完；薪資口徑從根修正——舊期別薪資頁重開會依新單價重算，屬修正目的）。 */
export function updateUnitPrice({ packageId, unitPrice }) {
  const u = Number(unitPrice);
  if (!Number.isInteger(u) || u < 0) throw new ApiError(400, 'invalid_unit_price');
  return tx(() => {
    const p = db.prepare('SELECT * FROM customer_packages WHERE id = ?').get(packageId);
    if (!p) throw new ApiError(404, 'package_not_found');
    const amount = u * p.total_sessions;
    db.prepare('UPDATE customer_packages SET amount = ?, discount_code = NULL WHERE id = ?').run(amount, packageId);
    const r = db.prepare(
      "UPDATE bookings SET original_amount = ? WHERE package_id = ? AND status = 'confirmed'"
    ).run(u, packageId);
    return { ok: true, amount, unitPrice: u, rewrittenBookings: r.changes };
  });
}
```

- [ ] **Step 2: `listPackagesForMember` 加消耗欄位（整函式替換）**

```js
export function listPackagesForMember(memberId, { includeArchived = false } = {}) {
  const now = nowLocal();
  const rows = db.prepare(
    `SELECT cp.*, ${VALID_EXPR} AS is_valid,
            COALESCE(bc.completed, 0) AS completed_sessions,
            COALESCE(bc.upcoming, 0) AS upcoming_sessions
       FROM customer_packages cp
       LEFT JOIN (SELECT package_id,
                         SUM(CASE WHEN start_at <  ? THEN 1 ELSE 0 END) AS completed,
                         SUM(CASE WHEN start_at >= ? THEN 1 ELSE 0 END) AS upcoming
                    FROM bookings
                   WHERE status = 'confirmed' AND package_id IS NOT NULL
                   GROUP BY package_id) bc ON bc.package_id = cp.id
      WHERE cp.member_id = ? ${includeArchived ? '' : 'AND cp.archived_at IS NULL'}
      ORDER BY (cp.archived_at IS NOT NULL) ASC,
               (cp.remaining_sessions > 0) DESC,
               (cp.expires_at IS NULL) ASC, cp.expires_at ASC, cp.created_at ASC`
  ).all(now, now, todayLocal(), memberId);
  for (const r of rows) r.is_valid = !!r.is_valid;
  return rows;
}
```

（注意參數順序：兩個 now 在前——對應子查詢兩個 `?`；`todayLocal()` 對應 `VALID_EXPR` 既有的 `?`；`memberId` 最後。**先讀現行 VALID_EXPR 確認其參數位置**，若 VALID_EXPR 的 `?` 在 SELECT 列，實際順序為 SELECT 內先 today、再子查詢兩個 now、再 memberId——以現行程式碼為準調整 `.all(...)` 順序，並跑測試驗證。`nowLocal` 需從 connection.js import。）

- [ ] **Step 3: server.js 加端點（`PATCH /api/coach/packages/:id` 區塊之後）**

```js
// 修正單價：金流敏感（回寫已登錄堂、影響薪資口徑）→ requireAdmin（合法入口只有後台會員管理）。
app.patch('/api/coach/packages/:id/unit-price', requireAdmin, asyncHandler((req, res) => {
  const { unitPrice } = req.body || {};
  if (unitPrice == null) return res.status(400).json({ error: 'missing_unit_price' });
  res.json(svcUpdateUnitPrice({ packageId: Number(req.params.id), unitPrice }));
}));
```

import 併入既有 packageService import：`updateUnitPrice as svcUpdateUnitPrice`。

- [ ] **Step 4: groupOrderService.js 我的課表回應加 stats（`const items = …` 之後、return 內加欄位）**

```js
  const stats = {
    one_done: bookings.filter((b) => b.status === 'confirmed' && b.is_past).length,
    group_done: regs.filter((r) => r.status === 'confirmed' && r.is_past && !r.on_leave && r.session_status !== 'cancelled').length,
    leave_count: regs.filter((r) => r.on_leave).length,
    one_upcoming: one_on_one_remaining,
    group_upcoming: group_remaining,
  };
```

return 物件加 `stats,`。

- [ ] **Step 5: 寫 `tests/package-unit-price.test.js`**（資料鎖 2034 年、`up-%` 前綴；比照既有 service 測試風格：開頭清理、expect helper）

案例：
1. `updateUnitPrice`：建方案（10 堂、amount 9999、discount_code 'X'）＋3 筆 confirmed 堂（2 過去 1 未來）＋1 筆 cancelled → 修正單價 1500 → amount=15000、discount_code NULL、3 筆 confirmed 堂 original_amount=1500（含過去）、cancelled 不變、rewrittenBookings=3。
2. `updateUnitPrice`：unitPrice 0 合法（amount=0、堂=0）；-1／1.5／'x' → invalid_unit_price；查無 → package_not_found。
3. `listPackagesForMember`：上述方案 completed_sessions=2、upcoming_sessions=1；無預約方案兩欄=0；includeArchived 含作廢列且欄位存在。
4. 我的課表 stats：建客人（電話必填——`/api/public/my` 組裝函式以電話查）＋個別課 confirmed 過去2/未來1＋團課 confirmed 過去1（非請假）＋請假1（過去）＋pending 1（未來）＋取消場次 confirmed 1（過去）→ 呼叫該組裝函式斷言 `one_done=2、group_done=1、leave_count=1、one_upcoming=1`；`group_upcoming` 與既有 `group_remaining` 同值。
   - 組裝函式在 `groupOrderService.js`（`listScheduleViewPackages(user.id, now)` 呼叫處所在的 export 函式）——先讀該檔確認函式名與參數（以姓名＋電話查），照現行簽名呼叫。

- [ ] **Step 6: 寫 `tests/package-unit-price-api.test.js`**（req helper 帶 `'X-Forwarded-For': '10.99.2.3'`）

案例：未登入 PATCH → 401；admin 登入後：缺 unitPrice → 400 missing_unit_price；壞值 → 400 invalid_unit_price；建測試方案＋登錄 1 堂（可直接 db insert）→ PATCH 成功 200 形狀 `{ok,amount,unitPrice,rewrittenBookings}`；`GET /api/admin/payroll?period=`（該堂所在期別）該教練明細中該堂 amount＝新單價（薪資整合抽查）。結尾清理自建資料。

- [ ] **Step 7: 跑測試＋掛鏈＋commit**

```bash
node tests/package-unit-price.test.js                     # 全 ✓
lsof -ti:3000 | xargs kill 2>/dev/null
(LINE_MOCK=1 GOOGLE_CLIENT_ID=test-client-id npm start &) ; sleep 2
node tests/package-unit-price-api.test.js                 # 全 ✓
node tests/package-service.test.js && node tests/my-schedule-packages.test.js   # 既有回歸
lsof -ti:3000 | xargs kill
# package.json：test 鏈尾加 package-unit-price.test.js、test:api 鏈尾加 package-unit-price-api.test.js
git add src/services/packageService.js src/services/groupOrderService.js src/server.js tests/package-unit-price.test.js tests/package-unit-price-api.test.js package.json
git commit -m "feat: 方案修正單價（回寫已登錄堂）＋消耗欄位＋我的課表統計"
```

---

### Task 2: 前端 coach.js＋admin.js（單價輸入×2、改單價、消耗分解）

**Files:**
- Modify: `public/coach.js`（`regmNewPkgFormHtml`／`bindRegmNewPkgForm`，約 957-980 行）
- Modify: `public/admin.js`（`renderMemberPackages` 約 760-850 行）

**Interfaces:**
- Consumes: Task 1 全部端點與欄位。

- [ ] **Step 1: coach.js 開方案表單改單價＋換算列**

`regmNewPkgFormHtml` 的金額欄與其後加換算列：

```js
        <input id="regm-np-unit" class="form-input" type="number" min="0" placeholder="每堂單價（可空）" />
        <input id="regm-np-expiry" class="form-input" type="date" />
        <select id="regm-np-discount" class="form-select"></select>
        <div id="regm-np-calc" class="regm-sub" style="grid-column:1/-1;"></div>
        <button id="regm-np-create" class="btn-primary">建立方案</button>
```

（原 `regm-np-amount` 欄位移除、以 `regm-np-unit` 取代；grid 版面沿用。）

`bindRegmNewPkgForm` 改為：

```js
function bindRegmNewPkgForm(onCreated) {
  getDiscountCodes().then(codes => { const el = document.getElementById('regm-np-discount'); if (el) el.innerHTML = discountOptionsHtml(codes); });
  const calc = () => {
    const t = Number($('regm-np-total').value);
    const u = $('regm-np-unit').value;
    const el = $('regm-np-calc');
    if (!el) return;
    if (u === '' || !Number.isInteger(t) || t <= 0) { el.textContent = u === '' ? '未填單價 → 建立為「無單價」方案' : ''; return; }
    const total = Number(u) * t;
    const disc = document.getElementById('regm-np-discount')?.value;
    el.textContent = `${t} 堂 × NT$${Number(u).toLocaleString('zh-TW')} ＝ 總額 NT$${total.toLocaleString('zh-TW')}${disc ? '（套用折扣碼後以折後總額入帳）' : ''}`;
  };
  ['regm-np-total', 'regm-np-unit'].forEach(id => { $(id).oninput = calc; });
  const dsel = document.getElementById('regm-np-discount'); if (dsel) dsel.onchange = calc;
  calc();
  $('regm-np-create').onclick = async () => {
    const total = Number($('regm-np-total').value);
    if (!Number.isInteger(total) || total <= 0) { toast('請填正確堂數', 'error'); return; }
    const unit = $('regm-np-unit').value;
    if (unit !== '' && (!Number.isInteger(Number(unit)) || Number(unit) < 0)) { toast('單價需為 0 以上整數', 'error'); return; }
    try {
      const pkg = await api('/api/coach/packages', { method: 'POST', body: { memberId: regmCustomer.id, sessionType: $('regm-np-type').value, totalSessions: total, amount: unit === '' ? null : Number(unit) * total, expiresAt: $('regm-np-expiry').value || null, discountCode: document.getElementById('regm-np-discount')?.value || null } });
      toast('方案已建立', 'success');
      onCreated(pkg);
    } catch (e) { toast(`建立失敗：${e.message}`, 'error'); }
  };
}
```

- [ ] **Step 2: admin.js 方案列——消耗分解＋單價＋改單價按鈕**

`rowHtml` 的 map 改為：

```js
  const rowHtml = pkgs.map(p => {
    const arch = !!p.archived_at;
    const badge = arch ? '<span class="badge badge-cancelled" style="font-size:10px;">已作廢</span>'
      : p.is_valid ? '<span class="badge" style="font-size:10px;background:#dcfce7;color:#166534;">有效</span>'
      : '<span class="badge" style="font-size:10px;background:#fef9c3;color:#854d0e;">已失效</span>';
    const exp = p.expires_at ? `到期 ${escapeHtml(p.expires_at)}` : '永久';
    const unit = p.amount != null ? Math.round(p.amount / p.total_sessions) : null;
    const money = unit != null ? `單價 NT$${unit.toLocaleString('zh-TW')}（總額 NT$${Number(p.amount).toLocaleString('zh-TW')}）` : '無單價';
    return `<div style="display:flex;justify-content:space-between;align-items:center;gap:8px;padding:6px 0;border-bottom:1px solid #f1f5f9;">
      <div style="font-size:13px;">
        <strong>${PKG_TYPE_LABEL[p.session_type] || escapeHtml(p.session_type)}</strong>
        已上完 ${p.completed_sessions}・已約 ${p.upcoming_sessions}・未登錄 ${p.remaining_sessions}／共 ${p.total_sessions} 堂 ${badge}
        <div class="subtle" style="font-size:11px;">${exp} · ${money}</div>
      </div>
      <div style="display:flex;gap:4px;flex-shrink:0;">
        <button class="btn btn-ghost btn-sm" data-act="adjust" data-id="${p.id}" data-total="${escapeHtml(String(p.total_sessions))}" data-remaining="${escapeHtml(String(p.remaining_sessions))}">調整</button>
        ${arch ? '' : `<button class="btn btn-ghost btn-sm" data-act="unitprice" data-id="${p.id}" data-unit="${unit != null ? unit : ''}">改單價</button>`}
        ${arch
          ? `<button class="btn btn-ghost btn-sm" data-act="restore" data-id="${p.id}">還原</button>`
          : `<button class="btn btn-danger btn-sm" data-act="archive" data-id="${p.id}">作廢</button>`}
      </div>
    </div>`;
  }).join('') || '<p class="subtle" style="font-size:12px;">尚無方案</p>';
```

既有按鈕事件委派區（`data-act` switch/if 一帶——先讀現行寫法照樣式加）新增 `unitprice` 分支：

```js
      if (act === 'unitprice') {
        const cur = btn.dataset.unit;
        const v = prompt(`新的每堂單價（目前 ${cur !== '' ? 'NT$' + cur : '無單價'}）：`, cur);
        if (v == null) return;
        const n = Number(v);
        if (!Number.isInteger(n) || n < 0) { toast('單價需為 0 以上整數', 'error'); return; }
        if (!confirm(`確定將單價改為 NT$${n}？此方案所有已登錄堂（含已上完）的單價會一併修正，薪資將依新單價計算。`)) return;
        const r = await api(`/api/coach/packages/${id}/unit-price`, { method: 'PATCH', body: { unitPrice: n } });
        toast(`已修正單價並回寫 ${r.rewrittenBookings} 堂`, 'success');
        renderMemberPackages(memberId, mountEl);
        return;
      }
```

- [ ] **Step 3: admin.js 新增方案表單改單價＋換算列**

表單欄位 `pkg-amount` 改：

```js
        <input id="pkg-unit" class="form-input" type="number" min="0" placeholder="每堂單價（可空）" style="margin:0;" />
```

`pkg-discount` select 之後加 `<div id="pkg-calc" class="subtle" style="font-size:11px;margin-top:4px;"></div>`；綁 `pkg-total`/`pkg-unit` 的 `oninput`＋`pkg-discount` 的 `onchange` 做與 coach.js 相同的換算列；`#pkg-create` handler 的 amount 改：

```js
      const unitRaw = mountEl.querySelector('#pkg-unit').value;
      if (unitRaw !== '' && (!Number.isInteger(Number(unitRaw)) || Number(unitRaw) < 0)) { toast('單價需為 0 以上整數', 'error'); return; }
      // body: amount: unitRaw === '' ? null : Number(unitRaw) * total,
```

- [ ] **Step 4: 驗證＋commit**

```bash
node --check public/coach.js && node --check public/admin.js
# Playwright：登錄彈窗開方案（填 10 堂＋單價 1500 → 換算列顯示總額 NT$15,000 → 建立後下拉顯示單價 NT$1,500）；
# 後台會員彈窗：新增方案同流程；方案列顯示「已上完/已約/未登錄」與單價；改單價 prompt→confirm→toast 回寫堂數、列上單價更新；0 pageerror
git add public/coach.js public/admin.js
git commit -m "feat: 開方案改單價輸入（即時換算）＋會員方案消耗分解與改單價"
```

---

### Task 3: 前端 my-schedule 統計列

**Files:**
- Modify: `public/my-schedule.js`（方案卡區塊約 362 行前後）
- Modify: `public/style.css`（`.pk-` 樣式區附近加 `.sn-stats`）

**Interfaces:**
- Consumes: `/api/public/my` 的 `stats`。

- [ ] **Step 1: my-schedule.js 於方案卡區塊上方渲染統計列**

在渲染「我的方案」卡片的同一函式內（讀取回應物件處），方案卡容器之前插入：

```js
  // 統計列：已上課（個別/團課）・請假・即將到來；全零（新客查詢）→ 不顯示
  const st = data.stats;
  let statsHtml = '';
  if (st && (st.one_done || st.group_done || st.leave_count || st.one_upcoming || st.group_upcoming)) {
    const doneTotal = st.one_done + st.group_done;
    const upTotal = st.one_upcoming + st.group_upcoming;
    statsHtml = `<div class="sn-stats">
      <span class="sn-stat"><b>${doneTotal}</b> 已上課<span class="sn-stat-sub">個別 ${st.one_done}・團課 ${st.group_done}</span></span>
      <span class="sn-stat"><b>${st.leave_count}</b> 請假次數</span>
      <span class="sn-stat"><b>${upTotal}</b> 即將到來</span>
    </div>`;
  }
```

並插入到方案卡（或無方案時課表清單）之前的容器 HTML（先讀現行渲染流程，以最小改動掛進去）。

- [ ] **Step 2: style.css 加樣式（放 `.pk-` 卡片樣式附近，沿用站上字體變數）**

```css
.sn-stats{display:flex;gap:18px;flex-wrap:wrap;margin:14px 0 4px;padding:12px 16px;border:1px solid var(--line);border-radius:12px;background:#fff;}
.sn-stat{font-size:12px;color:var(--ink-mute);display:flex;flex-direction:column;line-height:1.3;}
.sn-stat b{font-family:"Archivo","Noto Sans TC",sans-serif;font-size:22px;font-weight:800;color:var(--ink);}
.sn-stat-sub{font-size:11px;color:var(--ink-mute);}
```

- [ ] **Step 3: 驗證＋commit**

```bash
node --check public/my-schedule.js
# Playwright：以有紀錄的 demo 客人查我的課表 → 統計列數字與資料一致（可先 API 打 /api/public/my 對數字）；新客查詢 → 無統計列；0 pageerror
git add public/my-schedule.js public/style.css
git commit -m "feat: 我的課表統計列（已上課/請假/即將到來）"
```

---

## 收尾（controller）

1. 全套 `npm test`＋server 跑 `test:api` → 全綠；re-seed demo。
2. Final review（opus；重點：回寫語意與薪資整合、參數順序、stats 口徑、XSS）。
3. Push + draft PR + preview 給業主 smoke。
