# 過去「未開課」場次可補報名（補報即復活）— 設計

日期：2026-07-13
狀態：已核可（業主逐節確認）
前情：PR #104（後台補報名/取消）把 `status='cancelled'`（未開課）場次一律擋在補報名之外。業主實務上需要在「時間已過」的未開課場次補登實際有上課的客人。

## 決策（業主定案）

| 問題 | 決定 |
|---|---|
| 補報名後場次狀態 | **自動復活成「已成班」**（cancelled → confirmed）。語意＝補報名代表這堂課實際有上。 |
| 開放範圍 | **只限過去場次**（`start_at <= now`）。未來的未開課維持不可補——「未來的時間都還沒有到，流課是未知數，要等時間過了才知道」。 |
| 通知 | 沿用既有定案：只通知教練（course_registered_coach），客人不通知。 |
| 取消到 0 人 | **不自動回退**成未開課。管理者看名單自行判斷，不做回退機制。 |

## 行為規則

1. 過去且 `status='cancelled'` 的場次可補報名；未來的 cancelled 後端維持 409 `session_cancelled`，前端不顯示補報名鈕。
2. 第一筆補報名成功（paid 或 pending 皆算）時，同一交易內把場次 `cancelled → confirmed`。
3. 復活後三個口徑**零程式改動、自然導出**：
   - 薪資：`payrollService` 的 `s.status != 'cancelled'` 過濾自然放行；營收計 `confirmed` 且非請假的報名（pending 未核對前不計，核對後轉 confirmed 才計）。
   - 客人「已上課」統計：`session_status !== 'cancelled'` 過濾自然放行。
   - 公開頁：state 推導 `cancelled→not_held`、`過去非cancelled→ended`，復活後自動顯示「已結束」。
4. 補報名其餘規則照舊：已收款→獨立已核對單；未付→併入未逾期 pending 單（72h 未核對被 sweep 取消）；不支援折扣碼；滿額過去場 409（cancelled 場次的原報名都已 rejected，不佔名額，實務上不會滿）。
5. 原被判未開課而改 `rejected` 的客人再被補報時，走既有 dup-reactivate 復原同一列（`rejected` 不在 already_registered 阻擋清單）。**不**自動復活其他 rejected 的人——補誰算誰。
6. 已知邊界（接受）：
   - 未付補報後 72h 沒核對被 sweep 取消 → 場次留在 confirmed、0 有效報名（「空成班」）。薪資該場 headcount/revenue 為 0，無實害。
   - 場次被判未開課時，`on_leave=1` 的 confirmed 列不會被改 rejected（既有行為）；復活後這些請假列照常顯示，準確。

## 後端改動（`src/services/groupOrderService.js`，兩處）

- `adminBackfillRegistration` 擋點放寬：
  `if (s.status === 'cancelled' && s.start_at > now) throw new ApiError(409, 'session_cancelled')`
  （`now` 移到擋點前取得，isPast 沿用同一值。）
- 主路徑建立報名成功後（notify 前）：若原 `s.status === 'cancelled'` → `UPDATE course_sessions SET status='confirmed' WHERE id=?`。
- 不可設回 `open`：deadline 已過，會被下一輪 `processDeadlines` 再判死。

## 前端改動（`public/admin.js`，三處）

- drawer 場次列補報名鈕條件：`s.status !== 'cancelled' || s.start_at <= localNowStr()`。徽章照舊由 status 渲染；復活成功後就地把「未開課」徽章換成「已成班」。
- `drawerSessions` map 多存 `status`；補報名面板 hint 新增分支（cancelled 優先於 isPast）：「此場原判未開課：補報名成功後將恢復為已成班（計入薪資與上課統計）。」
- 錯誤字典 `session_cancelled` 改文案：「未開課場次需過了上課時間才能補登」（純後端防呆，正常操作碰不到）。

## 測試

service（沿用 `tests/admin-group-reg.test.js` 或新檔）：
1. 過去 cancelled＋未付補報 → reg pending＋pending 單、session→confirmed。
2. 過去 cancelled＋已收款補報 → reg confirmed＋獨立 paid 單、session→confirmed；`computePayroll` 當期含該場 headcount/revenue。
3. 未來 cancelled 補報 → 409 `session_cancelled`（paid/unpaid 皆擋）。
4. 原 rejected 客人補報 → 同一列 reactivate（reg id 不變、status 正確）。
5. 取消補進的唯一一筆 → session 維持 confirmed 不回退。
6. `getPublicGroupCourses`：復活後該場 `state='ended'`（非 `not_held`）。

API（`tests/admin-group-reg-api.test.js` 延伸）：過去 cancelled 201、未來 cancelled 409。

前端：手動 smoke（drawer 未開課場次出現補報名鈕、hint 文案、成功後徽章變已成班、counts 刷新）。

## 名詞對照

未開課＝`course_sessions.status='cancelled'`；已成班＝`'confirmed'`；未錄取＝`registrations.status='rejected'`。`completed` 狀態自始無寫入點，不涉及。
