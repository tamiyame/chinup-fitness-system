# SQLite Database Backup Design

**Date:** 2026-05-13
**Branch:** `feature/sqlite-backup` (to be created)
**Phase:** ops / pre-launch hardening (independent of Phase 3 roadmap)
**Status:** Draft for review

---

## 1. Goal

讓正式上線後的 SQLite 資料庫具備「**回得去**」的能力：每週自動產生一份原子、一致的快照，admin 可在 `/admin.html` 看到最近 8 份備份並一鍵下載到本機。下載到本機這一步 = 真正的災備（脫離 Railway volume），由 admin 人為定期完成。

## 2. Threat Model（明確刻意的取捨）

**這個方案防的**：
- 邏輯資料損壞（誤 DELETE、migration bug、人為操作失誤）
- App-level bug 寫壞資料表
- Admin 在內部示範階段「想回到上週某個狀態」

**這個方案不防的**：
- Railway volume 整個損毀或被刪除 — 因為備份檔同住一個 volume
- 立即 / 細粒度的 point-in-time recovery — 最差 RPO = 7 天
- 自動異地保存 — admin 必須記得定期下載最新一份到本機（這是人為流程，不在程式範圍）

未來若需要異地備份，再加一個「上傳到 Cloudflare R2 / S3」的 cron job 即可，本設計不擋這條路。

## 3. In Scope

- 新檔 `src/services/backupService.js`：`runBackup()` / `listBackups()` / `safeBackupPath()`
- 在 `src/scheduler.js` 加一個 cron job：每週日 03:00（Asia/Taipei）執行 `runBackup()`
- 3 個新 admin-gated HTTP endpoints：
  - `GET    /api/admin/backups`        列表 + last error
  - `POST   /api/admin/backups/run`    手動觸發
  - `GET    /api/admin/backups/:file`  串流下載（含 path-traversal 防護）
- `public/admin.html` 新增「資料備份」card section（在「通知紀錄」之後）
- `public/admin.js` 新增 `loadBackups()` + 「立即備份」按鈕綁定 + blob download helper
- 新測試檔 `tests/backup.test.js`

## 4. Out of Scope (YAGNI)

- 寫入 `notifications` 表（那是給使用者收的通知，不是 ops 事件）
- 新 schema / migration
- 引入 `aws-sdk` 或任何外部儲存依賴
- 備份加密 / 壓縮
- 「誰下載過什麼」之類的稽核紀錄
- Restore UI — 還原是嚴重操作，走 Railway shell 手動 `cp backups/<file> app.db` 再 restart 即可

## 5. Architecture

```
src/services/backupService.js
  ├ runBackup()              VACUUM INTO + prune
  ├ listBackups()             scan dir + parse .last-error.txt
  └ safeBackupPath(file)      path-traversal guard

src/scheduler.js
  └ cron('0 3 * * 0')         呼叫 runBackup()

src/server.js
  ├ GET    /api/admin/backups
  ├ POST   /api/admin/backups/run
  └ GET    /api/admin/backups/:file

public/admin.html              「資料備份」 section
public/admin.js                loadBackups() + bindBackupButton()
```

**檔案位置**：`<DB_PATH 同層>/backups/` — 即 production 為 `/app/data/backups/`，本地開發為 `data/backups/`。

**檔名格式**：`app-YYYYMMDD-HHmmss.db`（本地時區）。字典序 = 時間序，方便修剪。

**保留份數**：`KEEP = 8`（兩個月、每週一份）。

## 6. Core Logic

### 6.1 `runBackup()`

1. `mkdirSync(BACKUP_DIR, { recursive: true })`
2. 生成檔名 `app-${tsForFile()}.db`，其中 `tsForFile()` = `YYYYMMDD-HHmmss`（process 本地時區，使用 `new Date()` 的 getter，與 `connection.js` 的 `nowLocal()` 同樣方式 zero-pad）
3. 執行 `db.exec("VACUUM INTO 'fullPath'")`，路徑內單引號做 `''` 跳脫
4. 若成功：刪除 `.last-error.txt`（如存在）+ `pruneOldBackups()` + 回傳 `{ ok: true, file, size }`
5. 若失敗：寫 `.last-error.txt`（內容含 ISO timestamp + `e.message`）+ `console.error` + 回傳 `{ ok: false, error: e.message }`

**為什麼用 `VACUUM INTO`**：SQLite 原生原子快照，不擋寫入、不需 lock、輸出檔已自動 checkpoint WAL，是單檔且乾淨。比 `fs.copyFileSync` + `wal_checkpoint` 簡單且安全。

### 6.2 `listBackups()`

```js
return {
  files: [{ file, createdAt, size }, ...],  // newest first
  lastError: string | null,
};
```

`createdAt` 從 `statSync().mtime.toISOString()` 取；`lastError` 從 `.last-error.txt`（若存在）讀。

### 6.3 `safeBackupPath(file)`

三道防線：
1. `FILE_RE = /^app-\d{8}-\d{6}\.db$/` 過濾合法檔名
2. `resolve(BACKUP_DIR, file)` 後 `dirname(full) === BACKUP_DIR` 再驗證一次
3. `existsSync(full)` 才回傳

任一失敗回 `null`，endpoint 一律回 404（不洩露存在性）。

### 6.4 `pruneOldBackups()`

讀目錄、用 `FILE_RE` 過濾、字典序升冪、`shift()` + `unlinkSync()` 直到剩 `KEEP` 份。

## 7. Cron Schedule

`cron.schedule('0 3 * * 0', fn, { timezone: 'Asia/Taipei' })` — 每週日 03:00 台北時間，**明確使用 node-cron 的 `timezone` option**，不依賴 process TZ 或 Railway 環境變數（既有 crons 沒設此 option，是潛在歧義，但本設計不順手修它以免擴大 scope）。

選擇理由：
- 03:00 是台北時區低峰（健身房開門前）
- 週日跑：週末手動操作後資料相對穩定
- 包在 `try/catch` 內，失敗只 `console.error` 不影響其他 cron

## 8. API Surface

| Method | Path | Auth | Response |
|--------|------|------|----------|
| GET | `/api/admin/backups` | `requireAdmin` | `{ files: [...], lastError: string\|null }` |
| POST | `/api/admin/backups/run` | `requireAdmin` | success: `200 { ok: true, file, size }`<br>fail: `500 { ok: false, error }` |
| GET | `/api/admin/backups/:file` | `requireAdmin` | success: `200` + `application/octet-stream` 串流<br>fail: `404 { error: 'not_found' }` |

下載端點用 `createReadStream(full).pipe(res)`、設定 `Content-Disposition: attachment; filename="..."`。

## 9. Admin UI

新增區塊位置：`/admin.html` 「通知紀錄」section 之後。

**內容**：
- 標題列：H2「資料備份」+ 右側「立即備份」按鈕
- `lastError` 紅字提示橫條（無錯時隱藏）
- 表格欄位：檔名 / 建立時間 / 大小 / 下載連結

**互動**：
- 進入頁面時 `loadBackups()` → `GET /api/admin/backups` → 渲染表格
- 「立即備份」→ `POST /api/admin/backups/run` → 成功則 toast「備份完成」+ 重新 `loadBackups()`；失敗則顯示錯誤訊息
- 「下載」連結需用 `fetch` 帶 `Authorization: Bearer` header → `response.blob()` → `URL.createObjectURL` → 觸發 `<a>` download；不能用純 `<a href>` 因為瀏覽器不會自動帶 token

## 10. Error Handling

| 失敗情境 | 行為 |
|----------|------|
| Cron 跑 `VACUUM INTO` 失敗（disk full, IO error） | `console.error` + 寫 `.last-error.txt`。下次 admin 開頁時看到紅字 |
| 手動觸發失敗 | API 直接回 500 + error message，UI toast 顯示。同時也寫 `.last-error.txt` |
| `pruneOldBackups()` 中 `unlinkSync` 失敗 | catch + `console.warn`，不影響備份本體已完成的事實 |
| `safeBackupPath` 三道防線任一失敗 | API 一律回 `404 { error: 'not_found' }` |
| BACKUP_DIR 不存在 | `mkdirSync(BACKUP_DIR, { recursive: true })` 自動建立 |

## 11. Security

- 所有 endpoints 掛 `requireAdmin`（沿用既有 middleware）
- 下載端點檔名做 regex 白名單 + path resolve 比對，雙重擋目錄穿越
- VACUUM INTO 的路徑單引號跳脫（即便檔名已被 regex 限制為純 ASCII 也保留此防護）
- 不暴露 `BACKUP_DIR` 絕對路徑到回應內容

## 12. Testing

新檔 `tests/backup.test.js`。所有檔系操作在 `tmpdir` 跑，不污染 `data/backups/`。

| Test | 驗證 |
|------|------|
| `runBackup creates .db file matching FILE_RE` | VACUUM INTO 真的有產生檔，檔名符合 regex，size > 0 |
| `runBackup prunes to KEEP=8` | 預先放 10 個假快照 + 跑 1 次真備份 → 剩 8 個，最舊 3 個被刪 |
| `runBackup clears .last-error.txt on success` | 預先寫 .last-error.txt → run → 該檔已不存在 |
| `runBackup writes .last-error.txt on failure` | 製造合法的失敗情境（例如把 BACKUP_DIR 預先建成 read-only 檔而非目錄，使 mkdirSync 失敗；或讓目標檔名指向不可寫位置）→ 跑 → `.last-error.txt` 存在且內容含 error message + ISO timestamp |
| `listBackups returns newest-first` | 放 3 個不同時戳檔 → 第一筆是字典序最大者 |
| `listBackups reports lastError when file exists` | 寫一個 .last-error.txt → 回傳的 `lastError` 不為 null |
| `safeBackupPath rejects traversal & bad names` | `../../../etc/passwd`、`app-bad.txt`、`/etc/passwd`、不存在的合法名 → 都回 null |
| `POST /api/admin/backups/run requires admin` | 不帶 token → 401；帶 user token → 403 |
| `GET /api/admin/backups/:file 404 on bad name` | 帶 `..%2F..%2Fetc%2Fpasswd` → 404 |
| `GET /api/admin/backups/:file streams real file` | 先 run 一次備份 → 用其檔名下載 → response body size == file size |

## 13. Operator / Deploy Notes

- 不需新 env var
- 不需 Railway 設定改動
- 部署完成第一次 deploy 後可立即在 `/admin.html` 點「立即備份」驗證
- 之後每週日 03:00 (Asia/Taipei) 自動跑；admin 應養成「每週一上班時下載最新一份備份到本機」的習慣（這是這個方案核心的人為流程）

## 14. Open Questions

無。架構決策已透過 brainstorming 收斂完畢。
