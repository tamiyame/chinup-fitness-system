import { db } from './connection.js';
import { hashPassword } from '../services/auth.js';

// 依 FK 依賴順序清空：group_orders/bookings/point_transactions/customer_packages 都引用 users（無 cascade），
// 測試跑完常留下這些列（測試只在開頭 reset），不先刪會讓 DELETE FROM users 撞 FK。
// customer_packages 須在 bookings 之後（bookings.package_id 參照它）、users 之前（member_id/created_by 參照 users）。
db.exec(`
  DELETE FROM auth_sessions;
  DELETE FROM notifications;
  DELETE FROM point_transactions;
  DELETE FROM discount_redemptions;
  DELETE FROM registrations;
  DELETE FROM group_orders;
  DELETE FROM bookings;
  DELETE FROM customer_packages;
  DELETE FROM course_sessions;
  DELETE FROM course_templates;
  DELETE FROM renewal_reminders;
  DELETE FROM users;
`);

const insertUser = db.prepare(
  'INSERT INTO users (name, email, phone, password_hash, role, notification_preference) VALUES (?, ?, ?, ?, ?, ?)'
);

// 管理者 = 有管理者標籤(is_admin=1)的教練；教練檔案未啟用 → 不出現在公開教練清單。
const adminInfo = db.prepare(
  "INSERT INTO users (name, email, phone, password_hash, role, is_admin, notification_preference) VALUES (?, ?, ?, ?, 'coach', 1, 'email')"
).run('Admin', 'admin@chinup.local', '0900000000', hashPassword('admin1234'));
db.prepare('INSERT INTO coaches (user_id, display_name) VALUES (?, ?)').run(Number(adminInfo.lastInsertRowid), 'Admin');
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
