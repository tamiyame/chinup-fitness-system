// LINE Messaging API thin wrapper. Zero npm deps — uses native fetch + node:crypto.
// All public functions are mock-aware via process.env.LINE_MOCK so tests can run
// the full notify path without hitting line.me.
import { createHmac, timingSafeEqual } from 'node:crypto';

const PUSH_URL = 'https://api.line.me/v2/bot/message/push';
const REPLY_URL = 'https://api.line.me/v2/bot/message/reply';

// Internal helper: shared POST logic for both push + reply endpoints.
// Returns { ok: true } on 2xx, { ok: false, error } otherwise. Never throws.
async function _post(url, body) {
  if (process.env.LINE_MOCK === '1') return { ok: true };
  if (process.env.LINE_MOCK === 'fail') return { ok: false, error: 'mock_fail' };
  if (!process.env.LINE_CHANNEL_ACCESS_TOKEN) {
    return { ok: false, error: 'line_not_configured' };
  }
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.LINE_CHANNEL_ACCESS_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });
    if (res.ok) return { ok: true };
    const errText = await res.text().catch(() => '');
    return { ok: false, error: `HTTP ${res.status}: ${errText.slice(0, 200)}` };
  } catch (e) {
    return { ok: false, error: `network: ${e.message}` };
  }
}

/**
 * Send a push message to a single LINE user.
 * Returns { ok: true } on 2xx, { ok: false, error } otherwise.
 * Never throws — caller decides retry behavior from the return value.
 */
export async function sendMessage(lineUserId, text) {
  return _post(PUSH_URL, { to: lineUserId, messages: [{ type: 'text', text }] });
}

/**
 * Reply to a webhook event using its one-shot replyToken.
 * Reply API doesn't consume the 1000/month push quota.
 */
export async function reply(replyToken, text) {
  return _post(REPLY_URL, { replyToken, messages: [{ type: 'text', text }] });
}

/**
 * reply() 永遠不丟例外、失敗時回 { ok:false, error }。fire-and-forget 的呼叫端
 * （如 LINE webhook）若只用 .catch 會漏掉這類失敗——本包裝檢查回傳值並在失敗時
 * console.error，讓 Railway log 看得到真正原因（HTTP 狀態 / LINE 錯誤訊息 / 未設定）。
 * 一律回傳 reply() 的 { ok, error }，呼叫端可再決定後續處理。
 */
export async function replyOrLog(replyToken, text, context = '') {
  const r = await reply(replyToken, text);
  if (!r.ok) console.error(`[line reply${context ? ` ${context}` : ''}] 送出失敗:`, r.error);
  return r;
}

/**
 * Verify the X-Line-Signature header against the raw request body.
 * LINE_MOCK=1 bypasses (tests).
 * @param {Buffer|string} rawBody - original request body bytes (e.g. req.rawBody)
 * @param {string|null|undefined} signatureHeader - base64 HMAC from X-Line-Signature header
 * @returns {boolean}
 */
export function verifySignature(rawBody, signatureHeader) {
  if (process.env.LINE_MOCK === '1') return true;
  if (!signatureHeader || !process.env.LINE_CHANNEL_SECRET) return false;
  if (typeof rawBody !== 'string' && !Buffer.isBuffer(rawBody)) return false;
  let expected;
  try {
    expected = createHmac('sha256', process.env.LINE_CHANNEL_SECRET)
      .update(rawBody)
      .digest('base64');
  } catch {
    return false;
  }
  const a = Buffer.from(expected);
  const b = Buffer.from(signatureHeader);
  if (a.length !== b.length) return false;
  try {
    return timingSafeEqual(a, b);
  } catch {
    return false;
  }
}
