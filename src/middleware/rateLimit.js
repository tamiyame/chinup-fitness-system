// 簡單的 in-memory sliding-window rate limiter。
// 設計考量：
//   - 每個 endpoint 一個 named limiter，狀態存在共用 `buckets` Map (name:ip → timestamps[])
//   - 每次請求：(1) 刪掉超過 window 的舊時戳 (2) 看是否超 max (3) 超則 429
//   - Express `app.set('trust proxy', 1)` 必須先設好，否則 Railway 後 req.ip 拿不到真實 client IP
//   - 計入所有請求（含成功與失敗），不只計失敗 — 對應 brute force 同時也擋 spam

const buckets = new Map();

export function createRateLimiter({ name, windowMs, max }) {
  return function rateLimiter(req, res, next) {
    const key = `${name}:${req.ip}`;
    const now = Date.now();
    const threshold = now - windowMs;
    const fresh = (buckets.get(key) || []).filter((t) => t > threshold);
    if (fresh.length >= max) {
      const retryAfterSeconds = Math.ceil((fresh[0] + windowMs - now) / 1000);
      res.setHeader('Retry-After', String(retryAfterSeconds));
      return res.status(429).json({ error: 'rate_limited', retry_after_seconds: retryAfterSeconds });
    }
    fresh.push(now);
    buckets.set(key, fresh);
    next();
  };
}

// 測試專用：清掉所有 bucket 狀態。生產環境不會呼叫。
export function _resetRateLimiterState() {
  buckets.clear();
}
