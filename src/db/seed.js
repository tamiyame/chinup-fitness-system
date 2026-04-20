import { db } from './connection.js';
import { hashPassword } from '../services/auth.js';

db.exec('DELETE FROM auth_sessions; DELETE FROM notifications; DELETE FROM registrations; DELETE FROM course_sessions; DELETE FROM course_templates; DELETE FROM users;');

const insertUser = db.prepare(
  'INSERT INTO users (name, email, phone, password_hash, role, notification_preference) VALUES (?, ?, ?, ?, ?, ?)'
);

insertUser.run('Admin', 'admin@chinup.local', '0900000000', hashPassword('admin1234'), 'admin', 'email');
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
console.log('[seed] demo credentials:');
console.log('  admin@chinup.local / admin1234');
console.log('  user{1..12}@chinup.local / pass1234');
