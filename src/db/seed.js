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

console.log('[seed] users created:', db.prepare('SELECT COUNT(*) AS c FROM users').get().c);
console.log('[seed] coaches created:', db.prepare('SELECT COUNT(*) AS c FROM coaches WHERE is_active = 1').get().c);
console.log('[seed] demo credentials:');
console.log('  admin@chinup.local / admin1234');
console.log('  coach1@chinup.local / pass1234');
console.log('  user{1..12}@chinup.local / pass1234');
