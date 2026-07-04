# 堂數即將用完自動 LINE 提醒 — 設計規格

- 日期：2026-07-04
- 狀態：口徑一（尚餘）業主已拍板；時機（每日 9 點）與團課算法（全部合計）採建議值，業主可事後調整

## 目標

自動提醒快上完課的客人續約／報名：

1. **1對1／1對2 方案**：客人在「我的課表」看得到的方案，**尚餘 ≤ 2 堂**（且 > 0）時提醒一次。
   - 尚餘口徑＝我的課表卡片數字：`已預約未上堂數 ＋（未過期 ? 未登錄餘額 : 0）`（`listScheduleViewPackages` 同口徑）。
2. **團體課**：客人**全部未來已報名（正取）的團體課場次合計只剩 1 堂**時提醒一次。
3. 通知走既有 `notify()`：有綁 LINE 推 LINE，未綁走 console 紀錄（實際收不到——與其他客人通知同口徑，不另做 email）。

## 觸發機制

- **每天早上 9:00**（Asia/Taipei，與既有上課提醒同時段）scheduler cron 跑 `processRenewalReminders()`。
  - 「上完課」造成的尚餘減少是時間自然發生（無事件可掛），排程掃描是唯一可靠觸發。
- **去重**：新表 `renewal_reminders`，同一（kind, member, ref）只發一次：
  - `kind='package'`、`ref_id=方案 id` → 每個方案一生只提醒一次；續購新方案降到門檻會再提醒（新 ref）。
  - `kind='group'`、`ref_id=最後一堂場次 id` → 對「這一堂是最後一堂」提醒一次；之後再報名又只剩最後一堂（不同場次）會再提醒。

## 資料模型（schema.js，`CREATE TABLE IF NOT EXISTS` 開機自動套用，無需手動遷移）

```sql
CREATE TABLE IF NOT EXISTS renewal_reminders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL CHECK (kind IN ('package','group')),
  member_id INTEGER NOT NULL REFERENCES users(id),
  ref_id INTEGER NOT NULL,
  sent_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_renewal_reminders_key ON renewal_reminders(kind, member_id, ref_id);
```

## 掃描邏輯（新 `src/services/renewalReminderService.js`）

### A. 方案（1對1/1對2）

```sql
SELECT p.id, p.member_id, p.session_type,
       COALESCE(up.cnt, 0) + (CASE WHEN p.expires_at IS NULL OR p.expires_at >= :today
                                   THEN p.remaining_sessions ELSE 0 END) AS still
FROM customer_packages p
LEFT JOIN (SELECT package_id, COUNT(*) AS cnt FROM bookings
            WHERE status='confirmed' AND package_id IS NOT NULL AND start_at >= :now
            GROUP BY package_id) up ON up.package_id = p.id
WHERE p.archived_at IS NULL
```

- 過濾 `0 < still <= 2` 且 `renewal_reminders` 無 `('package', member, p.id)` 紀錄。
- 逐筆：插入 marker → `notify(type='package_low_sessions', vars={ session_type_label, remaining: still })`。
- 作廢方案（archived）不掃；過期且無未來預約者 `still=0` 自然排除（與我的課表顯示一致）。

### B. 團體課

```sql
SELECT r.user_id AS member_id, COUNT(*) AS cnt,
       MIN(s.start_at) AS start_at, MIN(s.id) AS session_id, MIN(t.name) AS course_name
FROM registrations r
JOIN course_sessions s ON s.id = r.session_id
JOIN course_templates t ON t.id = s.template_id
WHERE r.status = 'confirmed' AND s.status != 'cancelled' AND s.start_at >= :now
GROUP BY r.user_id
HAVING cnt = 1
```

（cnt=1 時該組只有一列，MIN 即該場次的值。）

- 過濾 `renewal_reminders` 無 `('group', member, session_id)` 紀錄。
- 逐筆：插入 marker → `notify(type='group_last_session', vars={ course_name, start_at(fmtDateForLine) })`。
- 請假（on_leave=1）的正取報名仍計為 1 堂（他仍報了這堂）。

## 通知模板（TEMPLATES 新增兩則）

```
package_low_sessions:
  subject: '方案堂數提醒'
  body: '提醒您：您的{{session_type_label}}方案還剩 {{remaining}} 堂課。歡迎向教練預約續購，讓訓練不中斷！'
  // session_type_label：1對1／1對2

group_last_session:
  subject: '團體課報名提醒'
  body: '提醒您：您報名的團體課只剩最後一堂（{{course_name}}，{{start_at}}）。歡迎繼續報名之後的場次，我們課堂上見！'
```

## 排程（scheduler.js）

既有 9 點提醒 cron 之後新增獨立排程（各自 try/catch 互不影響）：

```
cron '0 9 * * *'（timezone: Asia/Taipei）→ processRenewalReminders()
```

註：既有 9 點 cron 未帶 timezone（伺服器 TZ=Asia/Taipei，Dockerfile 硬編）——新排程比照既有寫法不帶 timezone，維持一致。

## 邊界

- marker 先插後發（單執行緒 cron，插入成功才 notify；notify 失敗有既有 LINE 重試機制 `processFailedNotifications`）。
- 方案被管理者調整堂數回升後再降 → 同 ref 已有 marker，不重發（避免洗版；屬可接受取捨）。
- 一天內從 3 直接變 0（少見）→ 不發（已無可提醒標的）。
- 團課從 2 堂變 0（同日兩堂皆過）→ 不發；可接受。

## 範圍外（YAGNI）

- Email 通知、未綁 LINE 客人的替代管道。
- 門檻（2 堂／1 堂）做成後台可調——先固定，業主要改再說。
- 教練端/管理端的「誰快到期」報表。

## 測試（tests/renewal-reminders.test.js，掛 `npm test` 鏈）

1. 方案尚餘 3 → 不發；尚餘 2（含「已預約未上」與「未登錄餘額」的組合）→ 發一次、再跑不重發。
2. 尚餘 1 → 發；尚餘 0（全上完）→ 不發；過期且無未來預約 → 不發；作廢 → 不發。
3. 續購新方案再降到 2 → 對新方案再發（不同 ref）。
4. 團課：未來正取 2 堂 → 不發；1 堂 → 發一次（vars 含課名/時間）、再跑不重發；0 堂 → 不發；取消場次/取消報名/候補不計。
5. 通知落在 notifications 表（member 收到、型別正確）；管理者/教練不收。
6. marker 表 UNIQUE 防重與（kind, member, ref）語意。
