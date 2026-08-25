// 期課雙月期別：純日期運算，不碰 DB。
// 日期一律 YYYY-MM-DD 字串、以 UTC 計算（與 schedule.js 同法，避免 DST／時區偏移）。
// 期別固定為日曆雙月：1–2、3–4、5–6、7–8、9–10、11–12 月。

function parse(ymd) {
  const [y, m, d] = ymd.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}
function fmt(d) { return d.toISOString().slice(0, 10); }
function addDays(d, n) { const r = new Date(d); r.setUTCDate(r.getUTCDate() + n); return r; }

/** 該日所屬期別 { start: 奇數月 1 日, end: 偶數月最後一天 }。 */
export function periodOf(ymd) {
  const d = parse(ymd);
  const y = d.getUTCFullYear();
  const m0 = d.getUTCMonth();            // 0-based
  const startM0 = m0 - (m0 % 2);         // 偶數索引＝奇數月（0=1月、2=3月…）
  return {
    start: fmt(new Date(Date.UTC(y, startM0, 1))),
    end: fmt(new Date(Date.UTC(y, startM0 + 2, 0))),   // 下下月第 0 天＝偶數月最後一天
  };
}

/** 下一個期別。 */
export function nextPeriod(period) {
  return periodOf(fmt(addDays(parse(period.end), 1)));
}

/** 該日所在週（週一～週日）的週一。 */
export function weekStartMonday(ymd) {
  const d = parse(ymd);
  const back = (d.getUTCDay() + 6) % 7;  // 週一=0 … 週日=6
  return fmt(addDays(d, -back));
}

/** 該期「開放下期報名」的日期：錨點＝期末 − 7 天；錨點非週一則往前推到該週週一。 */
export function periodOpenDate(period) {
  return weekStartMonday(fmt(addDays(parse(period.end), -7)));
}

/** 今天應保證範本開到哪一天：已進最後一週 → 下期末，否則本期末。 */
export function targetEndFor(today) {
  const p = periodOf(today);
  return today >= periodOpenDate(p) ? nextPeriod(p).end : p.end;
}

/** 期別顯示：'9–10 月'（en dash）。期別永不跨年，不帶年份。 */
export function periodLabel(period) {
  const sm = parse(period.start).getUTCMonth() + 1;
  const em = parse(period.end).getUTCMonth() + 1;
  return `${sm}–${em} 月`;
}
