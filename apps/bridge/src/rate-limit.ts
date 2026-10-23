// @junior/bridge/rate-limit — sliding-window limiter (plan §4.2: a 30/min burst cap on
// POST /mcp tool calls as a quota-burn brake; mounted when the MCP server lands in M4).
export interface RateLimiter {
  allow(key: string): boolean;
}

export function createRateLimiter(opts: {
  windowMs: number;
  max: number;
  now?: () => number;
}): RateLimiter {
  const now = opts.now ?? Date.now;
  const hits = new Map<string, number[]>();
  return {
    allow(key: string): boolean {
      const t = now();
      // Blocked hits still count (pushed), so a hammer can't reset the window by retrying.
      const recent = (hits.get(key) ?? []).filter((ts) => t - ts < opts.windowMs);
      recent.push(t);
      hits.set(key, recent);
      return recent.length <= opts.max;
    },
  };
}
