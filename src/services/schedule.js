// 將課程範本展開為實際場次清單。純函式，方便測試。

const RECURRENCE_STEP_DAYS = {
  monthly: 7,      // 每月一次 = 每 7*4 天…其實我們用「每週同一天」為單位展開，依 cycle 期間內所有該 day_of_week 的日期
  bimonthly: 7,
  quarterly: 7,
  semiannual: 7,
};

// 每個 recurrence 代表「多久出現一次場次」。最直觀的模型：
// - monthly: 該月第一個 day_of_week
// - bimonthly: 每兩個月第一個 day_of_week
// - quarterly: 每季第一個 day_of_week
// - semiannual: 每半年第一個 day_of_week
const RECURRENCE_MONTH_STEP = {
  monthly: 1,
  bimonthly: 2,
  quarterly: 3,
  semiannual: 6,
};

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

export function expandTemplate(tpl) {
  const {
    day_of_week,
    start_time,
    duration_minutes,
    recurrence,
    cycle_start_date,
    cycle_end_date,
    registration_deadline_hours,
  } = tpl;

  const monthStep = RECURRENCE_MONTH_STEP[recurrence];
  if (!monthStep) throw new Error(`unknown recurrence: ${recurrence}`);

  const start = new Date(cycle_start_date + 'T00:00:00Z');
  const end = new Date(cycle_end_date + 'T23:59:59Z');

  const sessions = [];
  let cursorYear = start.getUTCFullYear();
  let cursorMonth = start.getUTCMonth();

  while (true) {
    const sessionDate = firstDayOfWeekInMonth(cursorYear, cursorMonth, day_of_week);
    if (sessionDate > end) break;
    if (sessionDate >= start) {
      const ymd = toYMD(sessionDate);
      const startAt = combineLocal(ymd, start_time);
      const endAt = addMinutesLocal(startAt, duration_minutes);
      const deadline = addMinutesLocal(startAt, -registration_deadline_hours * 60);
      sessions.push({
        session_date: ymd,
        start_at: startAt,
        end_at: endAt,
        registration_deadline: deadline,
      });
    }
    cursorMonth += monthStep;
    if (cursorMonth >= 12) {
      cursorYear += Math.floor(cursorMonth / 12);
      cursorMonth = cursorMonth % 12;
    }
  }

  return sessions;
}
