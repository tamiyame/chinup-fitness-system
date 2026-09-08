// 本月 LINE 推播額度：LINE 官方 quota／consumption 兩支查詢端點＋重置時間推算。
// LINE 月度統計以 UTC+9 計、每月 1 日 00:00 重置 ＝ 台灣時間「當月最後一天 23:00」。
import { nowLocal } from '../db/connection.js';
import { getQuota, getQuotaConsumption } from './lineClient.js';

const pad = (n) => String(n).padStart(2, '0');

// 該年月（m0 為 0-based）的重置時刻：最後一天 23:00:00（台灣本地字串）
function resetOfMonth(y, m0) {
  const lastDay = new Date(Date.UTC(y, m0 + 1, 0)).getUTCDate();
  return `${y}-${pad(m0 + 1)}-${pad(lastDay)}T23:00:00`;
}

/** 下一次額度重置的台灣本地時間（YYYY-MM-DDTHH:MM:SS）。now 已到達當月重置時刻則回下個月。 */
export function nextQuotaResetLocal(nowLocalStr) {
  const m = /^(\d{4})-(\d{2})/.exec(nowLocalStr);
  const y = Number(m[1]);
  const m0 = Number(m[2]) - 1;
  const thisMonth = resetOfMonth(y, m0);
  if (nowLocalStr < thisMonth) return thisMonth;  // 同格式字串比較即時間比較
  const next = new Date(Date.UTC(y, m0 + 1, 1));
  return resetOfMonth(next.getUTCFullYear(), next.getUTCMonth());
}

/**
 * 組裝後台額度卡需要的狀態。任一端點失敗 → error 帶原因、數字欄位 null；
 * 未設定 token → configured=false（error 仍 null）。不做快取（後台才呼叫、LINE 限制 2,000 次/秒）。
 */
export async function getLineQuotaStatus() {
  const fetchedAt = nowLocal();
  const base = {
    configured: true, limitType: null, limit: null, used: null, remaining: null, pct: null,
    resetAt: nextQuotaResetLocal(fetchedAt), fetchedAt, error: null,
  };
  const [q, c] = await Promise.all([getQuota(), getQuotaConsumption()]);
  const failed = [q, c].find((r) => !r.ok);
  if (failed) {
    if (failed.error === 'line_not_configured') return { ...base, configured: false };
    return { ...base, error: failed.error };
  }
  const usedRaw = Number(c.data?.totalUsage ?? 0);
  const used = Number.isFinite(usedRaw) ? usedRaw : 0;  // LINE 回傳非數值時（如壞資料）不讓 NaN 穿透 remaining/pct
  if (q.data?.type !== 'limited' || typeof q.data.value !== 'number') {
    return { ...base, limitType: 'none', used };
  }
  const limit = q.data.value;
  const remaining = Math.max(limit - used, 0);
  const pct = limit > 0 ? Math.round((remaining / limit) * 100) : 0;
  return { ...base, limitType: 'limited', limit, used, remaining, pct };
}
