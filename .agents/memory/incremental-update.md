---
name: Incremental project update
description: How the "Aktualisieren" feature diffs sites and its safety rules
---
Incremental update flow: `start-update` (sitemap: server-side re-discovery + diff synchronously; crawl: re-crawl with `updateRun.phase='discovery'`, client loop calls `finish-update` when queue empties).

**Rules:**
- Removal is a reversible flag (`removedFromSource`), never a delete; scraped content is always kept.
- Abort sitemap diffs when any sitemap fetch failed — an incomplete discovery would mass-flag URLs as removed.
- Crawl mode: URLs listed in project errors are never flagged removed (fetch error ≠ removal); no changed-detection (no lastmod).
- Client `finish-update` failures must be terminal-handled (clear updateRun, back to idle) or the crawl loop retries forever.
- `createInsertSchema` types jsonb columns as generic Json — pin new jsonb columns via `.extend()` on the insert schema or writes fail typecheck.
