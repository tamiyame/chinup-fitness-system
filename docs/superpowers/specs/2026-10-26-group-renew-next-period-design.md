# 期課「續報下期」一鍵報名 — 設計

日期：2026-10-26　狀態：業主確認（付款期限選「保留到下期第一堂截止」）

## 背景

業主的期課招生流程：每期最後一堂先口頭詢問舊生是否續上，確認後才讓網路客人報名。後台目前只能用「補報名」一場一場加，下一期 9 場就要做 9 次。

## 需求

後台「查看場次」drawer，每一期**最後一堂**的報名名單，每位舊生列加一顆「續報下期」按鈕：一鍵把該客人報進同一門課下一期的所有場次，產生待付款訂單，業主在「報名作業 → 待核對匯款」核對收款後即完成報名。

## 規則

- **期別**：沿用固定日曆雙月（`period.js` 的 `periodOf`／`nextPeriod`）。
- **最後一堂**：該範本在該期內 `start_at` 最晚、且 `status != 'cancelled'`（未開課不算）的場次。只有它的名單出現按鈕。
- **誰有按鈕**：名單中 `status IN ('confirmed','pending')` 的列（含請假）。候補、已取消、已拒絕沒有。
- **下一期可續報場次**：同範本、`session_date` 落在下一期、`is_open = 1`、`start_at > now`，且 `status = 'confirmed'` 或（`status = 'open'` 且未過報名截止）——已過截止、尚未判定的 open 場次不報（`processDeadlines` 只計 confirmed，待付款列可能被拒而訂單金額不變）。為 0 場 → 不顯示按鈕（例如範本沒勾自動續期、下期還沒開）。下期已開課（遲來的續報）時只報剩下的場次。
- **已續報**：該客人在下一期（同範本、任何場次）已有 `pending/confirmed` 報名，或候補列（沒掛單或訂單未取消）→ 按鈕換成「已續報」，後端回 409 `already_renewed`。續報單逾期後殘留的候補列不擋再續報；再續報時這些場次維持原候補順位、不重報。
- **建立內容**（單一 tx）：
  - 未滿場次 → `pending`，單價＝範本 `price_per_session`；全部掛同一張**新**訂單（不併入既有待付款單），`total_amount = original_amount = 單價 × 場數`，不套折扣碼。
  - 已滿場次 → `waitlisted`（不收費），有訂單就掛同一張（與公開報名同慣例），並照公開報名通知該場教練有人候補。
  - 全部都滿 → 不建訂單，只排候補。
  - 該客人在某場有舊的已取消／已拒絕列 → 沿用 `reactivateReg` 復原（`UNIQUE(session_id,user_id)`）。
- **付款期限**：`expires_at = max(本單第一堂付款場次的 registration_deadline, now + 一般訂單期限)`。未核對即由既有 `expirePendingOrders` 取消、釋名額、遞補。
- **不被併單**：遞補（`promoteWaitlist`）與後台補報（未付）的併單只併進期限 ≤ now＋max(一般期限, 24h) 的待付款單；續報單期限長，不會被併入（否則新名額被長期保留、也不發遞補通知）。
- **復原舊列**：`reactivateReg` 一併重置 `on_leave = 0`（既有 helper 的漏洞，續報是新呼叫者，一起修）。
- **通知**：建單當下不發（客人是當面確認、省 LINE 額度）；核對收款時沿用 `confirmGroupOrder` 既有通知（客人收款通知、教練／管理者彙整）。
- **確認框**：按下先重抓一次續報資訊，再 `confirm()` 顯示「客人／期別／場數／金額（額滿改候補的場數）／實際付款期限」，避免手機誤觸、也避免數字過時。

## API

- `GET /api/admin/sessions/:id/renewal`（requireAdmin）→ `{ eligible:false }` 或
  `{ eligible:true, periodLabel, sessionCount, fullCount, pricePerSession, expiresAt, renewedUserIds:[...] }`
- `POST /api/admin/sessions/:id/renewal`（requireAdmin）body `{ userId }` → 201
  `{ ok, orderId, total, expiresAt, periodLabel, payCount, waitlistCount }`；
  錯誤：404 `session_not_found`／`user_not_found`、409 `not_period_last`／`no_next_sessions`／`not_registered`／`already_renewed`。

## 前端

- 場次名單展開時並行抓 roster 與 renewal（renewal 失敗不擋名單）。
- 列右側「正取」左邊：可續報 → 外框按鈕「續報下期」（天藍框，與場次開放鈕同語彙）；已續報 → 綠點「已續報」。
- 成功：toast「已續報 11–12 月 9 場，待核對 NT$…」→ 重載該名單、刷新 drawer 各場正取數、刷新待核對清單。
- 續報／取消／補報後，drawer 內其他已展開的名單一併重抓（收合的下次展開再抓），讓下一期名單與期末那堂的「已續報」同步。

## 不做

- 改單價／折扣碼（照範本價；需要時另案）。
- 整期一鍵全員續報。
- 調整自動續期對外開放的時間（目前期末前 7 天就公開下期，早於週二最後一堂；已告知業主，未改）。
