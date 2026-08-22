// Per-key rate limiting (per staff UPN on authenticated routes, per client IP
// on the public submit route). In-memory fixed-window counter: zero extra
// infrastructure, effective for this small, typically single-instance
// Functions app. If ever scaled to multiple instances, swap for a shared
// store (Azure Cache for Redis, or a Table Storage row with a TTL) so the
// limit is enforced across instances. Deliberately FAILS OPEN — a limiter
// hiccup must never take the app down.

const WINDOW_MS = 60 * 1000; // 1-minute window
const MAX_PER_WINDOW = parseInt(process.env.RATE_LIMIT_PER_MIN, 10) > 0
  ? parseInt(process.env.RATE_LIMIT_PER_MIN, 10)
  : 120;

const hits = new Map(); // key -> { count, windowStart }

function checkRateLimit(key, max = MAX_PER_WINDOW, windowMs = WINDOW_MS) {
  try {
    const now = Date.now();
    let entry = hits.get(key);
    if (!entry || now - entry.windowStart >= windowMs) {
      entry = { count: 0, windowStart: now };
      hits.set(key, entry);
    }
    entry.count += 1;

    if (hits.size > 5000) {
      for (const [k, v] of hits) {
        if (now - v.windowStart >= windowMs) hits.delete(k);
      }
    }

    return {
      allowed: entry.count <= max,
      retryAfterSec: Math.max(1, Math.ceil((entry.windowStart + windowMs - now) / 1000)),
    };
  } catch (_) {
    return { allowed: true, retryAfterSec: 0 }; // fail open
  }
}

module.exports = { checkRateLimit };
