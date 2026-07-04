// Seed with demo data: users + 3 templates + some registrations to illustrate UI states.
import { db, nowLocal } from './connection.js';
import { createTemplate } from '../services/courseService.js';
import { register } from '../services/registration.js';
import { hashPassword } from '../services/auth.js';
import { createCoach, setCoachActive, getCoachByUser } from '../services/coachService.js';
import { addRule, addException } from '../services/availabilityService.js';
import { createBooking } from '../services/bookingService.js';

// point_transactions is a retained (no longer written) table whose FKs still
// reference sessions/registrations/users; clear it first so the wipe below
// doesn't trip a FOREIGN KEY constraint on databases that hold legacy rows.
// group_orders/bookings 也引用 users（無 cascade）：npm test 跑完常殘留這些列（測試只在開頭 reset）→ 一併先刪。
db.exec("DELETE FROM point_transactions; DELETE FROM discount_redemptions; DELETE FROM auth_sessions; DELETE FROM notifications; DELETE FROM registrations; DELETE FROM group_orders; DELETE FROM bookings; DELETE FROM customer_packages; DELETE FROM course_sessions; DELETE FROM course_templates; DELETE FROM renewal_reminders; DELETE FROM users;");

const insertUser = db.prepare(
  'INSERT INTO users (name, email, phone, password_hash, role, notification_preference) VALUES (?, ?, ?, ?, ?, ?)'
);
insertUser.run('Admin', 'admin@chinup.local', '0900000000', hashPassword('admin1234'), 'admin', 'email');
for (let i = 1; i <= 12; i++) {
  insertUser.run(
    `會員${i}`, `user${i}@chinup.local`, `09${String(i).padStart(8, '0')}`,
    hashPassword('pass1234'),
    'user', i % 2 === 0 ? 'email' : 'both'
  );
}

const t1 = createTemplate({
  name: '週三晚間 TRX 核心訓練',
  description: '60 分鐘功能性訓練，強化核心與上肢協調。適合中階學員。',
  min_capacity: 3, max_capacity: 6,
  day_of_week: 3, start_time: '19:00', duration_minutes: 60,
  recurrence: 'monthly',
  cycle_start_date: '2026-05-01', cycle_end_date: '2026-08-31',
  registration_deadline_hours: 24,
});

const t2 = createTemplate({
  name: '週六晨間流動瑜伽',
  description: '75 分鐘流動瑜伽，放鬆身心、提升柔軟度。全程度皆可。',
  min_capacity: 2, max_capacity: 5,
  day_of_week: 6, start_time: '09:00', duration_minutes: 75,
  recurrence: 'bimonthly',
  cycle_start_date: '2026-05-01', cycle_end_date: '2026-10-31',
  registration_deadline_hours: 48,
});

const t3 = createTemplate({
  name: '週五夜間 HIIT 燃脂班',
  description: '高強度間歇訓練，45 分鐘高效燃脂。體能中高階適合。',
  min_capacity: 4, max_capacity: 8,
  day_of_week: 5, start_time: '20:00', duration_minutes: 45,
  recurrence: 'quarterly',
  cycle_start_date: '2026-05-01', cycle_end_date: '2026-12-31',
  registration_deadline_hours: 24,
});

// 為第一個場次製造滿員 + 候補
function firstSessionId(tplId) {
  return db.prepare(`
    SELECT id FROM course_sessions
    WHERE template_id = ? AND registration_deadline > ?
    ORDER BY start_at ASC LIMIT 1
  `).get(tplId, nowLocal()).id;
}

const s1 = firstSessionId(t1.templateId);   // 週三 TRX 5月場
const s2 = firstSessionId(t2.templateId);   // 週六 瑜伽 5月場
const s3 = firstSessionId(t3.templateId);   // 週五 HIIT 5月場

// TRX 週三：8 人報名（上限 6 → 正取 6, 候補 2）
[2, 3, 4, 5, 6, 7, 8, 9].forEach(uid => {
  try { register({ sessionId: s1, userId: uid }); } catch {}
});

// 週六瑜伽：3 人報名（上限 5，正取 3）— 尚未達上限
[10, 11, 12].forEach(uid => {
  try { register({ sessionId: s2, userId: uid }); } catch {}
});

// HIIT：9 人報名（上限 8 → 正取 8, 候補 1）
[2, 3, 4, 5, 6, 7, 8, 9, 10].forEach(uid => {
  try { register({ sessionId: s3, userId: uid }); } catch {}
});

console.log('[seed-demo] done');
console.log('  templates:', db.prepare('SELECT COUNT(*) AS c FROM course_templates').get().c);
console.log('  sessions:', db.prepare('SELECT COUNT(*) AS c FROM course_sessions').get().c);
console.log('  registrations:', db.prepare('SELECT COUNT(*) AS c FROM registrations').get().c);

// --- Coach: create demo coach user ---
const coachEmail = 'coach1@chinup.local';
let coachUser = db.prepare('SELECT * FROM users WHERE email = ?').get(coachEmail);
if (!coachUser) {
  const info = db.prepare(
    "INSERT INTO users (name, email, password_hash, role, notification_preference) VALUES (?, ?, ?, 'coach', 'email')"
  ).run('王教練', coachEmail, hashPassword('coachpass1234'));
  coachUser = db.prepare('SELECT * FROM users WHERE id = ?').get(info.lastInsertRowid);
  console.log(`[seed] created coach user ${coachEmail} / coachpass1234`);
}

let coach = getCoachByUser(coachUser.id);
if (!coach) {
  const c = createCoach({
    userId: coachUser.id,
    displayName: '王教練',
    specialty: '增肌減脂 · 體態雕塑',
    bio: '10 年訓練資歷，國立體大畢業，CSCS 認證。\n專長：肌力訓練、運動表現、體態雕塑。',
    sortOrder: 10,
  });
  setCoachActive(c.id, true);
  coach = getCoachByUser(coachUser.id);
}

// Add rules if empty
if (db.prepare('SELECT COUNT(*) AS c FROM coach_availability_rules WHERE coach_id = ?').get(coach.id).c === 0) {
  const today = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const from = `${today.getFullYear()}-${pad(today.getMonth() + 1)}-01`;
  for (const dow of [1, 3, 5]) {
    addRule({ coachId: coach.id, dayOfWeek: dow, startTime: '09:00', endTime: '12:00', effectiveFrom: from });
    addRule({ coachId: coach.id, dayOfWeek: dow, startTime: '14:00', endTime: '17:00', effectiveFrom: from });
  }
  // Add one leave exception for a future Tuesday
  const futureTue = new Date(today.getTime() + 14 * 86400_000);
  while (futureTue.getDay() !== 2) futureTue.setDate(futureTue.getDate() + 1);
  const tueStr = `${futureTue.getFullYear()}-${pad(futureTue.getMonth() + 1)}-${pad(futureTue.getDate())}`;
  // Tuesday isn't in the base rules anyway, so use a Monday to make the leave visible
  const futureMon = new Date(today.getTime() + 7 * 86400_000);
  while (futureMon.getDay() !== 1) futureMon.setDate(futureMon.getDate() + 1);
  const monStr = `${futureMon.getFullYear()}-${pad(futureMon.getMonth() + 1)}-${pad(futureMon.getDate())}`;
  addException({ coachId: coach.id, exceptionDate: monStr, type: 'leave', note: '個人事務' });

  console.log(`[seed] coach #${coach.id} rules + exception ready`);
}

// One demo booking 2 weeks out on a Wednesday at 10:00
const coachForBooking = db.prepare("SELECT id FROM coaches WHERE display_name = '王教練'").get();
if (coachForBooking) {
  const today = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const futureWed = new Date(today.getTime() + 14 * 86400_000);
  while (futureWed.getDay() !== 3) futureWed.setDate(futureWed.getDate() + 1);
  const wedStr = `${futureWed.getFullYear()}-${pad(futureWed.getMonth() + 1)}-${pad(futureWed.getDate())}T10:00:00`;
  const memberId = db.prepare("SELECT id FROM users WHERE email = 'user1@chinup.local'").get()?.id;
  const alreadyBooked = memberId && db.prepare("SELECT 1 FROM bookings WHERE coach_id = ? AND member_id = ? AND start_at = ? AND status = 'confirmed'").get(coachForBooking.id, memberId, wedStr);
  if (memberId && !alreadyBooked) {
    try { createBooking({ coachId: coachForBooking.id, memberId, startAt: wedStr, note: '想練腿' }); } catch (e) { console.warn('[seed] demo booking skipped:', e.message); }
    console.log(`[seed] demo booking for user1 with 王教練 at ${wedStr}`);
  }
}
