// Gmail API v1 寄信 wrapper（零 npm 依賴）。GMAIL_MOCK=1 → 成功；'fail' → 失敗。
// From 預設省略（Gmail 自動帶授權帳號）；要顯示名稱可設 GMAIL_FROM（如
// "CHINUP Performance <gym@gmail.com>"，位址必須是授權帳號本人或其別名）。
import { getGmailToken } from './googleAuth.js';

const SEND_URL = 'https://gmail.googleapis.com/gmail/v1/users/me/messages/send';

export function _buildRawMessage({ to, subject, html }) {
  const subjB64 = `=?UTF-8?B?${Buffer.from(subject).toString('base64')}?=`;
  const headers = [];
  if (process.env.GMAIL_FROM) headers.push(`From: ${process.env.GMAIL_FROM}`);
  headers.push(
    `To: ${to}`,
    `Subject: ${subjB64}`,
    'MIME-Version: 1.0',
    'Content-Type: text/html; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
  );
  const msg = headers.join('\r\n') + '\r\n\r\n' + Buffer.from(html).toString('base64');
  return Buffer.from(msg).toString('base64url');
}

/** 寄一封 HTML 信。回傳 { ok } 或 { ok:false, error }，never throws。 */
export async function sendMail({ to, subject, html }) {
  if (process.env.GMAIL_MOCK === '1') return { ok: true };
  if (process.env.GMAIL_MOCK === 'fail') return { ok: false, error: 'mock_fail' };
  const t = await getGmailToken();
  if (!t.ok) return { ok: false, error: t.error };
  try {
    const res = await fetch(SEND_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${t.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ raw: _buildRawMessage({ to, subject, html }) }),
    });
    if (res.ok) return { ok: true };
    const errText = await res.text().catch(() => '');
    return { ok: false, error: `HTTP ${res.status}: ${errText.slice(0, 200)}` };
  } catch (e) {
    return { ok: false, error: `network: ${e.message}` };
  }
}
