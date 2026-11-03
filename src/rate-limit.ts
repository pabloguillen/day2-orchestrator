/**
 * Fixed-window rate limits, per process (one API server in production).
 *
 * Each bucket expires on its own when its window is over. The map is
 * bounded: past `maxBuckets`, expired buckets go first, then the oldest
 * ones still under their limit. A bucket that is over its limit is never
 * dropped, so flooding the map with junk can't reset anyone's limit.
 */

type Bucket = { start: number; n: number; limit: number; windowMs: number };

export type Limiter = {
  /** Counts one request in `bucket`; false when that's over `limit` for the window. */
  allow(bucket: string, limit: number, now: number, windowMs?: number): boolean;
  /** Whether a request would be allowed, without counting it. */
  wouldAllow(bucket: string, limit: number, now: number): boolean;
  size(): number;
  reset(): void;
};

export function createLimiter(maxBuckets = 50_000): Limiter {
  // Insertion order = window start order (a bucket is re-inserted when its window restarts).
  const buckets = new Map<string, Bucket>();
  const expired = (b: Bucket, now: number) => now - b.start >= b.windowMs;
  const evict = (now: number) => {
    for (const [k, b] of buckets) {
      if (buckets.size <= maxBuckets) return;
      if (expired(b, now)) buckets.delete(k);
      else break; // the rest started later
    }
    if (buckets.size <= maxBuckets) return;
    for (const [k, b] of buckets) {
      if (buckets.size <= maxBuckets) return;
      if (b.n <= b.limit) buckets.delete(k);
    }
  };
  return {
    allow(bucket, limit, now, windowMs = 60_000) {
      const b = buckets.get(bucket);
      if (!b || expired(b, now)) {
        buckets.delete(bucket);
        buckets.set(bucket, { start: now, n: 1, limit, windowMs });
        if (buckets.size > maxBuckets) evict(now);
        return 1 <= limit;
      }
      b.n += 1;
      b.limit = limit;
      return b.n <= limit;
    },
    wouldAllow(bucket, limit, now) {
      const b = buckets.get(bucket);
      return !b || expired(b, now) || b.n < limit;
    },
    size: () => buckets.size,
    reset: () => buckets.clear(),
  };
}

/**
 * The caller's address for rate limits: Cloudflare's `cf-connecting-ip`
 * when present (the tunnel and the inbox Worker set it), else the first
 * X-Forwarded-For entry when DAY2_TRUST_PROXY=on (Caddy in production),
 * else null.
 */
export function requestIp(req: Request): string | null {
  const cf = req.headers.get("cf-connecting-ip")?.trim();
  if (cf) return cf.slice(0, 64);
  if (process.env.DAY2_TRUST_PROXY !== "on") return null;
  return req.headers.get("x-forwarded-for")?.split(",")[0]?.trim().slice(0, 64) || null;
}
