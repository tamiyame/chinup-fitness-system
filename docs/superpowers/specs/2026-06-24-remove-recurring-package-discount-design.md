# 移除公開頁循環預約 + 方案建立加折扣碼 — 設計文件

> 日期：2026-06-24
> 範圍：單一 PR（PR4，建立在 PR1 方案 / PR2 登錄 / PR3 編輯 之上）。兩個獨立小改：A 移除舊公開頁循環（含端點）、B 方案建立加折扣碼下拉。
> 業主已於 brainstorming 拍板（見「已拍板決策」）。

## 問題
1. 教練後台「登錄預約」已可排課（含回頭補登、進階循環），公開預約頁的舊「開啟循環預約（員工排課）」變多餘 → 移除（含後端舊端點）。
2. 方案建立時希望能套折扣碼：在「方案建立」表單加折扣碼**下拉**，每碼以灰字說明是百分比或定額折扣。

## 背景（已查證，含 file:line）
- **舊公開頁循環 UI**：`public/coaches.html:93-129`（`#recurring-row`/`#recurring-fields`：頻率/次數/間隔/markPaid/預覽）。`public/coaches.js` handlers：`recurringState`(482)、`recurringEnabled`(620)、`invalidateRecurringPreview`、預覽/送出的循環分支、估價列（~481-660）。開窗重置在 `openBookingModal`(~604-613)。
- **舊循環後端**：路由 `POST /api/bookings/recurring/preview`(server.js:1033)、`POST /api/bookings/recurring`(1044)；import `previewRecurringBookings as svcPreviewRecurring, createRecurringBookings as svcCreateRecurring`(server.js:41-42)。service：`bookingService.js` 的 `RECURRING_FREQS`、`_validateRecurringParams`、`recurringOccurrences`、`_occurrenceAvailable`、`previewRecurringBookings`、`createRecurringBookings`（約 416-551，舊版）。測試 `tests/recurring-booking.test.js`(unit)、`tests/recurring-booking-api.test.js`(api)。
- **保留（新登錄仍用）**：`recurring_group_id` 欄；群組付款/取消/退款（`confirmBookingPaymentGroup`/`cancelBookingAdminGroup`/`refundBookingGroupAdmin`）；`listPendingPaymentBookings`/`listConfirmedPayments` 的群組合併；新 `expandRecurrence`（PR2 登錄循環用）；`createCoachRegister`（會設 recurring_group_id）。
- **折扣 service**（`src/services/discountService.js`）：`validateDiscount({code,phone,subtotal})` 純驗證（會擋 max_uses/per_phone 用量）；內部 `computeDiscount(type,value,subtotal)`、`getCodeStmt`、`normalizeCode`、`todayLocal`；`listDiscountCodes()`（全部，admin 用，server.js:1246 `GET /api/admin/discount-codes`）。percent 的 `discount_value`＝折讓百分比、fixed＝折抵金額。
- **方案表/服務**（PR1）：`customer_packages`（無折扣欄）；`createPackage({memberId,sessionType,totalSessions,amount,expiresAt,note,createdBy})`（src/services/packageService.js）。
- **方案建立表單兩處**：① 登錄彈窗 `public/coach.js` `renderRegmPicked` 的無方案「開方案」表單（type/total/amount/expiry/note）② 會員管理 `public/admin.js` `renderMemberPackages` 的「新增方案」`<details>` 表單。
- 方案端點 `POST /api/coach/packages`（server.js，requireCoach）。

## 已拍板決策（業主，brainstorming 2026-06-24）
1. **折扣語意＝記碼＋存折扣後金額，不限用量**：輸入「金額」視為原價；選碼→存折扣後金額於 `amount`＋記 `customer_packages.discount_code`；**不檢查/不扣用量上限、不記 redemption**（方案是後台手動工具）。
2. **下拉加在兩處方案建立表單**（登錄彈窗 + 會員管理方案區塊）。
3. **移除舊循環＝連端點一併移除**（UI + 路由 + 舊 service 函式 + 舊測試）。
4. 灰字格式：percent→「N% 折扣」；fixed→「折抵 $N」。下拉含「不使用折扣碼」選項。

## 架構

### A. 移除舊公開頁循環
- **前端 coaches.html**：刪除 `#recurring-row` 與 `#recurring-fields` 兩個區塊（93-129）。
- **前端 coaches.js**：刪除循環相關狀態與函式（`recurringState`、`recurringEnabled`、`invalidateRecurringPreview`、循環預覽/送出分支、估價列中依賴循環的計算），`openBookingModal` 移除循環重置，送出一律走單筆 `POST /api/public/bookings`。session-type 切換不再 `invalidateRecurringPreview`。
- **後端 server.js**：刪除兩條 recurring 路由與其 import。
- **後端 bookingService.js**：刪除 `RECURRING_FREQS`、`_validateRecurringParams`、`recurringOccurrences`、`_occurrenceAvailable`、`previewRecurringBookings`、`createRecurringBookings`。確認無其他引用（新 `expandRecurrence`/`createCoachRegister` 不依賴舊函式；`computeAvailableSlots`/`assertBookableTx` 仍被其他流程用，不刪）。
- **測試**：刪 `tests/recurring-booking.test.js`、`tests/recurring-booking-api.test.js`，並自 `package.json` 的 `test`/`test:api` 移除該兩行。

### B. 方案建立加折扣碼
- **Schema**：`customer_packages` 加 `discount_code TEXT`（schema.js CREATE TABLE 內 + connection.js `addColumnIfMissing('customer_packages','discount_code','TEXT')`）。
- **discountService**：
  - `listActiveDiscountCodes()` → `SELECT code, discount_type, discount_value FROM discount_codes WHERE active=1 AND (valid_from IS NULL OR valid_from<=today) AND (valid_until IS NULL OR valid_until>=today) ORDER BY code ASC`。
  - `quoteDiscount({code, amount})` → normalize；查碼；`!c||!c.active`→409 `code_inactive`；效期外→`code_not_started`/`code_expired`；`computeDiscount(type,value,amount)`；回 `{code:c.code, discountAmount, finalTotal}`。**不查 max_uses/per_phone**。空 code→回 null。
- **packageService.createPackage** 加 `discountCode=null`：算出 `amt`（原價，沿用既有驗證）後，若 `discountCode` 非空 → `const q=quoteDiscount({code:discountCode, amount:amt}); amt=q.finalTotal; codeStored=q.code;`；INSERT 多寫 `discount_code`。回傳物件含 `discount_code`。
- **端點**：`GET /api/coach/discount-codes`（requireCoach）→ `listActiveDiscountCodes()`。`POST /api/coach/packages` body 多收 `discountCode`，傳入 createPackage。
- **前端**：
  - `coach.js` `renderRegmPicked` 開方案表單加 `<select id="regm-np-discount">`（先「不使用折扣碼」+ 各 active 碼）；建立時 body 帶 `discountCode`。開窗時 fetch `GET /api/coach/discount-codes`（可快取於模組變數）。
  - `admin.js` `renderMemberPackages` 新增方案表單同樣加折扣下拉（`#pkg-discount`），POST 帶 `discountCode`。
  - option 文字：`代碼` + 灰字 `（{value}% 折扣）`(percent) / `（折抵 ${value}）`(fixed)。用 `<option>代碼 — N% 折扣</option>` 形式（option 無法分色，灰字以破折號附註呈現）。
  - 方案清單（renderMemberPackages 列／登錄方案 select）可在有 `discount_code` 時附顯示（次要、非必要）。

## 安全/守門
- `GET /api/coach/discount-codes`：requireCoach（管理者亦可）；只回 code/type/value（不洩 max_uses/redemption）。
- `quoteDiscount` 仍驗 active + 效期（避免套用停用/過期碼），只是略過用量上限（依決策「不限用量」）。
- 折扣後金額不為負（`computeDiscount` 既有行為；fixed 超過原價時 finalTotal 取 0/既有處理）。

## 不動
- PR1/2/3 既有功能；新登錄循環（expandRecurrence/createCoachRegister）與群組付款操作；一對一/團課既有折扣流程（applyDiscountTx/redemption，照舊）。
- 公開頁單筆預約流程（移除循環後，公開頁僅單筆）。

## 測試
- `tests/package-discount.test.js`（unit）：`quoteDiscount`（percent/fixed 計算、停用→409、過期→409、空→null、不受 max_uses 影響）；`createPackage` 帶 percent 碼→amount=折讓後+discount_code 記入、帶 fixed 碼→折抵後、無碼→amount 原值 discount_code null、停用碼→擋。掛 `test`。
- `tests/package-api.test.js`（既有，擴充）：`GET /api/coach/discount-codes` 回 active 碼陣列；`POST /api/coach/packages {discountCode}` → 回傳 amount 折扣後 + discount_code。
- 移除：`recurring-booking*.test.js` 兩支自 scripts 移除並刪檔。
- 回歸：booking/付款群組/登錄(coach-register)/編輯(booking-edit) 測試不破壞（移除舊循環不影響它們）。

## 收尾
- 瀏覽器 smoke：公開頁預約彈窗已無循環區塊、單筆可訂；登錄彈窗開方案可選折扣碼→建立後金額為折扣後；會員管理新增方案同樣可選折扣碼。實作收尾移除任何暫存 mock。

## 不做（YAGNI）
- 不在方案折扣記 redemption / 不限用量（決策）。
- 不保留舊循環任何死碼。
- 不改一對一/團課的折扣流程。
- 不做方案折扣的原價/折後雙欄（只存折後 amount + 碼）。
