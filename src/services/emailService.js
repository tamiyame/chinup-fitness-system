// 1對1 預約確認信。寄送結果寫 notifications（channel='email'）重用既有退避重試。
// Gmail 未設定（無 refresh token）→ 比照 LINE console fallback：寫 console 列、不報錯。
import { db, offsetLocal } from '../db/connection.js';
import { sendMail } from './gmailClient.js';
import { isGmailConfigured } from './googleAuth.js';
import { getBankInfo, getLineOfficialUrl } from './discountService.js';

const getBookingFull = db.prepare(`
  SELECT b.*, c.display_name AS coach_name, u.name AS member_name
  FROM bookings b JOIN coaches c ON c.id = b.coach_id JOIN users u ON u.id = b.member_id
  WHERE b.id = ?
`);
const insertNotif = db.prepare(`
  INSERT INTO notifications (user_id, session_id, type, channel, subject, body, status, retry_count, next_retry_at, last_error, recipient)
  VALUES (?, NULL, ?, ?, ?, ?, ?, 0, ?, ?, ?)
`);

const DOW = ['日', '一', '二', '三', '四', '五', '六'];
const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export function _buildConfirmationHtml(bookingId) {
  const b = getBookingFull.get(bookingId);
  if (!b) return null;
  const [date, time] = b.start_at.split('T');
  const [y, m, d] = date.split('-').map(Number);
  const dow = DOW[new Date(`${date}T00:00:00Z`).getUTCDay()];
  const label = b.session_type === '1on2' ? '1對2' : '1對1';
  const final = b.original_amount != null ? b.original_amount - (b.discount_amount || 0) : null;
  const publicUrl = (process.env.PUBLIC_URL || '').replace(/\/$/, '');
  const lineUrl = getLineOfficialUrl();
  const rows = [
    ['教練', b.coach_name],
    ['時間', `${y}/${String(m).padStart(2, '0')}/${String(d).padStart(2, '0')}（週${dow}）${time.slice(0, 5)}–${b.end_at.split('T')[1].slice(0, 5)}`],
    ['方案', label],
    final != null ? ['現場應付', `$${final.toLocaleString()}${b.discount_code ? `（已套用折扣碼 ${esc(b.discount_code)}）` : ''}`] : null,
    ['匯款資訊', getBankInfo()],
  ].filter(Boolean);
  return `<div style="font-family:sans-serif;max-width:560px;margin:0 auto;color:#1e293b">
  <h2 style="color:#0369a1">CHINUP Performance 預約確認</h2>
  <p>${esc(b.member_name)} 您好，已為您完成以下預約：</p>
  <table style="border-collapse:collapse;width:100%">${rows.map(([k, v]) =>
    `<tr><td style="padding:6px 12px 6px 0;color:#64748b;white-space:nowrap">${k}</td><td style="padding:6px 0"><strong>${esc(v)}</strong></td></tr>`).join('')}
  </table>
  <p style="color:#64748b;font-size:14px">如需取消，請至 <a href="${esc(publicUrl)}/my-schedule">我的課表</a> 以姓名＋電話查詢後操作。</p>
  <p style="color:#64748b;font-size:14px">款項核對完成後會再寄送確認通知。</p>
  ${lineUrl ? `<p style="font-size:14px"><a href="${esc(lineUrl)}">加入官方 LINE</a> 可收上課提醒與最新通知。</p>` : ''}
  <p style="color:#94a3b8;font-size:12px">此信由系統自動發送，請勿直接回覆。</p>
</div>`;
}

/** 預約成立後呼叫（commit 後、不 await）。 */
export async function sendBookingConfirmation(bookingId) {
  try {
    const b = getBookingFull.get(bookingId);
    if (!b || !b.customer_email) return;
    const subject = `預約確認｜${b.start_at.slice(5, 10).replace('-', '/')} ${b.start_at.slice(11, 16)} ${b.coach_name} 教練`;
    const html = _buildConfirmationHtml(bookingId);
    if (!isGmailConfigured()) {
      // 未設定 Gmail → console fallback（與 LINE 未綁定同精神），測試/未啟用環境不產生 failed 列
      insertNotif.run(b.member_id, 'booking_email_confirmation', 'console', subject, html, 'sent', null, null, b.customer_email);
      console.log(`[email→console] booking=${bookingId} to=${b.customer_email} ${subject}`);
      return;
    }
    const r = await sendMail({ to: b.customer_email, subject, html });
    if (r.ok) {
      insertNotif.run(b.member_id, 'booking_email_confirmation', 'email', subject, html, 'sent', null, null, b.customer_email);
    } else {
      insertNotif.run(b.member_id, 'booking_email_confirmation', 'email', subject, html, 'failed', offsetLocal(5 * 60_000), r.error, b.customer_email);
    }
  } catch (e) { console.error('[email] sendBookingConfirmation threw:', e); }
}

/** admin 核對款項後呼叫（fire-and-forget）。無 customer_email 自動略過。 */
export async function sendPaymentConfirmedEmail(bookingId) {
  try {
    const b = getBookingFull.get(bookingId);
    if (!b || !b.customer_email) return;
    const final = b.original_amount != null ? b.original_amount - (b.discount_amount || 0) : null;
    const [date, time] = b.start_at.split('T');
    const subject = `款項確認｜${b.start_at.slice(5, 10).replace('-', '/')} ${b.start_at.slice(11, 16)} ${b.coach_name} 教練`;
    const html = `<div style="font-family:sans-serif;max-width:560px;margin:0 auto;color:#1e293b">
  <h2 style="color:#15803d">款項已確認，預約成立</h2>
  <p>${esc(b.member_name)} 您好，我們已收到您的款項${final != null ? `（NT$${final.toLocaleString()}）` : ''}，以下預約確認成立：</p>
  <p><strong>${esc(b.coach_name)}</strong> 教練｜${esc(date.replace(/-/g, '/'))} ${esc(time.slice(0, 5))}｜${b.session_type === '1on2' ? '1對2' : '1對1'}</p>
  <p style="color:#94a3b8;font-size:12px">此信由系統自動發送，請勿直接回覆。</p>
</div>`;
    if (!isGmailConfigured()) {
      insertNotif.run(b.member_id, 'booking_payment_email', 'console', subject, html, 'sent', null, null, b.customer_email);
      console.log(`[email→console] payment-confirmed booking=${bookingId} to=${b.customer_email}`);
      return;
    }
    const r = await sendMail({ to: b.customer_email, subject, html });
    if (r.ok) {
      insertNotif.run(b.member_id, 'booking_payment_email', 'email', subject, html, 'sent', null, null, b.customer_email);
    } else {
      insertNotif.run(b.member_id, 'booking_payment_email', 'email', subject, html, 'failed', offsetLocal(5 * 60_000), r.error, b.customer_email);
    }
  } catch (e) { console.error('[email] sendPaymentConfirmedEmail threw:', e); }
}

const getRecurringGroup = db.prepare(`
  SELECT b.*, c.display_name AS coach_name, u.name AS member_name
  FROM bookings b JOIN coaches c ON c.id = b.coach_id JOIN users u ON u.id = b.member_id
  WHERE b.recurring_group_id = ? AND b.status = 'confirmed'
  ORDER BY b.start_at ASC
`);

/** 循環預約摘要信（建立後呼叫一次，fire-and-forget）。無 customer_email 自動略過。 */
export async function sendRecurringConfirmation(groupId) {
  try {
    const rows = getRecurringGroup.all(groupId);
    if (!rows.length || !rows[0].customer_email) return;
    const b = rows[0];
    const label = b.session_type === '1on2' ? '1對2' : '1對1';
    const total = rows.reduce((sum, r) => sum + (r.original_amount != null ? r.original_amount - (r.discount_amount || 0) : 0), 0);
    const paid = !!b.paid_at;
    const publicUrl = (process.env.PUBLIC_URL || '').replace(/\/$/, '');
    const DOW = ['日', '一', '二', '三', '四', '五', '六'];
    const fmtRow = (r) => {
      const [date, time] = r.start_at.split('T');
      const dow = DOW[new Date(`${date}T00:00:00Z`).getUTCDay()];
      return `${date.replace(/-/g, '/')}（週${dow}）${time.slice(0, 5)}`;
    };
    const subject = `課程安排確認｜${b.coach_name} 教練 ${label} 共 ${rows.length} 堂`;
    const html = `<div style="font-family:sans-serif;max-width:560px;margin:0 auto;color:#1e293b">
  <h2 style="color:#0369a1">CHINUP Performance 課程安排確認</h2>
  <p>${esc(b.member_name)} 您好，已為您安排 <strong>${esc(b.coach_name)}</strong> 教練的 ${label} 課程共 ${rows.length} 堂：</p>
  <ul style="padding-left:18px;line-height:1.8">${rows.map((r) => `<li>${esc(fmtRow(r))}</li>`).join('')}</ul>
  <p>合計：<strong>NT$${total.toLocaleString()}</strong>　款項狀態：<strong>${paid ? '已收款' : '待核對（請依匯款資訊完成付款）'}</strong></p>
  ${paid ? '' : `<p style="color:#64748b;font-size:14px">匯款資訊：${esc(getBankInfo())}</p>`}
  <p style="color:#64748b;font-size:14px">如需調整單堂時間，請至 <a href="${esc(publicUrl)}/my-schedule">我的課表</a> 取消該堂後與我們重新安排。</p>
  <p style="color:#94a3b8;font-size:12px">此信由系統自動發送，請勿直接回覆。</p>
</div>`;
    if (!isGmailConfigured()) {
      insertNotif.run(b.member_id, 'booking_recurring_email', 'console', subject, html, 'sent', null, null, b.customer_email);
      console.log(`[email→console] recurring group=${groupId} to=${b.customer_email} ${subject}`);
      return;
    }
    const r = await sendMail({ to: b.customer_email, subject, html });
    if (r.ok) {
      insertNotif.run(b.member_id, 'booking_recurring_email', 'email', subject, html, 'sent', null, null, b.customer_email);
    } else {
      insertNotif.run(b.member_id, 'booking_recurring_email', 'email', subject, html, 'failed', offsetLocal(5 * 60_000), r.error, b.customer_email);
    }
  } catch (e) { console.error('[email] sendRecurringConfirmation threw:', e); }
}
