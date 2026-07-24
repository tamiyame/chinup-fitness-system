# 一致性改版共用詞彙（定稿——所有任務起草者以此為準，逐字使用，不得自行變體）

## A. 骨架 CSS（Task 1 會插入 admin.html `<style>` 內、`.empty-state` 區塊之前）

```css
/* ---------- 一致性骨架：區塊標題列 + 單卡包列 + 載入更多 ---------- */
.a-sec-head{ display:flex; align-items:center; gap:12px; margin-bottom:16px; flex-wrap:wrap; }
.a-sec-head .section-title{ white-space:nowrap; }
.a-sec-line{ flex:1; height:1px; background:var(--line); min-width:24px; }
.a-sec-tools{ display:flex; align-items:center; gap:8px; flex-wrap:wrap; }
.a-sec-tools .form-input{ margin-bottom:0; }
.a-search{ max-width:240px; }
.a-filter{ max-width:140px; }

/* .a-rows 為語意標記 class（清單容器），無 CSS 規則 */
.a-row{ padding:14px 16px; border-bottom:1px solid var(--line); display:grid; grid-template-columns:1fr auto; gap:6px 16px; align-items:center; }
.a-row:last-child{ border-bottom:none; }
.a-row:hover{ background:var(--brand-50); }
.a-row-main{ min-width:0; }
.a-row-title{ display:flex; align-items:center; gap:8px; flex-wrap:wrap; }
.a-row-sub{ margin-top:4px; }
.a-row-actions{ display:flex; gap:8px; align-items:center; flex-wrap:wrap; justify-content:flex-end; }
@media (max-width:767px){
  .a-row{ grid-template-columns:1fr; }
  .a-row-actions{ justify-content:flex-start; }
}

.a-more{ display:block; width:100%; border-top:1px solid var(--line); text-align:center; }
```

使用規則：
- 區塊標題列一律：`<div class="a-sec-head"><h2 class="section-title">標題</h2><span class="a-sec-line"></span><div class="a-sec-tools">…右側工具…</div></div>`（無工具時省略 `.a-sec-tools`）。
- 卡內列：外層 `<div class="card p-0 overflow-hidden">`，內層清單容器沿用既有 id（如 `#templates`）但 class 改 `a-rows`；每筆列保留原元素標籤（`article` 者維持 `article`）class 改 `a-row`，內部：`<div class="a-row-main"><div class="a-row-title">…名稱+badge…</div><div class="a-row-sub">…meta…</div></div><div class="a-row-actions">…鈕…</div>`。
- **`.card-title` class 必須保留在名稱元素上**（報名作業 confirm 依賴 `closest('article').querySelector('.card-title')`）。
- 空狀態統一：`<div class="empty-state"><svg…nk-empty-ico…>…</svg><p>主文</p><p class="subtle text-sm">副文</p></div>`（沿用各頁現有 ICO；原本素字空狀態改成這個）。載入中：`<div class="p-6 subtle text-center">載入中…</div>`。錯誤：`<div class="p-6 text-red-500 text-center">…</div>`。

## B. 載入更多 helper（Task 1 插入 admin.js：`__redirected_by_auth__` throw 行之後、`const ROLE_LABEL` 之前）

```js
// 通用「前 N 筆＋載入更多」：純前端 slice。key 區分各清單的 shown 狀態；
// 搜尋/篩選 handler 先 _shownMap.delete(key) 再呼叫 render 即重設回 PAGE。
const PAGE = 20;
const _shownMap = new Map();
function limitSlice(key, items) {
  if (!_shownMap.has(key)) _shownMap.set(key, PAGE);
  const shown = _shownMap.get(key);
  return { visible: items.slice(0, shown), rest: Math.max(0, items.length - shown) };
}
function moreButtonHtml(key, rest) {
  if (rest <= 0) return '';
  return `<button type="button" class="btn btn-ghost a-more" data-more-key="${key}">載入更多（還有 ${rest} 筆）</button>`;
}
function bindLoadMore(container, rerender) {
  const btn = container.querySelector('[data-more-key]');
  if (btn) btn.addEventListener('click', () => {
    _shownMap.set(btn.dataset.moreKey, (_shownMap.get(btn.dataset.moreKey) || PAGE) + PAGE);
    rerender();
  });
}
```

呼叫模式（各清單一致）：
```js
const { visible, rest } = limitSlice('members', filtered);
el.innerHTML = tableHtml(visible) + moreButtonHtml('members', rest);
bindLoadMore(el, () => renderUsersTable());
```
- key 命名：`'templates' | 'pending' | 'confirmed' | 'members' | 'line' | 'notifs' | 'discounts' | 'coaches'`。
- **定案：搜尋/篩選的事件 handler 內先 `_shownMap.delete('key')` 再呼叫原 render**；render 內永遠 `limitSlice(key, items)`，`limitSlice` 無 reset 參數。

## C. 紅線（逐字抄自 spec §4）

1. JS 契約零改動：所有 `#id` 掛載點、`.cat-edit/.cat-del/.edit-btn/.view-btn/.del-btn/.confirm-*-btn/.cancel-*-btn/.dc-*-btn/.toggle-active/.demote-btn/[data-line-unbind]` 等按鈕 class 與 dataset、`tr.user-row` 長按、`.confirmed-payment-row` 長按與 data-*、drawer 全家（`.session-*`/`.reg-cancel`/`.backfill-panel` 家族）、`.coach-color-*` 家族、`.pr-*`/`.sh-*` 家族、`td.cell-*`/`data-label` RWD 契約。
2. 散卡→列保留 `article` 元素與 `.card-title`。
3. 只改輸出 HTML 骨架，不改資料流、事件綁定方式、API 呼叫。
4. `.data-table` 卡片化 RWD 照舊。
5. CSS 一律放 admin.html inline。
6. 文案繁體中文；不加新功能；互動模式（長按/prompt/confirm/badge 假按鈕）照舊。

## D. 驗證（每任務）

- `node --check public/admin.js`（動 js 時）＋改動後 grep 驗證關鍵 class 仍在。
- 瀏覽器驗證由 controller 統一於每批 PR 完成後執行（任務內不用瀏覽器）。
