/**
 * Tests for the lock-takeover feature:
 *  1. isLockedByOtherTab utility – pure logic, no DOM needed
 *  2. LockTakeoverBanner component – rendering & click behaviour
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import "@testing-library/jest-dom";

import { isLockedByOtherTab } from "@/utils/lock-utils";
import LockTakeoverBanner from "@/components/LockTakeoverBanner";

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
