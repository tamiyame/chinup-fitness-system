# Chin-up Performance · Design System

> 競技運動表現訓練 · 一般大眾肌力與體能 · 銀髮族訓練

Chin-up Performance（CHINUP Performance）是一間位於台灣的運動訓練場館，提供三條主線服務：

1. **競技運動表現訓練** — 為運動員設計的爆發力、速度、敏捷性等表現訓練
2. **一般大眾肌力與體能** — 團體課程（重訓、TRX、HIIT 等）與一對一指導
3. **銀髮族訓練** — 針對年長者的功能性、平衡、與肌力訓練

語言主要為**繁體中文（zh-TW）**，介面標籤偶爾搭配少量英文（如 "Spring Program"、"Admin Console"）。

---

## Sources

- **GitHub**: `tamiyame/chinup-fitness-system` — 課程報名 / 候補 / 排課管理系統（Node + Express + SQLite + Vanilla JS + Tailwind CDN）
  - 前端設計系統：`public/style.css`
  - 主要頁面：`public/index.html`（課程瀏覽）、`public/login.html`（登入/註冊）、`public/my.html`（我的報名）、`public/admin.html`（管理後台）
  - Logo 原始檔：`public/logo.png`（已複製到 `assets/logo.png`）

> 本 design system 的視覺與內容語氣均萃取自上述 codebase。其他 repos（`gym-management`、`nhu_app_for_sport`）為相鄰但不同的健身/體育產品，本系統暫不納入。

---

## Index

| 檔案 / 資料夾 | 內容 |
|---|---|
| `README.md` | 本檔。品牌語境、內容語氣、視覺基礎、索引 |
| `colors_and_type.css` | 色彩與字型 CSS 變數（語意 token + 基礎 token） |
| `SKILL.md` | Agent skill manifest — 跨平台呼叫本 design system |
| `assets/` | Logo、icons、品牌視覺資產 |
| `fonts/` | 字型檔（Inter + Noto Sans TC，目前以 Google Fonts CDN 引用） |
| `preview/` | Design system 預覽卡（顯示在 Design System tab） |
| `ui_kits/web/` | 主產品（課程報名 web app）的 UI kit — 元件 + index.html 互動展示 |

---

## CONTENT FUNDAMENTALS

### Voice & tone
產品語氣**精簡、直述、實用**。沒有口號式行銷腔，偶爾使用 emoji 作為輕量視覺錨點（💪、📋、⚙️、🗓️、🕐、👥、⏳）。給人的感覺：**像會館管理員溫和但直接的語氣**，而不是運動品牌的激昂號召。

### Pronouns & address
- 對會員：用「**你**」（一般語氣，不用敬語「您」）
  - 例：「找到適合你的團體訓練課程」「都會通知你」
- 對管理者：直接動詞句、簡短指令（無主詞）
  - 例：「建立團體課程範本、檢視每場次報名狀態」

### Casing
- **品牌名**：可寫作 `CHINUP Performance`（大寫）或 `Chin-up Performance`。導覽列、登入頁主要用大寫版本
- **介面動詞**：簡短、命令式 — 「立即報名」「進入候補」「取消報名」「儲存並展開場次」「立即處理截止」「寄送上課提醒」
- **狀態標籤**：兩字偏好 — 正取 / 候補 / 已取消 / 未開課 / 已成班 / 已結束 / 開放報名

### Punctuation & symbols
- 中文與英文/數字之間用半形空白（如「下次 11/05」）
- **bullet 分隔符**：使用全形「・」（如「⏱ 60 分鐘・👥 3–8 人」）
- 範圍用 en-dash（如 `3–8 人`、`8:00–9:00`）
- emoji 與文字之間沒有空格（前置）：`💪 2026 Spring Program`、`📋 Personal`

### Examples（直接從產品萃取）
- Hero eyebrow 微標：`💪 2026 Spring Program` / `📋 Personal` / `⚙️ Admin Console`
- Hero 主題：`找到適合你的<br>團體訓練課程`
- Hero 副標：`由專業教練設計的循環課表，每月開課、彈性報名。額滿自動進入候補、成班與否都會通知你。`
- 表單欄位 label（**全大寫拉丁字 + 字母間距 0.04em**）：`COURSE NAME` 不用，但中文照原樣 `課程名稱`、`人數下限`、`重複週期`
- 空狀態：簡短一行 + emoji icon — 「目前沒有可報名的課程 / 請稍後再查看，或聯絡管理員新增課程」
- 錯誤訊息：直白短句 — 「帳號或密碼錯誤」「此 Email 已被註冊，請直接登入或使用 Google」
- Toast：`🎉 報名成功（正取）` / `已進候補 第 X 位`

### Vibe summary
**「實用主義 + 一抹活力」**。資訊密度高但不擁擠；色彩克制，主介面以一道 sky-blue 為主軸，把活力留給 logo。會館的氣氛是專業而非熱血型的訓練場館；文案不喊口號。

---

## VISUAL FOUNDATIONS

### Color
**主品牌色：sky-blue 系列**（基於 Tailwind sky 100/500/600/700/900 的選色）。
- `--brand-50  #f0f9ff` — 微標背景、hover 微染
- `--brand-100 #e0f2fe` — day-chip 漸層起點
- `--brand-500 #38bdf8` — 焦點環、capacity-bar 起色
- `--brand-600 #0ea5e9` — **主要按鈕、active 強調**
- `--brand-700 #0284c7` — 文字 link、icon
- `--brand-900 #0c4a6e` — 深色強調（極少用）

**中性墨色（slate 偏冷）**
- `--ink #0f172a` / `--ink-soft #475569` / `--ink-mute #94a3b8` / `--line #e5e7eb`

**Surface**
- `--surface #ffffff` 卡片底
- `--canvas #f8faf9` 主畫布（極淡冷灰白，帶一絲綠調）

**語意/狀態色（badges）**
- 開放/成功 emerald `#ecfdf5 / #047857 / #a7f3d0`
- 確認/正取 blue `#eff6ff / #1d4ed8 / #bfdbfe`
- 候補/警告 amber `#fffbeb / #a16207 / #fcd34d`
- 取消/錯誤 red `#fef2f2 / #b91c1c / #fecaca`
- 結束/中性 slate `#f1f5f9 / #334155 / #cbd5e1`

**Logo 內部色彩**（pink/orange/yellow/green/cyan）僅作為 logo 內飾，**不作為 UI 色票使用**。

### Typography
- 主字型 stack：`'Inter', -apple-system, BlinkMacSystemFont, 'LiHei Pro', 'PingFang TC', 'Microsoft JhengHei', sans-serif`
- 載入方式：Inter via Google Fonts；**LiHei Pro self-hosted at `fonts/LiHeiPro.ttf`**
- 字型功能：`font-feature-settings: 'cv02', 'cv03', 'cv04', 'cv11'`（Inter 變體形）
- 全域 `letter-spacing: -0.01em`（緊一格）；hero h1 用 `-0.03em`
- Hero h1 使用 `clamp(28px, 4vw, 42px)`，weight 800，line-height 1.1
- 表單 label：`font-size:12px / weight:600 / letter-spacing:0.04em / text-transform:uppercase / 顏色 ink-soft`

### Backgrounds
- 主畫布有兩道**極淡 radial gradient**「光暈」固定在角落：左上 sky-blue、右上稍深 sky；`background-attachment: fixed` — 滾動時不動。
- Login page 加強同樣的 radial 兩道（透明度 0.18 / 0.12）
- **無**全幅圖片、**無**重複紋理、**無**手繪插圖、**無**鮮豔漸層
- 主背景永遠保持「霧白冷調」，視覺重點在卡片與按鈕

### Animation & easing
- 預設 transition：`160ms ease`（hover、border、shadow）
- capacity-fill：`width 400ms ease`
- modal zoomIn：`200ms ease`，drawer slideIn：`240ms ease`
- toast slideUp：`240ms cubic-bezier(0.22, 1, 0.36, 1)`
- login card：`620ms cubic-bezier(0.22, 1, 0.36, 1)` 進場（位移 24px + scale 0.96）
- login logo：3.6s 無限上下 `translateY(-6px)` 微浮動 + drop-shadow
- skeleton shimmer：1.2s linear 無限
- **無 bounce、無大位移**，整體克制；只有 logo 上有「呼吸」感

### Hover / press
- 主按鈕 `.btn-primary`：hover 變更深色 (brand-600 → brand-700) + `translateY(-1px)`
- ghost 按鈕：hover 換 `#f1f5f9` 底 + 邊框稍深
- card：hover `translateY(-1px) + shadow + border 邊微 brand 色 (rgba 0.25)`
- nav-link：hover 字色變 brand-700；active 在底部 `-14px` 加 `2px` brand-600 橫條
- 並無明確 press（active）狀態 — 仰賴 hover 過渡

### Borders
- 預設邊線色 `--line: #e5e7eb`
- 卡片：1px solid line、圓角 14px
- 按鈕：1px solid transparent（border 是預留位置）
- 表單聚焦：邊色換 brand-500，外加 `0 0 0 3px rgba(56, 189, 248, 0.15)` ring

### Shadow system
- `--shadow-sm` `0 1px 2px 0 rgba(15, 23, 42, 0.04)` — 卡片靜態
- `--shadow` `0 4px 16px -4px rgba(15, 23, 42, 0.08), 0 2px 4px -2px rgba(15, 23, 42, 0.04)` — hover、open 狀態
- `--shadow-lg` `0 12px 32px -8px rgba(15, 23, 42, 0.14)` — modal、drawer
- `--shadow-brand` `0 6px 24px -6px rgba(56, 189, 248, 0.35)` — **主按鈕專屬色彩 shadow**

無 inner shadow、無 protection gradient。

### Capsules vs gradients
- Pills（capsule）大量使用：badge、hero-eyebrow、buttons (rounded radius-pill = 9999px)
- 漸層僅 3 處：(a) capacity-fill `linear-gradient(90deg, brand-500, brand-700)`（滿時換 amber `#f59e0b → #d97706`）；(b) day-chip `linear-gradient(135deg, brand-100, brand-50)`，open 時 `brand-500 → brand-700`；(c) 主畫布 radial「光暈」

### Layout rules
- 最大內容寬：`max-w-6xl`（72rem / 1152px）+ `px-6` 邊距
- Sticky 透明導覽列 (`rgba(255,255,255,0.85) + backdrop-filter blur(12px) saturate(1.4)`)
- Hero 區塊垂直 padding 40/32px
- Cards 用 `gap` 排版（grid/flex with gap），不靠 margin
- Hero h1 limit `max-width: 600px` 副標

### Transparency & blur
- 導覽列底色 85% 不透明 + 12px blur + 1.4 saturate（**唯一**透明圖層）
- modal overlay `rgba(15, 23, 42, 0.45) + backdrop-filter blur(4px)`

### Imagery vibe
產品內目前**幾乎沒有照片** — 僅 logo 出現。若需放入訓練照片，方向應為：
- **冷白光、低對比、銳利**（不要金黃健身房調）
- 黑/白/灰主導，僅器材或品牌色 sky 出現
- 動作中的人物剪影 > 微笑擺拍
- 不上 grain / 不模糊 / 不調色到 warm

### Corner radii
- `--radius: 14px` — 卡片、modal、drawer、details
- `--radius-sm: 10px` — 表單、按鈕、toast
- `--radius-pill: 9999px` — badge、hero-eyebrow
- 特例：login card 用 20px；day-chip 14px；date 區塊 8px

### Card anatomy
1px solid `#e5e7eb` border + `#ffffff` background + 14px radius + `shadow-sm` 靜態 + 20px padding。Hover 微抬 1px + 換為較深 shadow + border 邊變淡 sky 色。**無左側色條**，無左邊角強調。

### Iconography 預告
見下方 ICONOGRAPHY 段。主要使用 **emoji + inline SVG（chevron 等少數結構性 icon）**，無 icon font / sprite。

---

## ICONOGRAPHY

Chin-up 的圖標策略**極度精簡**，現況可分四類：

1. **Emoji 作為主視覺錨點** — 用於 hero eyebrow、空狀態、meta-icon、按鈕前綴。
   - 用例：`💪`、`📋`、`⚙️`、`🗓️`、`📭`、`🕐`、`👥`、`⏳`、`🎉`、`📣`、`⏰`、`✕`、`＋`
   - emoji 走系統字型（Apple Color Emoji / Segoe UI Emoji / Noto Color Emoji）— 不裝載自訂 emoji 字型
   - emoji 本身有顏色，UI 不再覆蓋

2. **內聯 SVG（少量結構性 icon）** — 全 codebase 只有兩個：
   - **Chevron**（accordion 展開）：`viewBox="0 0 24 24"` 線條 24×24、`stroke-width: 2.5`、`stroke-linecap/-linejoin: round`
   - **Google "G"** logo（OAuth 按鈕）：4 色 brand SVG，原始 Google 提供
   - 無 icon library 安裝；不從 Lucide / Heroicons / Phosphor 引入

3. **Unicode 字元作 affordance**：
   - `✕` 關閉
   - `＋` 新增（全形加號刻意較粗）

4. **品牌 logo 圖檔** — `assets/logo.png`（1280×864 PNG，透明底）；於導覽列以 32×32 顯示，登入頁以 88×88 顯示，皆 `object-fit: contain`。

### 推薦增補（substitution flagged）
若需要更完整的 outline icon 系統來支援未來 dashboard / settings 等場景，**建議引入 Lucide**（CDN：`https://unpkg.com/lucide@latest`）— stroke-width 2、線條風格與既有 chevron 完全一致。本 design system 已在 `preview/` 卡片中以這個前提示範。**這是 substitution；原 codebase 並未引入。** 請你（產品負責人）確認方向。

### Rules of thumb
- 先用 emoji（活潑、零成本）
- 結構性 affordance 用 inline SVG，stroke 線條風格 2 / 2.5、`round` cap、currentColor
- **絕不**：堆疊多色漸層 icon、AI 風格 isometric icon、彩色填滿 icon
- 圖標永遠 **跟隨字色**（`color: currentColor` 或自訂變數）

---

## Fonts

- **Latin / numeric**: `Inter` (Google Fonts CDN, weights 400/500/600/700/800)
- **CJK 中文**: **`LiHei Pro`** — self-hosted at `fonts/LiHeiPro.ttf`. Loaded via `@font-face` in `colors_and_type.css`. Falls back to `PingFang TC` / `Microsoft JhengHei` on systems where the brand face fails to load.

The font stack is `'Inter', -apple-system, BlinkMacSystemFont, 'LiHei Pro', 'PingFang TC', 'Microsoft JhengHei', sans-serif` — Latin glyphs come from Inter, CJK from LiHei Pro.

---
