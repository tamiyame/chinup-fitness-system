// Google OAuth2 token 取得（零 npm 依賴，native fetch + node:crypto）。
// 兩條互相獨立的路徑：
//   Service Account JWT（Calendar）— GCAL_SERVICE_ACCOUNT_JSON（raw JSON 或 base64）
//   OAuth refresh token（Gmail）   — GMAIL_REFRESH_TOKEN + GOOGLE_CLIENT_ID/SECRET
// 比照 lineClient.js：never-throws、回傳 { ok, ... }；GCAL_MOCK / GMAIL_MOCK 短路。
import { createSign } from 'node:crypto';

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const b64url = (s) => Buffer.from(s).toString('base64url');

export function _parseServiceAccountJson(raw) {
  if (!raw || typeof raw !== 'string') return null;
  const text = raw.trim().startsWith('{') ? raw : Buffer.from(raw.trim(), 'base64').toString('utf8');
  try {
    const obj = JSON.parse(text);
    return obj && obj.client_email ? obj : null;
  } catch { return null; }
}

export function _buildJwt(sa, nowSec) {
  const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claims = b64url(JSON.stringify({
    iss: sa.client_email,
    scope: 'https://www.googleapis.com/auth/calendar',
    aud: TOKEN_URL,
    iat: nowSec,
    exp: nowSec + 3600,
  }));
  const signer = createSign('RSA-SHA256');
  signer.update(`${header}.${claims}`);
  const sig = signer.sign(sa.private_key).toString('base64url');
  return `${header}.${claims}.${sig}`;
}

async function fetchToken(params) {
  try {
    const res = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(params),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.access_token) {
      return { ok: false, error: `token HTTP ${res.status}: ${JSON.stringify(data).slice(0, 200)}` };
    }
    return { ok: true, token: data.access_token, expiresIn: data.expires_in || 3600 };
  } catch (e) {
    return { ok: false, error: `network: ${e.message}` };
  }
}

// 記憶體快取（單副本假設，到期前 5 分鐘換新）
let _saCache = null;    // { token, expMs }
let _gmailCache = null; // { token, expMs }

export async function getCalendarToken() {
  // mock 判斷比照 lineClient：'1' 成功、'fail' 失敗（精確比對）
  if (process.env.GCAL_MOCK === '1') return { ok: true, token: 'mock-gcal-token' };
  if (process.env.GCAL_MOCK === 'fail') return { ok: false, error: 'mock_fail' };
  const sa = _parseServiceAccountJson(process.env.GCAL_SERVICE_ACCOUNT_JSON);
  if (!sa || !sa.private_key) return { ok: false, error: 'gcal_not_configured' };
  if (_saCache && Date.now() < _saCache.expMs - 5 * 60_000) return { ok: true, token: _saCache.token };
  // 金鑰格式錯誤時 createSign 會 throw → 包住維持 never-throws 契約
  let jwt;
  try {
    jwt = _buildJwt(sa, Math.floor(Date.now() / 1000));
  } catch (e) {
    return { ok: false, error: `jwt_signing: ${e.message}` };
  }
  const r = await fetchToken({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: jwt });
  if (r.ok) _saCache = { token: r.token, expMs: Date.now() + r.expiresIn * 1000 };
  return r;
}

export async function getGmailToken() {
  if (process.env.GMAIL_MOCK === '1') return { ok: true, token: 'mock-gmail-token' };
  if (process.env.GMAIL_MOCK === 'fail') return { ok: false, error: 'mock_fail' };
  const { GMAIL_REFRESH_TOKEN, GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET } = process.env;
  if (!GMAIL_REFRESH_TOKEN || !GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET) {
    return { ok: false, error: 'gmail_not_configured' };
  }
  if (_gmailCache && Date.now() < _gmailCache.expMs - 5 * 60_000) return { ok: true, token: _gmailCache.token };
  const r = await fetchToken({
    grant_type: 'refresh_token',
    refresh_token: GMAIL_REFRESH_TOKEN,
    client_id: GOOGLE_CLIENT_ID,
    client_secret: GOOGLE_CLIENT_SECRET,
  });
  if (r.ok) _gmailCache = { token: r.token, expMs: Date.now() + r.expiresIn * 1000 };
  return r;
}

export function isGmailConfigured() {
  return !!process.env.GMAIL_MOCK ||
    !!(process.env.GMAIL_REFRESH_TOKEN && process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET);
}
