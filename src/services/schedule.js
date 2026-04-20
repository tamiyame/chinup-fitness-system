// 將課程範本展開為實際場次清單。純函式，方便測試。

// 每個月節拍型 recurrence 代表：在起訖期間內，每 N 個月取該月的第一個 day_of_week。
const RECURRENCE_MONTH_STEP = {
  monthly: 1,
  bimonthly: 2,
  quarterly: 3,
  semiannual: 6,
};

export const RECURRENCES = ['weekly', 'monthly', 'bimonthly', 'quarterly', 'semiannual'];

function firstDayOfWeekInMonth(year, month, dayOfWeek) {
  const d = new Date(Date.UTC(year, month, 1));
  const diff = (dayOfWeek - d.getUTCDay() + 7) % 7;
  d.setUTCDate(1 + diff);
  return d;
}

function toYMD(d) {
  return d.toISOString().slice(0, 10);
}

// 把所有 datetime 以 local wall-clock 儲存：YYYY-MM-DDTHH:MM:SS (無時區標記)。
// 前端以 new Date(str) 解析會當作本地時間，符合場館排課直覺。
function combineLocal(ymd, hhmm) {
  return `${ymd}T${hhmm}:00`;
}

function addMinutesLocal(localStr, minutes) {
  const [date, time] = localStr.split('T');
  const [h, m, s] = time.split(':').map(Number);
  const [y, mo, d] = date.split('-').map(Number);
  const dt = new Date(y, mo - 1, d, h, m + minutes, s);
  const pad = (n) => String(n).padStart(2, '0');
  return `${dt.getFullYear()}-${pad(dt.getMonth() + 1)}-${pad(dt.getDate())}T${pad(dt.getHours())}:${pad(dt.getMinutes())}:${pad(dt.getSeconds())}`;
}

function buildSession(date, start_time, duration_minutes, registration_deadline_hours) {
  const ymd = toYMD(date);
  const startAt = combineLocal(ymd, start_time);
  const endAt = addMinutesLocal(startAt, duration_minutes);
  const deadline = addMinutesLocal(startAt, -registration_deadline_hours * 60);
  return { session_date: ymd, start_at: startAt, end_at: endAt, registration_deadline: deadline };
}

function expandWeekly(tpl) {
  const { day_of_week, start_time, duration_minutes, cycle_start_date, cycle_end_date, registration_deadline_hours } = tpl;
  const start = new Date(cycle_start_date + 'T00:00:00Z');
  const end = new Date(cycle_end_date + 'T23:59:59Z');

  // 找到起始日後（含）第一個符合 day_of_week 的日期
  const first = new Date(start);
  const diff = (day_of_week - first.getUTCDay() + 7) % 7;
  first.setUTCDate(first.getUTCDate() + diff);

  const sessions = [];
  for (let cur = first; cur <= end; cur.setUTCDate(cur.getUTCDate() + 7)) {
    sessions.push(buildSession(cur, start_time, duration_minutes, registration_deadline_hours));
  }
  return sessions;
}

function expandByMonthStep(tpl, monthStep) {
  const { day_of_week, start_time, duration_minutes, cycle_start_date, cycle_end_date, registration_deadline_hours } = tpl;
  const start = new Date(cycle_start_date + 'T00:00:00Z');
  const end = new Date(cycle_end_date + 'T23:59:59Z');

  const sessions = [];
  let cursorYear = start.getUTCFullYear();
  let cursorMonth = start.getUTCMonth();

  while (true) {
    const sessionDate = firstDayOfWeekInMonth(cursorYear, cursorMonth, day_of_week);
    if (sessionDate > end) break;
    if (sessionDate >= start) {
      sessions.push(buildSession(sessionDate, start_time, duration_minutes, registration_deadline_hours));
    }
    cursorMonth += monthStep;
    if (cursorMonth >= 12) {
      cursorYear += Math.floor(cursorMonth / 12);
      cursorMonth = cursorMonth % 12;
    }
  }
  return sessions;
}

export function expandTemplate(tpl) {
  const { recurrence } = tpl;
  if (recurrence === 'weekly') return expandWeekly(tpl);
  const monthStep = RECURRENCE_MONTH_STEP[recurrence];
  if (!monthStep) throw new Error(`unknown recurrence: ${recurrence}`);
  return expandByMonthStep(tpl, monthStep);
}
