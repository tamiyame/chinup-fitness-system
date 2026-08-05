# 綁定 LINE 直達頁 — 設計

日期：2026-08-05
狀態：已核可（業主確認）
範圍：新增 `public/line-bind.html`＋門面頁尾入口＋後台一個設定欄；產碼端點與 webhook 綁定邏輯零改動。

## 背景與問題

客戶自助綁定 LINE（PR #65）目前藏在「我的課表」：客人要先查詢課表，navbar 才出現「綁定 LINE」按鈕。業主要一條**可以直接給客人點的超連結**，放在 LINE 官方帳號（歡迎訊息/圖文選單）、官網頁面、社群文宣（含 QR）、教練一對一傳送——四處都會用。

不可省的環節（安全底線）：**驗身分**（電話＋姓名，防止任意人把自己的 LINE 綁到他人帳號）與**把 6 碼送進官方帳號**（webhook 以碼認人）。直達連結優化的是路徑，不是省略驗證。

## 決策（業主定案）

| 問題 | 決定 |
|---|---|
| 形式 | **獨立極簡頁 `public/line-bind.html`**，固定網址四處可放；不動我的課表既有彈窗。 |
| 收尾體驗 | **一鍵開 LINE 自動帶碼**：oaMessage 深連結直達官方帳號聊天室、訊息欄預填 6 碼；後台未設定官方帳號 ID 時自動退回「複製碼＋開官方 LINE」模式。 |
| 不採 | 我的課表 `?bind=1`（仍繞路、整頁課表是雜訊）；LINE Login/LIFF（需多開 channel，單店維運不划算）。 |

## §1 頁面與流程（`/line-bind`）

- **樣式**：天藍海報門面語彙（載入 `colors_and_type.css`＋`style.css`＋`facade.css`），同 login 的白紙卡 pattern：藍底、`.card.fa-sheet` 白紙表單、方角、kicker 標題。手機優先（主要在 LINE 內建瀏覽器開啟）。
- **步驟一・驗身分**：欄位＝電話（`tel`/numeric）＋姓名，按「取得綁定碼」→ `POST /api/public/line/bind-code`（既有端點，body `{phone, name}`）。
  - 錯誤態（對準端點實際碼）：`403 not_found_or_mismatch`（查無/姓名不符/員工帳號守門共用一碼，防探測）→ 「查無資料，請用預約時填的電話與姓名」；`409 already_bound` → 顯示「✓ 此帳號已綁定 LINE，會直接收到通知」（成功語氣，非錯誤）；限流 `429` → 「操作太頻繁，請稍後再試」；其他 → 通用錯誤。
- **步驟二・拿到碼**：大字顯示 6 碼（等寬、可長按選取複製）＋「綁定碼 15 分鐘內有效」。
- **步驟三・送碼**：
  - 回應含 `line_official_id`（@開頭）時，主按鈕「**開啟 LINE 傳送綁定碼**」→ `https://line.me/R/oaMessage/{encodeURIComponent(@id)}/?{encodeURIComponent(code)}`——聊天室開啟且訊息欄已填 6 碼，客人按送出即完成。
  - 上方固定顯示「先加入官方 LINE 好友」按鈕（`line_official_url`，既有設定）——尚未加好友者先加（oaMessage 對非好友會先跳加好友畫面，預填可能遺失，故加好友獨立成一步）。
  - `line_official_id` 空 → 退回複製模式：顯示 6 碼＋「點我加入官方 LINE」連結＋三步驟說明（同我的課表彈窗文案）。
  - 頁尾提示「綁好後即可關閉此頁；之後的預約與提醒會直接傳到你的 LINE」。
- **入口**：`index.html`／`group.html`／`coaches.html` 頁尾（`.fa-foot` 區）各加一條低調連結「綁定 LINE 通知」→ `/line-bind`。我的課表既有按鈕與彈窗**原樣不動**。
- **網址**：`GET /line-bind` 乾淨路由（比照 `/my-schedule` 慣例）；QR/圖文選單直接用 `https://chin.up.railway.app/line-bind`。

## §2 後台設定與技術面

- **新設定**：`app_settings.line_official_id`（預設空字串）。後台既有「官方 LINE 連結」欄位旁新增「LINE 官方帳號 ID（@開頭，例：@chinup）」輸入欄，同一張設定卡、同一儲存流程。
  - 驗證：允許空（＝關閉一鍵帶碼、退回複製模式）；非空時 trim；未以 `@` 開頭則儲存時自動補 `@`。
- **後端改動（僅三小處）**：
  1. `schema.js`：`INSERT OR IGNORE` 新 key（比照 `line_official_url`）。
  2. 設定讀寫端點：GET 回傳＋PATCH 寫入 `line_official_id`（比照 `line_official_url` 的寫法與驗證位置）。
  3. `POST /api/public/line/bind-code` 回應多帶 `line_official_id`（沿用回 `line_official_url` 的同一處）。
- **零改動**：`requestPublicBindCode`（驗名/role 守門/已綁 409/限流）、webhook 綁定流程、我的課表前端。
- **測試**：settings API 測試補 `line_official_id` 讀寫案例；`node --check` 新前端 JS（若為 inline script 則免）；本地瀏覽器實測四態（產碼成功含深連結、已綁 409、查無資料、未設 ID 退回複製模式）＋門面頁尾入口連結。

## 驗證與交付

- 單一 PR（`feature/line-bind-page`）：頁面＋入口連結＋設定欄＋schema key＋端點小改＋測試。
- 本地 smoke 給業主過目後 merge；merge 後業主於後台填入官方帳號 ID 即啟用一鍵帶碼。

## 明確不做（YAGNI）

- 不做 LIFF/LINE Login。
- 不動我的課表既有綁定彈窗（未來如要統一導到新頁另案）。
- 不做後台 QR 產生器（網址固定，業主可用任意工具產 QR；要內建再另案）。
- 不做連結帶參數預填電話（個資不進 URL）。
