// 確認信：RFC822 組裝、寄送→notifications(email) 列、失敗退避、retry 分流。
import assert from 'node:assert/strict';
process.env.GMAIL_MOCK = '1';
const { db, nowLocal, offsetLocal } = await import('../src/db/connection.js');
const { _buildRawMessage } = await import('../src/services/gmailClient.js');
const { sendBookingConfirmation, _buildConfirmationHtml } = await import('../src/services/emailService.js');
const { processFailedNotifications } = await import('../src/services/notifications.js');

function expect(label, fn){ try{fn();console.log(`  ✓ ${label}`);}catch(e){console.log(`  ✗ ${label}`);console.error(e);process.exitCode=1;} }
async function expectA(label, fn){ try{await fn();console.log(`  ✓ ${label}`);}catch(e){console.log(`  ✗ ${label}`);console.error(e);process.exitCode=1;} }
console.log('[email-confirmation test] start');
db.exec("DELETE FROM notifications WHERE channel='email'; DELETE FROM bookings; DELETE FROM coaches; DELETE FROM users WHERE email LIKE 'em-%' OR phone='0996123123'");

expect('RFC822：Subject RFC2047、To、HTML base64、base64url 輸出', () => {
  const raw = _buildRawMessage({ to: 'a@b.c', subject: '預約確認', html: '<b>哈囉</b>' });
  const decoded = Buffer.from(raw, 'base64url').toString('utf8');
  assert.ok(decoded.includes('To: a@b.c'));
  assert.ok(decoded.includes(`Subject: =?UTF-8?B?${Buffer.from('預約確認').toString('base64')}?=`));
  assert.ok(decoded.includes('Content-Type: text/html; charset=UTF-8'));
  assert.ok(decoded.includes(Buffer.from('<b>哈囉</b>').toString('base64')));
});

const cuid = Number(db.prepare("INSERT INTO users (name,email,role) VALUES ('教練乙','em-c@x.com','coach')").run().lastInsertRowid);
const coachId = Number(db.prepare("INSERT INTO coaches (user_id, display_name, is_active) VALUES (?, '教練乙', 1)").run(cuid).lastInsertRowid);
const uid = Number(db.prepare("INSERT INTO users (name,role,phone) VALUES ('陳小美','user','0996123123')").run().lastInsertRowid);
const bid = Number(db.prepare(
  "INSERT INTO bookings (coach_id, member_id, start_at, end_at, session_type, original_amount, discount_amount, discount_code, customer_email) VALUES (?, ?, '2026-07-01T14:00:00', '2026-07-01T15:00:00', '1on1', 1500, 100, 'TEST', 'mei@example.com')"
).run(coachId, uid).lastInsertRowid);

expect('HTML 內容含教練/時間/折後金額/匯款資訊', () => {
  const html = _buildConfirmationHtml(bid);
  assert.ok(html.includes('教練乙'));
  assert.ok(html.includes('2026/07/01'));
  assert.ok(html.includes('14:00'));
  assert.ok(html.includes('1,400') || html.includes('1400'));
  assert.ok(html.includes('合作金庫'));
});

await expectA('GMAIL_MOCK=1 寄送 → notifications channel=email status=sent + recipient', async () => {
  await sendBookingConfirmation(bid);
  const row = db.prepare("SELECT * FROM notifications WHERE channel='email' AND user_id=? ORDER BY id DESC").get(uid);
  assert.ok(row);
  assert.equal(row.status, 'sent');
  assert.equal(row.recipient, 'mei@example.com');
  assert.equal(row.type, 'booking_email_confirmation');
});

await expectA('GMAIL_MOCK=fail → failed + next_retry_at；retry（mock 復原）→ sent', async () => {
  process.env.GMAIL_MOCK = 'fail';
  await sendBookingConfirmation(bid);
  const row = db.prepare("SELECT * FROM notifications WHERE channel='email' AND status='failed' AND user_id=?").get(uid);
  assert.ok(row && row.next_retry_at);
  process.env.GMAIL_MOCK = '1';
  db.prepare("UPDATE notifications SET next_retry_at=? WHERE id=?").run(offsetLocal(-60_000), row.id);
  await processFailedNotifications();
  assert.equal(db.prepare('SELECT status FROM notifications WHERE id=?').get(row.id).status, 'sent');
});

db.exec("DELETE FROM notifications WHERE channel='email'; DELETE FROM bookings; DELETE FROM coaches; DELETE FROM users WHERE email LIKE 'em-%' OR phone='0996123123'");
console.log('[email-confirmation test] done');
