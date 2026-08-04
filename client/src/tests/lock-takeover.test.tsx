/**
 * Tests for the lock-takeover feature:
 *  1. isLockedByOtherTab utility – pure logic, no DOM needed
 *  2. LockTakeoverBanner component – rendering & click behaviour
 *  3. Conditional render logic – isProcessing && isLockedByOtherTab
 *  4. Integration (wrapper): takeLock end-to-end – banner hides on success, stays on failure
 *  5. Integration (Home): real Home component + real takeLock callback, fetch mocked at network layer
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { useState } from "react";
import "@testing-library/jest-dom";
import { QueryClientProvider } from "@tanstack/react-query";
import { Router } from "wouter";

import { isLockedByOtherTab } from "@/utils/lock-utils";
import LockTakeoverBanner from "@/components/LockTakeoverBanner";
import { queryClient } from "@/lib/queryClient";
import { TooltipProvider } from "@/components/ui/tooltip";
import Home from "@/pages/Home";

// ---------------------------------------------------------------------------
// 1. isLockedByOtherTab – pure utility
// ---------------------------------------------------------------------------
describe("isLockedByOtherTab", () => {
  const MY_TAB = "my-tab-id";
  const OTHER_TAB = "other-tab-id";

  it("returns false when project is undefined", () => {
    expect(isLockedByOtherTab(undefined, MY_TAB)).toBe(false);
  });

  it("returns false when scrapeLock is null", () => {
    expect(isLockedByOtherTab({ scrapeLock: null }, MY_TAB)).toBe(false);
  });

  it("returns false when lock is held by the current tab", () => {
    const lock = { owner: MY_TAB, expiresAt: Date.now() + 60_000 };
    expect(isLockedByOtherTab({ scrapeLock: lock }, MY_TAB)).toBe(false);
  });

  it("returns false when lock belongs to another tab but has already expired", () => {
    const lock = { owner: OTHER_TAB, expiresAt: Date.now() - 1 };
    expect(isLockedByOtherTab({ scrapeLock: lock }, MY_TAB)).toBe(false);
  });

  it("returns true when lock is held by a different tab and is still valid", () => {
    const lock = { owner: OTHER_TAB, expiresAt: Date.now() + 60_000 };
    expect(isLockedByOtherTab({ scrapeLock: lock }, MY_TAB)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 2. LockTakeoverBanner – component
// ---------------------------------------------------------------------------
describe("LockTakeoverBanner", () => {
  const defaultProps = {
    isTakingLock: false,
    description: "Wird in einem anderen Tab verarbeitet.",
    buttonLabel: "Übernehmen",
    onTakeLock: vi.fn(),
  };

  beforeEach(() => {
    defaultProps.onTakeLock = vi.fn();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("renders the description text", () => {
    render(<LockTakeoverBanner {...defaultProps} />);
    expect(
      screen.getByText("Wird in einem anderen Tab verarbeitet.")
    ).toBeInTheDocument();
  });

  it("renders the take-lock button with the correct label", () => {
    render(<LockTakeoverBanner {...defaultProps} />);
    const btn = screen.getByTestId("take-lock-button");
    expect(btn).toBeInTheDocument();
    expect(btn).toHaveTextContent("Übernehmen");
  });

  it("button is enabled when isTakingLock is false", () => {
    render(<LockTakeoverBanner {...defaultProps} isTakingLock={false} />);
    expect(screen.getByTestId("take-lock-button")).not.toBeDisabled();
  });

  it("button is disabled while the takeover request is in flight", () => {
    render(<LockTakeoverBanner {...defaultProps} isTakingLock={true} />);
    expect(screen.getByTestId("take-lock-button")).toBeDisabled();
  });

  it("calls onTakeLock when the button is clicked", () => {
    render(<LockTakeoverBanner {...defaultProps} />);
    fireEvent.click(screen.getByTestId("take-lock-button"));
    expect(defaultProps.onTakeLock).toHaveBeenCalledOnce();
  });

  it("does not call onTakeLock when the button is disabled", () => {
    render(<LockTakeoverBanner {...defaultProps} isTakingLock={true} />);
    fireEvent.click(screen.getByTestId("take-lock-button"));
    expect(defaultProps.onTakeLock).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// 3. Conditional render logic – isProcessing && isLockedByOtherTab
// ---------------------------------------------------------------------------
describe("banner visibility conditions", () => {
  const MY_TAB = "my-tab";
  const OTHER_TAB = "other-tab";

  const activeLock = { owner: OTHER_TAB, expiresAt: Date.now() + 60_000 };
  const expiredLock = { owner: OTHER_TAB, expiresAt: Date.now() - 1 };
  const ownLock = { owner: MY_TAB, expiresAt: Date.now() + 60_000 };

  const SCRAPING_STATUSES = ["scraping", "content_scraping", "crawling"] as const;
  const IDLE_STATUSES = ["idle", "paused", "done"] as const;

  // Mirrors the derived boolean in Home.tsx:
  //   const isProcessing = status === 'scraping' || status === 'content_scraping' || status === 'crawling'
  // Banner shows when: isProcessing && isLockedByOtherTab(project)
  function shouldShowBanner(
    status: string,
    lock: { owner: string; expiresAt: number } | null,
    currentTab: string,
  ): boolean {
    const isProcessing =
      status === "scraping" ||
      status === "content_scraping" ||
      status === "crawling";
    return isProcessing && isLockedByOtherTab({ scrapeLock: lock }, currentTab);
  }

  it("shows banner for all active scraping statuses when locked by another tab", () => {
    for (const status of SCRAPING_STATUSES) {
      expect(shouldShowBanner(status, activeLock, MY_TAB)).toBe(true);
    }
  });

  it("hides banner for non-processing statuses even with a foreign lock", () => {
    for (const status of IDLE_STATUSES) {
      expect(shouldShowBanner(status, activeLock, MY_TAB)).toBe(false);
    }
  });

  it("hides banner when processing but lock belongs to current tab", () => {
    for (const status of SCRAPING_STATUSES) {
      expect(shouldShowBanner(status, ownLock, MY_TAB)).toBe(false);
    }
  });

  it("hides banner when processing but lock has expired", () => {
    for (const status of SCRAPING_STATUSES) {
      expect(shouldShowBanner(status, expiredLock, MY_TAB)).toBe(false);
    }
  });

  it("hides banner when processing with no lock at all", () => {
    for (const status of SCRAPING_STATUSES) {
      expect(shouldShowBanner(status, null, MY_TAB)).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// 4. Integration (wrapper): takeLock end-to-end – banner hides on success, stays on failure
// ---------------------------------------------------------------------------
describe("takeLock integration – banner visibility after API response", () => {
  const MY_TAB = "my-tab-id";
  const OTHER_TAB = "other-tab-id";

  /**
   * Minimal wrapper that mirrors the relevant slice of Home.tsx:
   *  - isTakingLock state
   *  - takeLock handler: calls the injected API fn, then updates local lock state
   *    (simulating the refetchProjects() that follows a successful POST)
   *  - Conditionally renders LockTakeoverBanner based on isLockedByOtherTab
   */
  function TakeoverWrapper({ onApiCall }: { onApiCall: () => Promise<void> }) {
    const [isTakingLock, setIsTakingLock] = useState(false);
    const [lock, setLock] = useState<{ owner: string; expiresAt: number } | null>({
      owner: OTHER_TAB,
      expiresAt: Date.now() + 60_000,
    });

    const handleTakeLock = async () => {
      setIsTakingLock(true);
      try {
        await onApiCall();
        // Successful POST → refetch returns project with current tab as lock owner
        setLock({ owner: MY_TAB, expiresAt: Date.now() + 60_000 });
      } catch {
        // API failure: leave lock unchanged → banner stays visible
      } finally {
        setIsTakingLock(false);
      }
    };

    if (!isLockedByOtherTab({ scrapeLock: lock }, MY_TAB)) return null;

    return (
      <LockTakeoverBanner
        isTakingLock={isTakingLock}
        description="Wird in einem anderen Tab verarbeitet."
        buttonLabel="Übernehmen"
        onTakeLock={handleTakeLock}
      />
    );
  }

  it("banner disappears after a successful lock takeover", async () => {
    const mockApi = vi.fn().mockResolvedValue(undefined);
    render(<TakeoverWrapper onApiCall={mockApi} />);

    // Banner is visible before the takeover
    expect(screen.getByTestId("take-lock-button")).toBeInTheDocument();

    fireEvent.click(screen.getByTestId("take-lock-button"));

    // After the mock resolves and the lock owner flips to MY_TAB the banner
    // must unmount – isLockedByOtherTab now returns false.
    await waitFor(() => {
      expect(screen.queryByTestId("take-lock-button")).not.toBeInTheDocument();
    });
  });

  it("banner stays visible and button re-enables after a failed takeover", async () => {
    const mockApi = vi.fn().mockRejectedValue(new Error("Network error"));
    render(<TakeoverWrapper onApiCall={mockApi} />);

    expect(screen.getByTestId("take-lock-button")).toBeInTheDocument();

    fireEvent.click(screen.getByTestId("take-lock-button"));

    // While the request is in-flight the button must be disabled
    expect(screen.getByTestId("take-lock-button")).toBeDisabled();

    // After the rejection the button re-enables and the banner is still mounted
    await waitFor(() => {
      expect(screen.getByTestId("take-lock-button")).not.toBeDisabled();
    });
    expect(screen.getByTestId("take-lock-button")).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// 5. Integration (Home): real Home component + real takeLock callback
//
// This suite renders the actual Home page and exercises the real takeLock
// callback defined there. All I/O is controlled at the network layer via
// vi.stubGlobal("fetch", ...) so there is no test-only reimplementation of
// Home's lock logic.
//
// Design notes:
//  • The real `queryClient` from @/lib/queryClient is passed to
//    QueryClientProvider so that Home's internal queryClient.invalidateQueries
//    calls work against the same instance the hooks observe.
//  • GET /api/projects/1 (the detail endpoint) is stubbed to return 404 so
//    that `activeProjectDetail` stays undefined.  Home's `activeProject`
//    memo then falls back to `projects.find(…)` which is controlled by the
//    list endpoint mock.  This is the key seam: after the POST returns 200
//    and refetchProjects() re-fetches the list, the list carries
//    scrapeLock: null → isLockedByOtherTab returns false → banner unmounts.
// ---------------------------------------------------------------------------
describe("Home integration – real takeLock hides / keeps banner", () => {
  const OTHER_TAB = "other-tab-id";

  // Minimal project shape that satisfies Home's render requirements.
  // status: 'scraping' → isProcessing = true.
  // scrapeLock owned by OTHER_TAB → isLockedByOtherTab = true → banner shows.
  // queue: [] → processStep immediately transitions to 'idle' via a PUT.
  const lockedProject = {
    id: 1,
    domain: "example.com",
    displayName: "example.com",
    status: "scraping",
    queue: [] as string[],
    processed: [] as string[],
    results: [],
    errors: [],
    stats: {
      totalSitemaps: 0,
      processedSitemaps: 0,
      totalUrls: 0,
      totalImages: 0,
      totalVideos: 0,
      startTime: Date.now(),
    },
    scrapeLock: { owner: OTHER_TAB, expiresAt: Date.now() + 120_000 },
    version: 1,
    projectSettings: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  // Same project but with the lock cleared – returned after a successful POST.
  const unlockedProject = { ...lockedProject, scrapeLock: null };

  /** Build a Response object the way fetch returns one. */
  function mockResponse(body: unknown, status = 200) {
    return new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json" },
    });
  }

  /** Minimal provider wrapper identical to App.tsx. */
  function renderHome() {
    return render(
      <QueryClientProvider client={queryClient}>
        <TooltipProvider>
          <Router>
            <Home />
          </Router>
        </TooltipProvider>
      </QueryClientProvider>,
    );
  }

  beforeEach(() => {
    // Wipe any cache from previous tests.
    queryClient.clear();

    // Seed list + single-pages so Home's initial render doesn't hit the network.
    // staleTime: 1000 (Home's own override) → data is fresh at mount, no
    // refetch-on-mount is triggered.
    queryClient.setQueryData(["/api/projects"], [lockedProject]);
    queryClient.setQueryData(["/api/single-pages"], []);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    queryClient.clear();
  });

  it("banner disappears after the real takeLock callback succeeds", async () => {
    // Track whether the POST has fired so we can return different list data
    // on the subsequent refetchProjects() GET.
    let postFired = false;

    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation(async (url: string, opts?: RequestInit) => {
        const method = (opts?.method ?? "GET").toUpperCase();

        // POST take-lock → success; remember it fired.
        if (typeof url === "string" && url.includes("/take-lock") && method === "POST") {
          postFired = true;
          return mockResponse(unlockedProject, 200);
        }

        // List: return locked until POST fires, then unlocked.
        if (url === "/api/projects" && method === "GET") {
          return mockResponse(postFired ? [unlockedProject] : [lockedProject]);
        }

        // Detail endpoint → 404 keeps activeProjectDetail undefined so
        // activeProject falls through to the list (the seam we test).
        if (typeof url === "string" && /\/api\/projects\/\d+$/.test(url) && method === "GET") {
          return mockResponse({ message: "Not found" }, 404);
        }

        if (url === "/api/single-pages") return mockResponse([]);

        // Any other requests (PUT from processStep, etc.) → silent 200.
        return mockResponse({});
      }),
    );

    renderHome();

    // Wait for Home to leave the loading state and show the project card.
    const card = await screen.findByTestId("project-card-1", {}, { timeout: 5000 });
    fireEvent.click(card);

    // Banner should now be visible in the detail view.
    const btn = await screen.findByTestId("take-lock-button", {}, { timeout: 5000 });
    expect(btn).toBeInTheDocument();

    // Click the real "Übernehmen" button – this fires Home's own takeLock.
    fireEvent.click(btn);

    // After the POST resolves and refetchProjects() brings back the unlocked
    // list, isLockedByOtherTab(activeProject) → false → banner unmounts.
    await waitFor(
      () => expect(screen.queryByTestId("take-lock-button")).not.toBeInTheDocument(),
      { timeout: 5000 },
    );
  });

  it("banner stays visible and button re-enables when the real takeLock callback fails", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation(async (url: string, opts?: RequestInit) => {
        const method = (opts?.method ?? "GET").toUpperCase();

        // POST take-lock → 500; apiRequest throws → takeLock catch branch runs.
        if (typeof url === "string" && url.includes("/take-lock") && method === "POST") {
          return mockResponse({ message: "Server error" }, 500);
        }

        // List always returns the locked project (no change).
        if (url === "/api/projects" && method === "GET") {
          return mockResponse([lockedProject]);
        }

        if (typeof url === "string" && /\/api\/projects\/\d+$/.test(url) && method === "GET") {
          return mockResponse({ message: "Not found" }, 404);
        }

        if (url === "/api/single-pages") return mockResponse([]);

        return mockResponse({});
      }),
    );

    renderHome();

    const card = await screen.findByTestId("project-card-1", {}, { timeout: 5000 });
    fireEvent.click(card);

    const btn = await screen.findByTestId("take-lock-button", {}, { timeout: 5000 });

    fireEvent.click(btn);

    // During the in-flight POST the button is disabled.
    expect(btn).toBeDisabled();

    // After the 500 response the finally-block runs: isTakingLock → false →
    // button re-enables, banner remains mounted.
    await waitFor(
      () => expect(screen.getByTestId("take-lock-button")).not.toBeDisabled(),
      { timeout: 5000 },
    );
    expect(screen.getByTestId("take-lock-button")).toBeInTheDocument();
  });
});
