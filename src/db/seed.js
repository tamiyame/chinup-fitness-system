import { db } from './connection.js';
import { hashPassword } from '../services/auth.js';

db.exec('DELETE FROM auth_sessions; DELETE FROM notifications; DELETE FROM point_transactions; DELETE FROM bookings; DELETE FROM registrations; DELETE FROM course_sessions; DELETE FROM course_templates; DELETE FROM coaches; DELETE FROM users;');

const insertUser = db.prepare(
  'INSERT INTO users (name, email, phone, password_hash, role, notification_preference) VALUES (?, ?, ?, ?, ?, ?)'
);

insertUser.run('Admin', 'admin@chinup.local', '0900000000', hashPassword('admin1234'), 'admin', 'email');

// Seed a coach user so public /api/coaches returns at least one active coach
const coachInfo = insertUser.run('示範教練', 'coach1@chinup.local', '0900000099', hashPassword('pass1234'), 'coach', 'email');
const coachUserId = coachInfo.lastInsertRowid;
db.prepare(
  'INSERT INTO coaches (user_id, display_name, specialty, is_active, sort_order) VALUES (?, ?, ?, 1, 0)'
).run(coachUserId, '示範教練', '重訓');

for (let i = 1; i <= 12; i++) {
  insertUser.run(
    `會員${i}`,
    `user${i}@chinup.local`,
    `09${String(i).padStart(8, '0')}`,
    hashPassword('pass1234'),
    'user',
    i % 2 === 0 ? 'email' : 'both'
  );
}

// Seed a course template + one open session so public registration tests have something to work with
const tplInfo = db.prepare(`
  INSERT INTO course_templates
    (name, description, min_capacity, max_capacity, day_of_week, start_time,
     duration_minutes, recurrence, cycle_start_date, cycle_end_date,
     registration_deadline_hours, status)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`).run(
  '示範團課', '種子資料示範用團課', 1, 10,
  1, '10:00', 60, 'weekly',
  '2026-01-01', '2027-12-31',
  1, 'published'
);
const tplId = tplInfo.lastInsertRowid;

// One open session 7 days from now, deadline 2 hours from now (well within the future)
const now = new Date();
const sessionDate = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);
const pad = (n) => String(n).padStart(2, '0');
const sessionDateStr = `${sessionDate.getFullYear()}-${pad(sessionDate.getMonth() + 1)}-${pad(sessionDate.getDate())}`;
const startAt = `${sessionDateStr}T10:00:00`;
const endAt = `${sessionDateStr}T11:00:00`;
// registration_deadline: 2 hours from now
const deadlineDate = new Date(now.getTime() + 2 * 60 * 60 * 1000);
const deadlineStr = `${deadlineDate.getFullYear()}-${pad(deadlineDate.getMonth() + 1)}-${pad(deadlineDate.getDate())}T${pad(deadlineDate.getHours())}:${pad(deadlineDate.getMinutes())}:${pad(deadlineDate.getSeconds())}`;

db.prepare(`
  INSERT INTO course_sessions (template_id, session_date, start_at, end_at, registration_deadline, status)
  VALUES (?, ?, ?, ?, ?, 'open')
`).run(tplId, sessionDateStr, startAt, endAt, deadlineStr);

console.log('[seed] users created:', db.prepare('SELECT COUNT(*) AS c FROM users').get().c);
console.log('[seed] coaches created:', db.prepare('SELECT COUNT(*) AS c FROM coaches WHERE is_active = 1').get().c);
console.log('[seed] course sessions created:', db.prepare('SELECT COUNT(*) AS c FROM course_sessions WHERE status = \'open\'').get().c);
console.log('[seed] demo credentials:');
console.log('  admin@chinup.local / admin1234');
console.log('  coach1@chinup.local / pass1234');
console.log('  user{1..12}@chinup.local / pass1234');
