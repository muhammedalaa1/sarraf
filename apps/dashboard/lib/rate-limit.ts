/** Fixed-window, in-memory rate limiter. Good enough for a single-instance sandbox dashboard. */
export class RateLimiter {
  private readonly hits = new Map<string, { count: number; resetAt: number }>();

  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
    private readonly now: () => number = Date.now,
  ) {}

  /** Returns true when the request is allowed. */
  take(key: string): boolean {
    const t = this.now();
    const entry = this.hits.get(key);
    if (!entry || entry.resetAt <= t) {
      this.hits.set(key, { count: 1, resetAt: t + this.windowMs });
      if (this.hits.size > 10_000) this.prune(t);
      return true;
    }
    entry.count++;
    return entry.count <= this.limit;
  }

  private prune(t: number) {
    for (const [k, v] of this.hits) if (v.resetAt <= t) this.hits.delete(k);
  }
}

export function clientKey(req: Request): string {
  return req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || req.headers.get("x-real-ip") || "local";
}

const g = globalThis as unknown as { __limits?: { checkout: RateLimiter; webhook: RateLimiter } };
g.__limits ??= { checkout: new RateLimiter(20, 60_000), webhook: new RateLimiter(120, 60_000) };
export const limits = g.__limits;

export function tooMany() {
  return Response.json({ error: "RATE_LIMITED" }, { status: 429, headers: { "retry-after": "60" } });
}
