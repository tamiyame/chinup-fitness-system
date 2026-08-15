# 報價單系統 — 設計規格

- 日期：2026-08-14
- 狀態：業主已核可設計（三段逐段確認）

## 背景與目標

CHINUP 對企業/機關/學校客戶（課程包班、講座、體能專案）需要正式報價單。目前無任何報價功能。目標：後台開單管理＋一套 A4 版面三用（客戶連結線上看、列印、另存 PDF），含自動單號、歷史查詢、複製舊單、成交追蹤。

## 業主拍板決策一覽

| 題目 | 決定 |
|---|---|
| 用途對象 | CHINUP 開給企業客戶，抬頭固定 CHINUP |
| 系統形態 | 蓋在 chinup 後台（存 DB、自動單號、可查可複製） |
| 交付形式 | 列印/PDF ＋ 分享連結兩者都要 |
| 稅別計價 | 未稅單價，營業稅 5% 另計（明細未稅小計→合計→稅→含稅總計） |
| 品項輸入 | 自由填寫（不做品項庫，靠複製舊單提速） |
| 簽章方式 | 雙方留空欄（印出後手工蓋章/簽名，不印電子章） |
| 狀態追蹤 | 有效/已過期/已作廢 ＋ 手動成交標記（已成交/未成交/未標） |
| 單號格式 | `CU2026-0001`（CU 前綴＋西元年＋4 位年度流水，跨年重計） |
| 架構 | A：一套版面三用——公開頁 `/q/:token` 即 A4 版面，客戶看、列印、存 PDF 共用；後台頁籤只做管理 |

## 資料模型（開機 migration 照既有慣例純新增，無破壞性）

**`quotes`**：

- `id` INTEGER PK
- `quote_no` TEXT NOT NULL UNIQUE — 單號 `CU2026-0001`
- `token` TEXT NOT NULL UNIQUE — 分享連結亂數（`crypto.randomBytes(16).toString('hex')`，32 hex）
- `customer_title` TEXT NOT NULL — 客戶抬頭
- `customer_tax_id` TEXT — 客戶統編（選填）
- `contact_name` TEXT、`contact_phone` TEXT — 聯絡窗口（選填）
- `quote_date` TEXT NOT NULL（YYYY-MM-DD，預設今天可改）
- `valid_until` TEXT NOT NULL（預設 quote_date＋30 天可改）
- `payment_terms` TEXT、`delivery_terms` TEXT、`notes` TEXT — 付款條件/交貨期/備註，自由文字（選填）
- `subtotal` / `tax` / `total` INTEGER NOT NULL — 金額快照，存檔當下算好凍結；編輯時重算
- `deal_status` TEXT — `null`（未標）/`'won'`（已成交）/`'lost'`（未成交）
- `voided_at` TEXT — 作廢時間（null＝未作廢）
- `created_at`、`updated_at` TEXT NOT NULL

**`quote_items`**：

- `id` INTEGER PK、`quote_id` FK（ON DELETE CASCADE）、`position` INTEGER NOT NULL — 排序
- `name` TEXT NOT NULL — 品名；`spec` TEXT — 規格（選填；版面上品名粗體、規格小字疊排）
- `qty` REAL NOT NULL — 數量（允許小數如 1.5）；`unit` TEXT — 單位（堂/場/式/小時，自由填，選填）
- `unit_price` INTEGER NOT NULL — 未稅單價；`amount` INTEGER NOT NULL — 小計（存）

**金額規則**（一律伺服器端重算，不信前端數字）：

- 小計 `amount = Math.round(qty × unit_price)`
- 合計 `subtotal = Σ amount`；營業稅 `tax = Math.round(subtotal × 0.05)`；含稅總計 `total = subtotal + tax`
- 顯示一律 NT$ 千分位

**單號產生**：建立交易內 `SELECT quote_no ... WHERE quote_no LIKE 'CU<年>-%' ORDER BY quote_no DESC LIMIT 1` 取最大流水 +1，無則 `0001`；better-sqlite3 同步交易天然防撞。

**公司抬頭資訊**：沿用既有 `app_settings` 機制（匯款帳號同一套），新增 5 key：`company_name`、`company_tax_id`、`company_phone`、`company_email`、`company_address`；後台既有設定區塊加同名欄位編輯。Logo 直接用 `public/logo.png`。公開頁顯示時即時取設定值（不逐單快照）。

## API

管理端（全掛 `requireAdmin`）：

- `GET /api/admin/quotes?query=&offset=` — 列表：單號/客戶抬頭模糊搜尋、created_at DESC、前 20＋載入更多
- `POST /api/admin/quotes` — 建立（驗證＋算金額＋發單號/token），回完整 quote
- `GET /api/admin/quotes/:id` — 單筆含 items（編輯/複製新單帶入用）
- `PUT /api/admin/quotes/:id` — 全量更新（items 整組替換、金額重算、`updated_at` 更新；`quote_no`/`token` 不變）；已作廢 → 409
- `POST /api/admin/quotes/:id/void` — 作廢（寫 `voided_at`；已作廢再打 409）
- `POST /api/admin/quotes/:id/deal` — `{ deal_status: 'won'|'lost'|null }`；已作廢 → 409（作廢即終結）；已過期仍可標（實務上過期後才簽約常見）

公開端：

- `GET /api/public/quotes/:token` — 回 quote＋items＋company（app_settings 即時值）；查無 404。只認 token，不可列舉。**不回傳內部欄位**：`deal_status`（成交與否是內部資訊）與資料庫 `id` 都不出現在公開回應。
- 頁面路由 `GET /q/:token` → 出 `public/quote.html`（比照 `/line-bind` 靜態頁掛法；token 由前端從 URL 取）

「複製新單」為純前端行為：讀舊單塞進建立 drawer → 送 POST 建新單（新號、新 token、日期重設今天/＋30），後端不加專屬端點。

## 後台 UI（admin.html 第 9 個頁籤「報價單」，僅管理者可見，比照薪資頁籤守門）

沿用後台一致性語彙：`a-sec-head` 標題列、`a-row` 卡片列、前 20＋載入更多、統一空狀態；行動版靠 a-row 卡片天生自適應。

- **列表列**：單號、客戶抬頭、含稅總計、報價日期、狀態章（有效／已過期〔`valid_until` 過即自動判〕／已作廢）＋成交章（已成交／未成交／未標）
- **頂部即時搜尋**（單號、客戶抬頭），比照會員管理
- **建單／編輯 drawer**（由上而下）：客戶區（抬頭*、統編、聯絡人、電話）→ 品項動態列（品名*、規格、數量*、單位、未稅單價*；可增刪列、小計即時算）→ 日期（報價日、有效期限）→ 條款區（付款條件、交貨期、備註）→ 底部即時合計／稅 5%／含稅總計 → 儲存
- **列動作**：預覽（開 `/q/:token`）、複製連結（拷貝完整網址）、編輯、複製新單、成交標記（已成交/未成交/清除）、作廢（confirm 後唯讀不可編輯）

## 公開頁 `public/quote.html`（＝A4 列印版面，一套三用）

由上到下：

1. 抬頭：`logo.png`＋公司名稱＋統編/電話/Email/地址（app_settings）┃ 右側大字「報價單 QUOTATION」＋單號、報價日期、有效期限
2. 客戶區：客戶抬頭、統編、聯絡人/電話
3. 明細表：#、品名及規格（品名粗、規格小字）、數量、單位、單價、小計
4. 金額區：合計（未稅）、營業稅 5%、**含稅總計（粗大）**
5. 條款：付款條件、交貨期、備註（空值列不顯示）
6. 簽章：左「報價方簽章」右「客戶確認簽章」空框各附日期線
7. 工具列（僅螢幕，`@media print` 隱藏）：「列印／另存 PDF」按鈕（`window.print()`）

狀態橫幅（頁首顯眼）：已過期 →「此報價單已於 yyyy/mm/dd 失效」；已作廢 →「此報價單已作廢」；內容照常可見。

風格：白紙正式文件感＋競速天藍細節點綴（One-Sky／Tabular 數字錨點適用於單號與金額）；螢幕上置中紙感卡片、手機可讀（明細表窄螢幕 `overflow-x` 橫向捲動）；列印純淨 A4、`@media print` 只隱藏工具列與螢幕背景裝飾——**狀態橫幅屬於內容，單子已失效/作廢時列印也照印**（防過期單被拿去簽）。sheet 內必設 color 墨色（白字回歸教訓）。

## 驗證與錯誤處理（伺服器端）

- 客戶抬頭必填；至少一列品項且品名必填；`qty > 0`；`unit_price ≥ 0`（允許 0 元贈送列）；`valid_until ≥ quote_date`
- 驗證失敗 400 帶訊息；token 查無 → 公開頁顯示「找不到報價單」友善畫面；作廢單 PUT/deal → 409
- 不掛任何 LINE/email 通知（自己開單，無通知對象）

## 權限與安全

- 管理六端點 `requireAdmin`；頁籤 admin-only
- 公開端點只認 32-hex 亂數 token，無法列舉；不洩漏內部 id

## 測試（`tests/quote.test.js`，照 repo 慣例）

- 單號：年度流水遞增、跨年從 0001 重計、連續建立不撞號
- 金額：小計/稅四捨五入、伺服器端重算覆蓋前端假數字
- 驗證：缺抬頭/空品項/qty≤0/效期早於報價日各 400
- 作廢守門：作廢後 PUT 409、deal 409、再作廢 409
- token：公開端點查得、假 token 404
- 編輯：items 整組替換、金額重算、單號 token 不變
- API 權限：非 admin 全端點 403
- 注意：`npm test` 會洗 demo DB，測完照慣例 re-seed

## 部署與上線後人工步驟

- merge main → Railway 自動部署；migration 開機自動建表（純新增，不需先備份）
- 上線後業主一次性：後台設定區補填公司名稱、統一編號、電話、Email、地址

## 範圍外（YAGNI）

- 常用品項庫、電子印章圖檔、伺服器端產 PDF（puppeteer）、多稅率/含稅模式切換 UI（稅率寫死 5%）
- LINE/email 通知、報價單轉訂單/合約、客戶簽回上傳、報價成交率報表（deal_status 欄位已留，日後要做隨時能加）
