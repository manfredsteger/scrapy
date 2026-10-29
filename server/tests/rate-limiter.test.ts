// Unit tests for RateLimiter request spacing.
//
// Regression: callers started in parallel (Promise.all over a scrape batch)
// all read the same lastRequestTime and fired at once, so the configured
// delay never applied within a batch. Some servers answer such a burst by
// silently dropping the client IP for ~30-60 s, which showed up as every
// page failing with "This operation was aborted".
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { RateLimiter } from "../utils/rate-limiter";

const settings = (overrides: Partial<{ enabled: boolean; baseDelayMs: number }> = {}) => ({
  enabled: true,
  baseDelayMs: 500,
  maxDelayMs: 30000,
  backoffMultiplier: 2,
  ...overrides,
});

// Realistic clock: a fresh limiter (lastRequestTime = 0) must not delay the
// very first request.
const T0 = 1_000_000;
const since = (xs: number[]) => xs.map((t) => t - T0);

describe("RateLimiter.waitBeforeRequest", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(T0);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("spaces parallel callers by the configured delay", async () => {
    const limiter = new RateLimiter(settings());
    const startedAt: number[] = [];

    const all = Promise.all(
      Array.from({ length: 4 }, () =>
        limiter.waitBeforeRequest().then(() => startedAt.push(Date.now())),
      ),
    );
    await vi.runAllTimersAsync();
    await all;

    expect(since(startedAt)).toEqual([0, 500, 1000, 1500]);
  });

  it("does not wait when the last request is older than the delay", async () => {
    const limiter = new RateLimiter(settings());
    await limiter.waitBeforeRequest();
    vi.setSystemTime(T0 + 5000);

    const p = limiter.waitBeforeRequest();
    await vi.runAllTimersAsync();
    await p;

    expect(Date.now()).toBe(T0 + 5000);
  });

  it("lets everything through immediately when disabled", async () => {
    const limiter = new RateLimiter(settings({ enabled: false }));
    const startedAt: number[] = [];

    await Promise.all(
      Array.from({ length: 3 }, () =>
        limiter.waitBeforeRequest().then(() => startedAt.push(Date.now())),
      ),
    );

    expect(since(startedAt)).toEqual([0, 0, 0]);
  });

  it("uses the increased delay after a rate limit", async () => {
    const limiter = new RateLimiter(settings());
    limiter.onRateLimit(); // 500 -> 1000
    const startedAt: number[] = [];

    const all = Promise.all(
      Array.from({ length: 3 }, () =>
        limiter.waitBeforeRequest().then(() => startedAt.push(Date.now())),
      ),
    );
    await vi.runAllTimersAsync();
    await all;

    expect(since(startedAt)).toEqual([0, 1000, 2000]);
  });
});
