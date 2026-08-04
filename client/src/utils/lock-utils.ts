/**
 * Returns true when the given project's scrape lock is held by a *different* tab
 * (i.e. the lock exists, is not yet expired, and belongs to a different owner).
 *
 * `currentOwner` is the TAB_ID of the calling tab – passed explicitly so that
 * this function stays pure and testable without depending on the module-level
 * constant inside Home.tsx.
 */
export function isLockedByOtherTab(
  project: { scrapeLock?: { owner: string; expiresAt: number } | null } | undefined,
  currentOwner: string,
): boolean {
  const lock = project?.scrapeLock;
  return !!(lock && lock.owner !== currentOwner && lock.expiresAt > Date.now());
}
