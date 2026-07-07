# 教練後台頁籤順序 Implementation Plan

> 機械性小改動（比照業主既有偏好：diff 自明之瑣碎任務由 controller 直接實作、免逐任務審查）。

**Spec:** `docs/superpowers/specs/2026-07-07-coach-tab-order-design.md`

- [ ] coach.html:236-239 按鈕重排（register 帶 tab-active）
- [ ] coach.html:242-245 panel hidden 對調
- [ ] coach.js:114 `await renderBookings()` → `switchTab('register')`
- [ ] Playwright 驗證＋commit
