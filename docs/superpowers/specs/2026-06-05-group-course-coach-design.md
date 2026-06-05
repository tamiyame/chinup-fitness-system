# 團體課程：授課教練欄位 — 設計文件

日期：2026-06-05
分支：`feat/group-course-coach`（從 `main` 開出）

## 目標

1. **前台**：團體課報名頁（`/group`）的每張課程卡片，顯示該課程的「授課教練」名稱。
2. **後台**：管理者新增／編輯「課程範本」時，可選擇一位授課教練。

教練名稱直接採用教練後台個人化資料中的「顯示名稱」（`coaches.display_name`）。

## 範圍與決策

- 一個課程範本（`course_templates`）對應**一位**授課教練（範本層，不做場次層多教練 — YAGNI）。
- 後台教練欄位 **必填**（使用者決定）。落實方式：DB 欄位可為 NULL（相容既有資料），但新增與編輯範本的 API 一律強制檢查 `coach_id`。編輯舊範本時會被要求順手選教練，自然完成 backfill。
- 前台卡片：有教練才顯示；尚未補教練的舊範本則略過不顯示。
- 卡片呈現：教練名接在既有 meta 列末尾（`⏱ 60 分鐘・👥 3–6 人・🧑‍🏫 教練 XXX`）。

## 資料模型

`course_templates` 新增欄位：

```
coach_id INTEGER REFERENCES coaches(id) ON DELETE SET NULL
```

- 教練（coaches 列）被刪除時，關聯範本的 `coach_id` 自動轉為 NULL，不阻擋刪除。
- 場次層 `course_sessions` 不變（不加教練欄位）。

落實位置：
- `src/db/schema.js`：`CREATE TABLE course_templates` 內加入該欄位（新建資料庫即帶有）。
- `src/db/connection.js`：`addColumnIfMissing('course_templates', 'coach_id', 'INTEGER REFERENCES coaches(id) ON DELETE SET NULL')`（產線既有資料庫開機自動補欄位；ADD COLUMN 帶 REFERENCES 預設 NULL，SQLite 允許）。

## 後端

### courseService.js
- `normalize()`：將 `coach_id` 解析為整數或 NULL。
- `createTemplate()` / `editTemplate()` 驗證：
  - 缺 `coach_id` → `ApiError(400, 'coach_required')`
  - `coach_id` 不存在於 `coaches` 表 → `ApiError(400, 'invalid_coach')`
- INSERT / UPDATE 語句加入 `coach_id`。

### groupOrderService.js
- `getPublicGroupCourses()` 的範本 SELECT 改為 `LEFT JOIN coaches c ON c.id = t.coach_id`，多帶 `c.display_name AS coach_name`。
- 回傳的每個範本物件多一個 `coach_name`（無教練則為 NULL）。

### server.js
- 路由不變（`POST/PATCH /api/admin/templates` 直接把 `req.body` 傳入 service）。
- 既有 `GET /api/admin/coaches` 直接重用，提供後台下拉的教練清單（含 `id` + `display_name`）。

## 前端

### 後台 admin.html / admin.js
- `#tpl-form` 新增「授課教練」`<select name="coach_id" required>`，第一項為佔位提示（無效值），其餘為各教練 `display_name`（value = 教練 id）。
- 載入後台時抓 `GET /api/admin/coaches` 填充選單（沿用既有教練清單載入）。
- `openEdit()`：帶出 `tpl.coach_id` 設定選單目前值。
- 送出時 `coach_id` 隨 FormData 一併送出。
- 錯誤訊息對應：`coach_required` → 「請選擇授課教練」；`invalid_coach` → 「授課教練無效，請重新選擇」。
- （小加值）後台範本清單列顯示教練名，方便管理者一眼辨識。

### 前台 group.js
- `renderTemplate()` 的 `.course-meta` 列末尾，於 `tpl.coach_name` 存在時附加 `・🧑‍🏫 教練 ${escapeHtml(coach_name)}`；不存在則不加。

## 測試

- `tests/course-service.test.js`（新增或既有擴充）：
  - 缺 `coach_id` → 400 `coach_required`，不寫入。
  - 非法 `coach_id`（不存在）→ 400 `invalid_coach`，不寫入。
  - 合法 `coach_id` → 寫入成功，欄位正確。
  - 編輯既有範本帶 `coach_id` → 更新成功；編輯缺 `coach_id` → 400。
- `tests/group-order-service.test.js`（擴充）：
  - `getPublicGroupCourses()` 回傳的範本含正確 `coach_name`（有教練 / 無教練兩種情形）。

## 非目標 / 不做

- 不做場次層級的不同教練。
- 不改動既有預約、團課下單、LINE 通知等流程。
- 不對產線資料庫做任何寫入（既有舊範本的教練 backfill 由使用者日後在後台逐一編輯時自然完成）。
