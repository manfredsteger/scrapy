/**
 * Tests for the lock-expiry banner timer in Home.tsx.
 *
 * The relevant useEffect (near line 1309 of Home.tsx) schedules a one-shot
 * setTimeout that fires exactly when the other tab's lock TTL elapses, forcing
 * a re-render so `isLockedByOtherTab` re-evaluates and the banner disappears.
 *
 * Key guarantees we verify here:
 *  1. Timer fires at the correct time when a lock is first observed.
 *  2. When `expiresAt` is renewed (pushed forward) the old timer is cancelled
 *     and a new one is scheduled at the correct new expiry — the tick does NOT
 *     increment at the old (stale) deadline.
 *  3. Multiple consecutive renewals never stack timers; only one fires per
 *     expiry, and it fires at the right time.
 *  4. Banner stays visible (tick unchanged) throughout the extended lock period.
 *  5. Already-expired locks are ignored (no timer, no spurious tick).
 *  6. Own-tab locks are ignored (no timer scheduled).
 */
import { useState, useEffect } from "react";
import { renderHook, act } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { isLockedByOtherTab } from "@/utils/lock-utils";

// ---------------------------------------------------------------------------
// Minimal hook that mirrors the exact useEffect in Home.tsx (lines 1309-1319)
//
// In the real component `activeProject` is the dependency — a new object
// reference is produced by React Query on every refetch.  We model that here
// by accepting a plain `lock` object; callers pass a fresh object each time
// they want to simulate a refetch/renewal.
// ---------------------------------------------------------------------------
function useLockExpiryTimer(
  lock: { owner: string; expiresAt: number } | null | undefined,
  currentOwner: string,
): number {
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (!lock || lock.owner === currentOwner) return;
    const msUntilExpiry = lock.expiresAt - Date.now();
    if (msUntilExpiry <= 0) return; // already expired — no timer needed
    const timer = setTimeout(() => {
      setTick((n) => n + 1);
    }, msUntilExpiry);
    return () => clearTimeout(timer);
  }, [lock, currentOwner]); // lock is a new object ref on every renewal
  return tick;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
const MY_TAB = "my-tab-id";
const OTHER_TAB = "other-tab-id";

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
describe("lock-expiry banner timer (useLockExpiryTimer)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.runOnlyPendingTimers();
    vi.useRealTimers();
  });

  // ── basic scheduling ──────────────────────────────────────────────────────

  it("fires the tick exactly when the lock expires", () => {
    const lock = { owner: OTHER_TAB, expiresAt: Date.now() + 5_000 };
    const { result } = renderHook(() => useLockExpiryTimer(lock, MY_TAB));

    expect(result.current).toBe(0); // no tick yet

    act(() => {
      vi.advanceTimersByTime(4_999);
    });
    expect(result.current).toBe(0); // still before expiry

    act(() => {
      vi.advanceTimersByTime(1); // crosses the 5 000 ms boundary
    });
    expect(result.current).toBe(1); // timer fired exactly once
  });

  it("does not schedule a timer for an already-expired lock", () => {
    const lock = { owner: OTHER_TAB, expiresAt: Date.now() - 1 };
    const { result } = renderHook(() => useLockExpiryTimer(lock, MY_TAB));

    act(() => {
      vi.advanceTimersByTime(10_000);
    });
    expect(result.current).toBe(0); // tick never increments
  });

  it("does not schedule a timer when the lock belongs to the current tab", () => {
    const lock = { owner: MY_TAB, expiresAt: Date.now() + 5_000 };
    const { result } = renderHook(() => useLockExpiryTimer(lock, MY_TAB));

    act(() => {
      vi.advanceTimersByTime(10_000);
    });
    expect(result.current).toBe(0);
  });

  it("does not schedule a timer when there is no lock", () => {
    const { result } = renderHook(() => useLockExpiryTimer(null, MY_TAB));

    act(() => {
      vi.advanceTimersByTime(10_000);
    });
    expect(result.current).toBe(0);
  });

  // ── timer reset on renewal ────────────────────────────────────────────────

  it("cancels the old timer and reschedules when expiresAt is renewed mid-session", () => {
    const initialLock = { owner: OTHER_TAB, expiresAt: Date.now() + 5_000 };
    let currentLock: typeof initialLock = initialLock;

    const { result, rerender } = renderHook(() =>
      useLockExpiryTimer(currentLock, MY_TAB),
    );

    // Advance 3 s — half-way through the original TTL.
    act(() => {
      vi.advanceTimersByTime(3_000);
    });
    expect(result.current).toBe(0); // not expired yet

    // Simulate a lock renewal: other tab pushes expiresAt forward by 5 s from now.
    // React Query would return a new object reference here, which causes the
    // useEffect to re-run (cleanup old timer → schedule new one).
    currentLock = { owner: OTHER_TAB, expiresAt: Date.now() + 5_000 };
    rerender();

    // Advance past the ORIGINAL expiry (2 more seconds = 5 s total from start).
    // The old timer was cancelled; tick must NOT increment here.
    act(() => {
      vi.advanceTimersByTime(2_000);
    });
    expect(result.current).toBe(0); // banner still visible — lock is still live

    // Advance to the NEW expiry (3 more seconds = 5 s from the renewal point).
    act(() => {
      vi.advanceTimersByTime(3_000);
    });
    expect(result.current).toBe(1); // fires exactly once at the renewed deadline
  });

  it("banner stays visible throughout the extended lock period after renewal", () => {
    // Mirrors the "banner stays visible during the extended lock period" requirement.
    const initialExpiry = Date.now() + 4_000;
    const initialLock = { owner: OTHER_TAB, expiresAt: initialExpiry };
    let currentLock: typeof initialLock = initialLock;

    const { result, rerender } = renderHook(() =>
      useLockExpiryTimer(currentLock, MY_TAB),
    );

    // At t=2s, the owning tab renews: new expiry = now+6s (i.e. t=8s total).
    act(() => {
      vi.advanceTimersByTime(2_000);
    });
    currentLock = { owner: OTHER_TAB, expiresAt: Date.now() + 6_000 };
    rerender();

    // Advance to the original expiry (t=4s from start, 2s into the renewal).
    act(() => {
      vi.advanceTimersByTime(2_000);
    });
    expect(result.current).toBe(0); // still visible — old timer was cancelled

    // Advance to t=7s (1s before new expiry).
    act(() => {
      vi.advanceTimersByTime(3_000);
    });
    expect(result.current).toBe(0); // still visible

    // Advance to new expiry (t=8s from start, 6s from renewal).
    act(() => {
      vi.advanceTimersByTime(1_000);
    });
    expect(result.current).toBe(1); // banner hides now
  });

  it("multiple consecutive renewals never stack timers — exactly one tick fires", () => {
    const initialLock = { owner: OTHER_TAB, expiresAt: Date.now() + 5_000 };
    let currentLock: typeof initialLock = initialLock;

    const { result, rerender } = renderHook(() =>
      useLockExpiryTimer(currentLock, MY_TAB),
    );

    // Three renewals in quick succession (simulates burst of rapid refetches).
    for (let i = 1; i <= 3; i++) {
      currentLock = { owner: OTHER_TAB, expiresAt: Date.now() + 5_000 };
      rerender();
    }

    // Advance past the final expiry.
    act(() => {
      vi.advanceTimersByTime(6_000);
    });

    // Even with 3 renewals, the tick fires exactly once.
    expect(result.current).toBe(1);
  });

  // ── integration with isLockedByOtherTab ───────────────────────────────────

  it("isLockedByOtherTab returns false after the timer tick increments (lock expired)", () => {
    const expiresAt = Date.now() + 3_000;
    const lock = { owner: OTHER_TAB, expiresAt };
    const project = { scrapeLock: lock };

    const { result } = renderHook(() => useLockExpiryTimer(lock, MY_TAB));

    // Before expiry: banner should show.
    expect(isLockedByOtherTab(project, MY_TAB)).toBe(true);
    expect(result.current).toBe(0);

    // Advance past expiry.
    act(() => {
      vi.advanceTimersByTime(3_001);
    });

    // Tick incremented — component would re-render and isLockedByOtherTab
    // would now return false (Date.now() > expiresAt).
    expect(result.current).toBe(1);
    expect(isLockedByOtherTab(project, MY_TAB)).toBe(false);
  });
});
