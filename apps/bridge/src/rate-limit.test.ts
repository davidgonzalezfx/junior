import { describe, expect, it } from "vitest";
import { createRateLimiter } from "./rate-limit.js";

describe("createRateLimiter (plan §4.2 — /mcp quota-burn brake, mounted in M4)", () => {
  it("allows up to max requests, then blocks within the window", () => {
    const t = 0;
    const rl = createRateLimiter({ windowMs: 60_000, max: 3, now: () => t });
    expect(rl.allow("k")).toBe(true);
    expect(rl.allow("k")).toBe(true);
    expect(rl.allow("k")).toBe(true);
    expect(rl.allow("k")).toBe(false);
    expect(rl.allow("other-key")).toBe(true); // keys are independent
  });

  it("lets entries slide out of the window", () => {
    let t = 0;
    const rl = createRateLimiter({ windowMs: 60_000, max: 2, now: () => t });
    rl.allow("k");
    rl.allow("k");
    expect(rl.allow("k")).toBe(false);
    t = 60_001; // both earlier hits just slid out
    expect(rl.allow("k")).toBe(true);
  });

  it("blocked retries do not reset the window", () => {
    let t = 0;
    const rl = createRateLimiter({ windowMs: 60_000, max: 1, now: () => t });
    expect(rl.allow("k")).toBe(true);
    for (t = 1; t < 59_000; t += 10_000) {
      expect(rl.allow("k")).toBe(false); // retry spam never gets the first hit out of view
    }
  });
});
