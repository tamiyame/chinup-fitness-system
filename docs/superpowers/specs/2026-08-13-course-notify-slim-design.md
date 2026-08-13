# 期課通知瘦身：會員只在報名成功時收一次 — 設計規格

- 日期：2026-08-13
- 狀態：業主已核可設計

## 背景

業主回報：期課報名後，系統在「開課前一天」與「開課當天」各發一次通知給會員，太多了。要求改成**報名成功時發一次就好**。

實查兩則通知的來源：

1. **前一天那則**＝`course_confirmed`「課程成立…確認開課」——每小時截止判定 cron（`processDeadlines`）在 `registration_deadline` 到期、達最低人數時發給全部已報名會員。
2. **當天那則**＝`reminder`「上課提醒」——每天 9:00 cron（`processReminders`）發給 24 小時內開課場次的已報名會員（場次級去重、一場一次）。

## 目標（業主拍板）

會員的期課通知體驗：**報名成功（或匯款核對）聽到一次，之後沒消息＝照常開課**；只有例外（課程取消、候補遞補）才再發聲。

- 移除會員的成班通知（`course_confirmed`）。
- 移除上課提醒整組（cron、函式、手動端點、後台按鈕、模板）。
- **保留**：報名成功／匯款核對、候補遞補、課程取消（未開課，牽涉退款，會員必須知道）、教練端全部通知（含 `course_confirmed_coach` 成班——教練要知道課開不開）、9:00 堂數續購提醒（`renewalReminderService`，另一支，無關）。

## 變更點（零 schema、零新端點）

1. **`src/services/courseService.js` `processDeadlines` 成班分支**：移除會員通知迴圈

```js
        for (const r of regs) {
          notify({ userId: r.user_id, sessionId: s.id, type: 'course_confirmed', vars: { course_name: s.course_name, start_at: s.start_at } });
        }
```

   `const regs = …` 查詢**保留**（教練通知的 `count: regs.length` 仍用）。未開課分支一行不動。

2. **`src/services/courseService.js`**：整段刪除 `processReminders`（含「上課前 24h 提醒」註解，`:242-270` 附近）。

3. **`src/scheduler.js`**：import 移除 `processReminders`（保留 `processDeadlines`）；刪除「每天早上 9 點寄送上課提醒」cron 區塊。9:00 的 renewal reminders cron 是另一個區塊，不動。

4. **`src/server.js`**：`:8` import 移除 `processReminders`；刪除 `POST /api/admin/jobs/send-reminders` 端點區塊（`:1284-1286`）。

5. **`src/services/notifications.js`**：刪除 `reminder` 模板區塊（`:39-42`）。歷史通知列存的是已渲染的 subject/body，不引用模板，移除不影響舊紀錄顯示。

6. **`public/admin.html:580`**：刪除「寄送上課提醒」按鈕（`#run-reminders`）。

7. **`public/admin.js`**：
   - 刪除 `run-reminders` click handler 區塊（`:748-756`）。
   - 刪除工作說明彈窗的 `reminders:` 條目（`:2675` 起的整個物件成員）。
   - 截止判定說明（`:2670` 附近）「通知**學員與**該堂教練『成班』」改為「通知該堂教練『成班』（學員報名成功時已通知，不再重複）」；未開課那行的「通知學員與教練」**不動**。
   - 通知紀錄的型別標籤表（`:281-282` 的 `course_confirmed: '成班', reminder: '提醒'`）**保留**——歷史列仍要正確顯示。

## 測試

- `tests/course-coach-notify.test.js` 既有成班／未開課場景（`processDeadlines()` 之後）加兩個斷言：
  1. 成班 → 會員 `course_confirmed` **零筆**（session 級精確計數）。
  2. 未開課 → 會員 `course_cancelled` 恰 1 筆（回歸守門）。
- 既有教練斷言（`course_confirmed_coach`／`course_cancelled_coach` 各 1）必須續過；`tests/flow.test.js` 只斷言 `processDeadlines` 回傳動作，不受影響。
- **開機煙測**：unit 鏈不會載入 server.js/scheduler.js，import 殘留不會被測試抓到——實作完成後以 fresh DB + mocks 起一次伺服器打 `/api/health` 驗證開機無 import 錯誤。

## 影響與風險

- 移除後「當天有課」的最後防線只剩會員自查我的課表；業主明示接受（過多通知的反效果更大）。
- 待辦 #17（7/25 提醒金絲雀追蹤）隨提醒功能移除而作廢。
- 手動補發提醒的後台工具一併移除；若未來要「特殊場合手動提醒」再另案。

## 範圍外（YAGNI）

- 報名成功／匯款核對通知的文案調整。
- 通知偏好設定（per-會員開關）。
- 歷史 `reminder`/`course_confirmed` 通知列的清理（保留供稽核）。
