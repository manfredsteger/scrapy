---
name: Project write concurrency
description: Design rationale for guarding concurrent project progress writes
---

Scraping runs client-driven in browser tabs as read-modify-write batches, so concurrent writers (second tab, server actions) can silently erase each other's progress.

**Rule:** Any write path that persists scrape progress must be guarded — a lease owned by the writing tab plus optimistic versioning — and the guard condition must be evaluated *inside the same atomic DB UPDATE* as the write (never check-then-write in two steps). Explicit user status changes (pause/stop/resume) stay allowed from any tab; unrelated writes (renames etc.) must not be able to reassign the lease.

**Why:** Two tabs both passed a separate read-side lock check and overwrote each other; only an atomic conditional update closes that race.

**How to apply:** New progress writers identify themselves as the lease owner and treat a conflict response as "discard the batch and refetch", never retry blindly.

**Client scheduling rule:** Await progress invalidation before releasing the processing slot, select work from the current query cache rather than a prior render, and defer redispatch instead of immediately recursing.

**Why:** Immediate redispatch repeatedly finished an already-idle project from stale render state. Repeated invalidations cancelled pending refreshes, while completion repeatedly ran filesystem image dedup. This caused thousands of writes and a continuously loading UI.

**How to apply:** Preserve configured per-project delays, impose a minimum retry delay on failure/completion, and test completion against a deliberately delayed list refetch.

**Dedup contract:** Delta-append writes must also deduplicate server-side inside the same UPDATE (against persisted entries and within the batch, results keyed by `loc`), because replayed/retried deltas with a valid version would otherwise create duplicates that CAS alone cannot prevent. `totalUrls` must be computed from the post-dedup results length.
