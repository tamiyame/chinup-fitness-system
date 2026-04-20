// Seed with demo data: users + 3 templates + some registrations to illustrate UI states.
import { db } from './connection.js';
import { createTemplate } from '../services/courseService.js';
import { register } from '../services/registration.js';
import { hashPassword } from '../services/auth.js';

db.exec("DELETE FROM auth_sessions; DELETE FROM notifications; DELETE FROM registrations; DELETE FROM course_sessions; DELETE FROM course_templates; DELETE FROM users;");

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
  return db.prepare('SELECT id FROM course_sessions WHERE template_id = ? ORDER BY start_at ASC LIMIT 1').get(tplId).id;
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
