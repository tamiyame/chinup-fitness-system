# 截止後補報＋補報名多選與逐人單價 — 設計

日期：2026-08-07
狀態：已核可（業主逐節確認）
範圍：後台團課範本 drawer 補報名。後端 `groupOrderService.adminBackfillRegistration`＋`public/admin.js` 補報名面板；其他一律不動。

## 背景與問題

1. 當日課程截止判定為「未開課」後（截止～開課前的窗口），後台沒有補報名鈕——`adminBackfillRegistration` 擋 `cancelled && start_at > now`（#105 當時定案「未來流課是未知數」）。但「未開課」狀態只會在截止判定後出現，判定已存在、不是未知數；業主要求這段窗口也能補報。
2. 補報名面板一次只能選一位客人，多人要送出多次；且單價固定吃範本價，無法逐人調整。

## 決策（業主定案）

| 問題 | 決定 |
|---|---|
| 截止後補報範圍 | **所有「未開課」場次一律可補報**（移除未來擋；復活規則沿用 #105：首筆補報成功即 cancelled→confirmed 同交易）。 |
| 復活通知 | **復活當下若場次尚未開始（`start_at > now`）→ 補發一則「課程成班」通知給帶課教練**（沿用既有 `course_confirmed_coach` 模板；count＝復活後該場佔位人數（confirmed＋pending——未付補報首筆是 pending，只算 confirmed 會發「共 0 人」））。過去場次復活照舊靜默；學員照舊不發。 |
| 單價 | 第二層確認跳出**單價欄，預帶範本單堂價、可改、可 0**（免費補登）；金額進訂單與薪資營收口徑自然導出。 |
| 多選 | 可連續選多位客人（每位經過單價確認層）→ **整批一個「已收款」勾**（套用於全部）→ 一次送出。 |
| 技術路線 | 後端既有端點加**選填 `price` 參數**；前端**序列逐人呼叫既有端點**（每人各自交易／滿額候補／已報名防重／教練「新報名」通知照舊），不開批次新端點。 |

## §1 後端（`src/services/groupOrderService.js`）

`adminBackfillRegistration({ sessionId, userId, name, phone, paid, actorId, price })`：

1. **移除未來擋**：刪除 `if (s.status === 'cancelled' && s.start_at > now) throw new ApiError(409, 'session_cancelled');`（含其上方註解一併更新——cancelled 必然截止已過）。
2. **選填 `price`**：新參數 `price = null`。驗證：非 null 時必須為非負整數（`Number.isInteger(price) && price >= 0`），否則 `400 invalid_price`；null 則沿用 `tpl.price_per_session`。後續所有用價處（paid 直開已核對單的金額、未付併單的加總、`insertReg` 的 `amount_due`）一律用解析後的價。
3. **復活通知**：既有復活行（`if (s.status === 'cancelled') UPDATE … status='confirmed'`）擴充——復活成功且 `s.start_at > now` 時，查該場 confirmed 人數，`notifyCourseCoach({ coachId: s.coach_id, sessionId, type: 'course_confirmed_coach', vars: { course_name: tpl.name, start_at: s.start_at, count } })`。過去場次復活不發（維持 #105 靜默）。
4. 其他不動：滿額候補（滿額＋paid → `400 paid_requires_seat`；滿額未付 → 候補）、已報名防重、find-or-create 客人、`course_registered_coach` 逐筆通知、`promoteWaitlist` 過去守門。

Server 端點（`POST /api/admin/sessions/:id/registrations`）透傳 `price`（body 取值，不驗證——服務層驗）。

## §2 前端（`public/admin.js` 補報名面板）

互動流（取代現行單選）：

1. 搜尋既有客人 → 點選命中列，或「＋新增客人」填姓名＋電話（電話選填，規則照舊）。
2. **第二層確認列**（面板內就地展開，非另開 modal）：顯示該客人姓名＋單價輸入欄（`type="number" min="0" step="1"`，預帶範本單堂價）＋「確認」「取消」。確認後加入已選清單；取消回搜尋。
3. **已選清單**：膠囊列 `姓名 NT$價 ×`（× 移除）；可重複步驟 1-2 繼續加人；同一批內防重（同 userId 或同姓名電話組合不得重複加入）。
4. 「已收款（直接列入已核對匯款）」勾選一個、套用整批。
5. 「送出補報名（N 位）」→ **序列**逐人 `POST /api/admin/sessions/:id/registrations`（帶 `price`）→ 全部完成後彙整結果（成功 N／已報名跳過 M／候補 K／失敗原因逐人列出），成功者自已選清單移除、失敗者保留供重試；刷新 drawer 場次資料。
6. 範本單堂價來源：drawer 既有資料（渲染補報名面板時已知的範本 `price_per_session`）。

補報名鈕顯示條件（`admin.js` drawer 場次列）：移除 cancelled 未來條件，**一律顯示**。

## §3 驗證與交付

- 單元測試（`tests/admin-group-reg.test.js` 延伸）：
  - 截止後未開課（`start_at` 未到）可補報＋復活成 confirmed＋教練收到一則 `course_confirmed_coach`；
  - 過去未開課復活照舊**無**成班通知（回歸保護）；
  - `price` 覆寫：訂單金額與 registrations `amount_due` 用覆寫值；`price=0` 可；未帶 `price` 沿用範本價；`price` 非法（負數/小數/字串）→ 400 `invalid_price`。
- API 測試（`tests/admin-group-reg-api.test.js` 延伸）：body `price` 透傳生效一例。
- 單一 PR（`feature/backfill-multi-price`）；瀏覽器實測：多選（含新增客人入列）、單價改值與 0、整批已收款、部分失敗（重複報名）彙整、截止後未開課補報復活＋鈕出現；業主 smoke 後 merge。

## 明確不做（YAGNI）

- 不開批次新端點（序列呼叫既有端點）。
- 不做逐人已收款勾。
- 不發學員通知（復活與補報皆同現況）。
- 不動公開報名頁、我的課表、薪資計算邏輯（營收由訂單金額自然導出）。
