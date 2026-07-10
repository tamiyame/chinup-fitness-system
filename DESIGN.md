---
name: CHIN UP Performance
description: 小健身房全自動營運＋零門檻預約——晴空訓練場上的精確計時儀器
colors:
  primary: "#0ea5e9"
  primary-deep: "#0284c7"
  primary-bright: "#38bdf8"
  primary-tint: "#e0f2fe"
  primary-wash: "#f0f9ff"
  primary-night: "#0c4a6e"
  ink: "#0f172a"
  ink-soft: "#475569"
  ink-mute: "#94a3b8"
  line: "#e5e7eb"
  surface: "#ffffff"
  canvas: "#f8faf9"
  ok: "#047857"
  warn: "#a16207"
  err: "#b91c1c"
  info: "#1d4ed8"
typography:
  display:
    fontFamily: "Archivo, 'Noto Sans TC', sans-serif"
    fontSize: "26px"
    fontWeight: 900
    lineHeight: 0.95
    letterSpacing: "-0.03em"
  headline:
    fontFamily: "Inter, 'LiHei Pro', 'PingFang TC', sans-serif"
    fontSize: "28px"
    fontWeight: 800
    lineHeight: 1.1
    letterSpacing: "-0.03em"
  title:
    fontFamily: "Inter, 'LiHei Pro', 'PingFang TC', sans-serif"
    fontSize: "17px"
    fontWeight: 700
    lineHeight: 1.35
    letterSpacing: "-0.01em"
  body:
    fontFamily: "Inter, 'LiHei Pro', 'PingFang TC', sans-serif"
    fontSize: "14px"
    fontWeight: 400
    lineHeight: 1.55
    letterSpacing: "-0.01em"
  label:
    fontFamily: "Archivo, 'Noto Sans TC', sans-serif"
    fontSize: "11px"
    fontWeight: 700
    lineHeight: 1
    letterSpacing: "0.2em"
rounded:
  none: "0"
  sm: "10px"
  md: "14px"
  lg: "20px"
  pill: "9999px"
spacing:
  xs: "4px"
  sm: "8px"
  md: "16px"
  lg: "24px"
  xl: "32px"
  xxl: "56px"
components:
  button-primary:
    backgroundColor: "{colors.primary}"
    textColor: "{colors.surface}"
    rounded: "{rounded.none}"
    typography: "{typography.label}"
    height: "52px"
  button-primary-hover:
    backgroundColor: "{colors.primary-deep}"
  button-legacy:
    backgroundColor: "{colors.primary}"
    textColor: "{colors.surface}"
    rounded: "{rounded.sm}"
    padding: "9px 18px"
  card:
    backgroundColor: "{colors.surface}"
    rounded: "{rounded.md}"
    padding: "20px"
  input:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.ink}"
    rounded: "{rounded.sm}"
    padding: "10px 14px"
---

# Design System: CHIN UP Performance

## 1. Overview

**Creative North Star: 「天空下的訓練場」**

晴天藍、白場地、清晰界線——整套系統是一座開闊、乾淨、有精神的運動場域。空間感來自留白與髮絲線，不來自陰影堆疊；能量感來自精確的大數字與狀態燈，不來自裝飾。所有的「證據」（時間、金額、堂數、時數）都以 Archivo 粗體 tabular 數字呈現，像場邊計分板一樣可信。

系統有兩層語彙：**基底層**（colors_and_type.css tokens，全站共用）與 **Nike 技術美學層**（行語法＋Archivo 錨點，現行範圍：my-schedule／admin／coach／checkin）。公開門面頁（首頁團課、教練預約）刻意維持樸素直白，未套 Nike 層——重新設計公開頁時以 PRODUCT.md 的 brand 定位另案處理，員工與會員工具頁一律走 Nike 層。

明確拒絕（引自 PRODUCT.md）：「過時的土網頁」與「AI 樣板感——紫色漸層、滿版圓角卡片、emoji 當圖示、千篇一律的 SaaS 版型」。

**Key Characteristics:**
- 平面優先：髮絲線分層，陰影只留給懸浮行動層
- 數字即證據：Archivo 900 tabular 錨點是每個畫面的視覺重心
- 狀態即語言：6px 方點＋粗標籤取代一切圖示與 emoji
- 方角俐落：行動鈕直角實心＋寬字距；圓角是舊語彙
- 繁體中文文案，直接、不囉嗦

## 2. Colors: 晴空色盤

一個強調色扛全場：競速天藍負責行動與「現在」，其餘一律晴空下的中性色。

### Primary
- **競速天藍**（#0ea5e9，深階 #0284c7）：主行動鈕、目前選取、進行中狀態、左緣提示條。深階 #0284c7 用於 hover 與內文連結；亮階 #38bdf8 只出現在焦點環與水洗漸層。
- **天藍水洗**（#f0f9ff／#e0f2fe）：選取列背景、標籤底、brand-canvas 頁面水洗（兩道極淡天空放射，`body.brand-canvas`）。
- **夜空藍**（#0c4a6e）：選取文字（::selection）等極少數深底場景。

### Neutral
- **墨黑**（#0f172a）：主文字與 Nike 實心鈕（打卡機墨黑鈕）。
- **石板灰**（#475569）／**霧灰**（#94a3b8）：次要文字／提示文字與微標籤。
- **髮絲線**（#e5e7eb）：分層的主要手段，1px 用到底。
- **白場地**（#ffffff）／**晨霧底**（#f8faf9）：卡片／頁面畫布。

### Tertiary
- 狀態語意色（僅表狀態，不作裝飾）：ok #047857、warn #a16207、err #b91c1c、info #1d4ed8，各配淡底與淡框（--ok-bg/--ok-line 系列 token）。
- Logo 彩帶（--accent-pink/orange/yellow/green/cyan/blue）：**只准出現在 logo 與品牌插畫內**，介面禁用。

### Named Rules
**The One-Sky Rule.** 一個畫面只有一個強調色：競速天藍。它屬於「行動」與「現在」；狀態色只說狀態，彩帶色不出 logo。臨場發明新顏色是被禁止的。

## 3. Typography

**Display Font:** Archivo（900／700，搭 Noto Sans TC）
**Body Font:** Inter（搭 LiHei Pro／PingFang TC 中文堆疊）
**Label Font:** Archivo 700 大寫寬字距（.12em–.2em）

**Character:** Inter 負責安靜的內文與標題；Archivo 是計分板的聲音——凡是數字錨點（日期、時間、金額、時數、剩餘堂數）與微標籤（section-label、eyebrow、狀態字），一律 Archivo 粗體、`font-variant-numeric: tabular-nums`。

### Hierarchy
- **Display**（Archivo 900，19–30px 依場景，行高 ~0.95，字距 -0.03em）：數字錨點——課表日期方塊、打卡時間、剩餘堂數、本期時數。永遠 tabular。
- **Headline**（Inter 800，28px／display clamp 28–42px）：頁面主標。
- **Title**（Inter 700，17–20px）：卡片標題、區塊標題；人名 900 加重（.ck-coach、.sn-title 15.5px 900）。
- **Body**（Inter 400–500，14px，行高 1.55）：內文，行長 ≤ 65–75ch。
- **Label**（Archivo 700，9.5–12px，大寫，字距 .12–.2em）：section-label（帶髮絲尾線）、狀態標籤、微標。

### Named Rules
**The Tabular Rule.** 會被對帳的數字（時間、金額、堂數、時數）一律 tabular-nums＋Archivo 錨點。比例字的數字是不可信的。

## 4. Elevation

**平面優先，陰影留給行動。** 表面預設全平：分層靠 1px 髮絲線（#e5e7eb）與底色階（surface／canvas／brand-50）。陰影只授予兩種對象——懸浮層（彈窗、下拉、貼齊底部的行動列）與主 CTA 的品牌光暈。基底 .card 目前殘留 shadow-sm＋hover 微升，屬舊語彙：維護可留，新作不加。

### Shadow Vocabulary
- **ambient-sm**（`0 1px 2px 0 rgba(15,23,42,0.04)`）：舊卡片殘留，新作不用。
- **floating**（`0 12px 32px -8px rgba(15,23,42,0.14)`）：彈窗、drawer 等懸浮層專用。
- **brand-glow**（`0 6px 24px -6px rgba(56,189,248,0.35)`）：主 CTA 專用光暈，一頁最多一處。
- **ring-focus**（`0 0 0 3px rgba(56,189,248,0.15)`）：鍵盤焦點環，全站一致。

### Named Rules
**The Hairline Rule.** 需要分界先想髮絲線，再想底色階，最後才是陰影。若一個靜止元素長出陰影，它就是錯的。

## 5. Components

手感一句話：**方角俐落、狀態即語言**。新介面一律方角實心鈕＋狀態點；圓角鈕（10px）是舊語彙，只維護、不新增。

### Buttons
- **Shape:** 方角（border-radius: 0），Archivo 700–800、字距 .3em 上下、`text-indent` 補償置中。
- **Primary:** 競速天藍實心（#0ea5e9）白字，高 52–58px 全寬（手機主行動）；hover 轉深階 #0284c7。打卡機情境可用墨黑（#0f172a）實心。
- **Destructive:** err 實心（#b91c1c）白字方角（.cancel-btn 語彙），高 32px 起。
- **Hover / Focus:** 160ms ease；focus 一律 ring-focus。
- **Legacy（.btn/.btn-primary）:** 圓角 10px＋brand-glow，存在於既有頁面，勿在新介面複製。

### Chips（.badge 狀態藥丸）
- **Style:** 淡底＋同色系淡框＋深字（badge-open/confirmed/cancelled…），前綴 6px 圓點（currentColor）。
- **State:** 每個狀態一組固定三色（bg/fg/line），來自 token，不現場調色。

### Cards / Containers
- **Corner Style:** 基底卡 14px；Nike 層區塊常直接以髮絲線分節、不包卡。
- **Background:** surface 白；選取／進行中列用 brand-50 水洗。
- **Shadow Strategy:** 見 Elevation——新作不加靜止陰影。
- **Border:** 1px #e5e7eb。
- **Internal Padding:** 16–22px。

### Inputs / Fields
- **Style:** 1px 灰框（#d1d5db）、圓角 8–10px、`font-size: 16px` 防 iOS 縮放；標籤在上（sh-field 骨架），**禁止**在 flex 列裡裸放 `width:100%` 的 .form-input（溢出根因）。
- **Focus:** 邊框轉天藍＋ring-focus。
- **金額欄:** NT$ 前綴（::before）；起訖時間用複合膠囊（.sh-range，grid 1fr auto 1fr）。

### Navigation
- 員工後台為分頁籤；區塊標題用 section-label（Archivo 大寫寬字距＋髮絲尾線）。手機 <768px 表格重排成卡片（pr-table RWD 語彙）。

### 行語法（Signature Component）
清單的標準列：`grid [Archivo 錨點欄 46–56px] [內容] [狀態]`，列間 1px 髮絲線。狀態＝6px 方點＋11.5px 700 標籤（ok 綠／open 藍／warn 琥珀且旋轉 45°／mute 灰）。「下一個／進行中」的那一列加 3px 競速天藍左緣條。my-schedule、checkin、admin 週課表皆此語法。

### Named Rules
**The Rail Rule.** 3px 左緣條是「現在」的專屬記號——標記下一堂課、進行中時段，一個畫面最多一處。它是即時性語意，不是卡片裝飾；任何其他用途的彩色側條都被禁止。
**The Dot Rule.** 狀態一律 6px 方點＋文字標籤。不用 emoji、不用圖示字型、不畫 SVG 小圖。

## 6. Do's and Don'ts

### Do:
- **Do** 所有會被對帳的數字用 Archivo＋tabular-nums（The Tabular Rule）。
- **Do** 分層先髮絲線、再底色階；陰影只給懸浮層與主 CTA（The Hairline Rule）。
- **Do** 新行動鈕一律方角實心＋寬字距；focus 用 ring-focus。
- **Do** 狀態用 6px 方點＋標籤，配色走 token 的狀態三色組。
- **Do** 手機優先驗證：420px 卡片寬、按鈕高 ≥52px、input 16px 防縮放。
- **Do** 文案繁體中文、直接不囉嗦；技術識別字保持原文。

### Don't:
- **Don't** 做出「過時的土網頁」：表格塊狀堆疊、系統字型、無設計的公家機關感（PRODUCT.md 反面清單）。
- **Don't** 做出「AI 樣板感」：紫色漸層、滿版圓角卡片、emoji 當圖示、千篇一律的 SaaS 版型（PRODUCT.md 反面清單）。
- **Don't** 臨場發明色票——不在 token 裡的顏色不存在（The One-Sky Rule）。
- **Don't** 讓 logo 彩帶色（pink/orange/yellow/green/cyan/blue）流出 logo 之外。
- **Don't** 在 3px 左緣「現在」條以外使用任何彩色側條裝飾（The Rail Rule）。
- **Don't** 給靜止元素加陰影、給每個標題配 icon、在每個區塊上方放大寫小字 eyebrow——裝飾要 earn its place。
- **Don't** 在 flex 列裸放 `width:100%` 的 .form-input（歷史溢出根因）；一律用標籤在上的 sh-field 骨架。
- **Don't** 在新介面複製圓角 .btn 舊語彙。
