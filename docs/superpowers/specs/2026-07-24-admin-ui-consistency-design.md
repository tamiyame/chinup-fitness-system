# 管理後台 8 頁籤一致性改版 — 設計

日期：2026-07-24
狀態：已核可（業主逐節確認）
範圍：`public/admin.html`＋`public/admin.js`，純前端、零後端、零 API 改動。

## 背景與問題

管理後台 8 個頁籤（課程／報名作業／會員／教練／折扣碼／通知／LINE 管理／薪資計算）各自演化出不同的區塊語彙。盤點（9 agents 平行掃描）結論：

- **區塊標題 4 種寫法**：`.section-title`／裸 `div.font-semibold`／`h3.font-semibold`／`h3.font-bold`（薪資頁另有 `.sh-h4`）。
- **內容外框 3 種**：卡包表（`.card.p-0` + `.data-table`）／裸 grid 散卡（範本、待核對、已核對、折扣碼列表、教練列表）／白卡表單。
- **空狀態 3 種**：`.empty-state`+SVG／`p-6 subtle text-center` 素字／`text-slate-500` 素字。
- **長清單策略不一**：通知用 24rem 內捲小窗、其他一頁到底；會員/LINE 有搜尋、其他沒有；「已核對匯款」是只增不減的歷史帳、最痛。
- **搜尋/篩選位置不一**：會員/LINE 塞在標題行內（inline style 撐版），其他頁籤右側放按鈕。
- DESIGN.md 已定義「行語法」signature（錨點欄＋內容＋狀態、列間髮絲線）但後台從未落地。

## 決策（業主定案）

| 問題 | 決定 |
|---|---|
| 統一方向 | **A：單卡包列（行語法）**——每區塊「標題列＋一張卡」，清單類內容改為卡內列表列，散卡收斂。 |
| 長清單收斂 | **前 20 筆＋「載入更多」**（通用 helper，全清單一體適用，>20 筆才顯示按鈕）。 |
| 功能 | **全部保留**：JS 契約（id/class/data-attr/dataset/委派選擇器）零改動；長按、drawer 補報名、badge 假按鈕、原生 confirm/prompt 互動照舊。 |
| 交付 | 3 批 PR、皆 base main 序列合併；每批 localhost 過目後才 merge。 |

## §1 統一區塊語法

新增（admin.html inline `<style>`）：

- **`.a-sec-head`**：區塊標題列。左＝既有 `.section-title`（Archivo 800 14px 大寫）補上**髮絲尾線延伸**（flex:1 的 1px var(--line)，同 `.nk-kicker::after` 語彙）；右＝`.a-sec-tools`（flex gap:8px）——**按鈕、搜尋框、篩選器一律歸位在此**。搜尋框統一 `max-width:240px`、select `max-width:140px`，以 class 取代現有 inline style。
- **`.a-rows` / `.a-row`**：單卡（`.card.p-0.overflow-hidden`）內的列表列。`.a-row`＝`padding:14px 16px`＋`border-bottom:1px solid var(--line)`（末列去線）＋`:hover` 背景 `var(--brand-50)`；內部 grid `[1fr auto]`：左＝主行（名稱＋badge）＋次行（meta，沿用 `.meta-item` 語彙）；右＝動作鈕群（`display:flex; gap:8px; align-items:center; flex-wrap:wrap`）。`<768px`：右鈕群換行到底部、meta 允許 wrap（新增一小段 RWD 規則）。
- **空狀態統一**：一律 `.empty-state`（既有 SVG `nk-empty-ico`＋主文＋`subtle` 副文），置於卡內；載入中＝`<div class="p-6 subtle text-center">載入中…</div>`；錯誤＝`p-6 text-red-500` 置中。三態全後台同一寫法。
- **`.a-more`**：載入更多鈕容器——卡底全寬 `.btn.btn-ghost`，文案「載入更多（還有 N 筆）」。

## §2 「前 20 筆＋載入更多」通用 helper

`admin.js` 新增一個通用函式（概念簽名）：

```js
// renderLimited(items, renderFn, mountEl, state) — 純前端 slice
// state = { shown: 20 }（每個清單各自持有）；「載入更多」點擊 shown += 20 後重繪；
// 搜尋/篩選變更時呼叫端重設 shown = 20。items.length <= shown 時不顯示按鈕。
```

套用清單：會員表、LINE 表、通知表、已核對匯款、折扣碼列表、課程範本、待核對、教練列表（後三者通常少量、自然無感）。資料流與 API 零改動（`allUsers` 等既有快取照用）。

## §3 各頁籤落地

| 頁籤 | 變化 |
|---|---|
| 課程 | 分類表照舊（已合規）；**範本散卡→單卡包列**（主行＝名稱＋已發布 badge；次行＝六 meta；右鈕＝編輯/查看場次/刪除）；統計四卡與備份列**維持現狀**（自成語彙、非痛點）；場次 drawer、範本 modal 不動 |
| 報名作業 | **待核對三型卡→單卡包列**（主行＝姓名＋類型/待核對 badge；次行＝meta＋場次子清單；右鈕＝已收款/取消直欄改列內鈕群）；**已核對→單卡包列**＋載入更多；空狀態統一；系統操作卡照舊；長按取消退款照舊（`.confirmed-payment-row` class 與 dataset 保留） |
| 會員 | 表格照舊；搜尋框＋「顯示已封存」勾選移入 `.a-sec-tools`；套載入更多；長按編輯照舊 |
| 通知 | **移除 `max-h-96` 內捲**，改一致卡包表＋載入更多；「(最近 100 筆)」註記移為標題列右側 subtle 字 |
| LINE 管理 | 搜尋/篩選歸位 tools（去 inline style）；套載入更多；右側說明文字移到區塊下方 subtle 行 |
| 折扣碼 | 三張設定卡＋建立表單卡標題統一 `h3.card-title`；**列表散卡→單卡包列**（主行＝碼名 mono＋型態/啟用 badge；次行＝meta；右鈕＝停用/編輯/刪除）；套載入更多 |
| 教練 | **列表散卡→單卡包列**（色點鈕＋姓名＋狀態 badge＋email·specialty 次行＋右鈕）；狀態彩字 span→`.badge`（啟用中＝badge-open、待啟用＝badge-waitlisted）；建立帳號卡標題統一 `h3.card-title`；**coach-color 系列 CSS 自 style.css 搬入 admin.html inline 歸位**（style.css 原段落移除）；色盤互動照舊（panel 為 `.a-row` 的兄弟節點，展開邏輯不變） |
| 薪資 | 「抽成設定」「駐場出勤」標題 `h3.font-bold`→`h3.card-title`；期別/彙總照舊（已合規）；`sh-*` 特化元件（週表/藥丸/chip/複合膠囊）全保留；彙總表可展開明細照舊 |

## §4 功能保留硬約束（實作紅線）

1. 下列 JS 契約**零改動**（盤點全清單見 plan）：所有 `#id` 掛載點、`.cat-edit/.cat-del/.edit-btn/.view-btn/.del-btn/.confirm-*-btn/.cancel-*-btn/.dc-*-btn/.toggle-active/.demote-btn/[data-line-unbind]` 等按鈕 class 與 dataset、`tr.user-row` 長按、`.confirmed-payment-row` 長按與 data-*、drawer 全家（`.session-*`/`.reg-cancel`/`.backfill-panel` 家族）、`.coach-color-*` 家族、`.pr-*`/`.sh-*` 家族、`td.cell-*`/`data-label` RWD 契約。
2. 散卡→列時**保留 `article` 元素與 `.card-title` class**（報名作業 confirm 對話框靠 `closest('article').querySelector('.card-title')` 取姓名）；只把外層 `class="card"` 換成列語彙 class，JS 選擇器不受影響。
3. 渲染函式只改「輸出的 HTML 骨架」，不改資料流、事件綁定方式（逐鈕綁定/委派維持現狀）、API 呼叫。
4. `<768px` 既有 `.data-table` 卡片化 RWD 照舊；`.a-row` 補堆疊規則。
5. CSS 一律放 admin.html inline（既有慣例：蓋 overlay）；本次順手把 coach-color 從 style.css 歸位。

## §5 交付與驗證

- **PR1**（`feature/admin-ui-consistency-1`）：骨架 CSS（a-sec-head/a-rows/a-row/a-more/空狀態統一）＋`renderLimited` helper＋課程＋報名作業。
- **PR2**（`feature/admin-ui-consistency-2`，PR1 merge 後自 main 開）：會員＋LINE＋通知。
- **PR3**（`feature/admin-ui-consistency-3`）：折扣碼＋教練＋薪資＋style.css coach-color 段移除。
- 驗證：`node --check` 兩檔＋瀏覽器逐頁籤實測（每批涵蓋：該批頁籤全部 CRUD 動作、長按、drawer 補報名/取消、載入更多、搜尋/篩選重設、<768px 檢視）；每批 localhost 給業主/開發者過目後才 merge。
- 無自動化前端測試（現狀如此）；後端測試不受影響（零後端改動）。

## 明確不做（YAGNI）

- 不改資訊架構（頁籤名稱/歸屬不動，折扣碼頁的雜項設定不搬家）。
- 不改互動模式（長按不改成顯性按鈕、prompt/confirm 不改自製彈窗、badge 假按鈕不改 btn）。
- 不加新功能（通知不加篩選、會員不加排序）。
- 不動 coach.html／其他頁面。
- 統計卡 N+1 請求等效能問題不在本次範圍（另案）。
