import { db } from '../db/connection.js';

// Notification stub — real system would push to a queue for SMS/SMTP providers.
// 這裡用 DB log + console 輸出模擬寄送，方便測試時檢視。

const TEMPLATES = {
  registered_confirmed: {
    subject: '報名成功 - {{course_name}}',
    body: '您已成功報名 {{course_name}}（{{start_at}}），期待與您相見！',
  },
  registered_waitlisted: {
    subject: '已進候補 - {{course_name}}',
    body: '您報名的 {{course_name}} 目前已額滿，您為候補第 {{position}} 位。如有正取取消將自動遞補並另行通知。',
  },
  promoted: {
    subject: '恭喜遞補成功 - {{course_name}}',
    body: '您候補的 {{course_name}}（{{start_at}}）有人取消，您已遞補為正取。',
  },
  course_confirmed: {
    subject: '課程成立 - {{course_name}}',
    body: '{{course_name}}（{{start_at}}）已達開課人數，課程確認開課。',
  },
  course_cancelled: {
    subject: '課程取消 - {{course_name}}',
    body: '很抱歉，{{course_name}}（{{start_at}}）因未達開課人數，本次取消。',
  },
  reminder: {
    subject: '上課提醒 - {{course_name}}',
    body: '提醒您，{{course_name}} 將於 {{start_at}} 開始，請準時抵達。',
  },
  registration_cancelled: {
    subject: '報名已取消 - {{course_name}}',
    body: '您已成功取消 {{course_name}}（{{start_at}}）的報名。',
  },
};

function render(template, vars) {
  return template.replace(/\{\{(\w+)\}\}/g, (_, k) => vars[k] ?? '');
}

const insertNotif = db.prepare(
  'INSERT INTO notifications (user_id, session_id, type, channel, subject, body) VALUES (?, ?, ?, ?, ?, ?)'
);
const getUser = db.prepare('SELECT * FROM users WHERE id = ?');

export function notify({ userId, sessionId, type, vars = {}, channelOverride = null }) {
  const tpl = TEMPLATES[type];
  if (!tpl) throw new Error(`unknown notification type: ${type}`);
  const subject = render(tpl.subject, vars);
  const body = render(tpl.body, vars);
  const user = getUser.get(userId);
  if (!user) return;

  const pref = channelOverride || user.notification_preference;
  const channels = pref === 'both' ? ['email', 'sms'] : [pref];

  for (const ch of channels) {
    insertNotif.run(userId, sessionId, type, ch, subject, body);
    console.log(`[notify] → ${user.email} [${ch}] ${subject}`);
  }
}
