---
name: Lite project endpoints vs. client merges
description: Project list/detail APIs return stripped "lite" objects; client read-modify-write loops must not merge against them.
---

**Rule:** `GET /api/projects` (list) returns projects WITHOUT `results`/`processed`; `GET /api/projects/:id` returns lite-mapped results with `scrapedData` stripped and `lastmod`/`changefreq`/`priority` possibly `null`. Any client loop doing read-modify-write of `results`/`processed` must fetch the detail endpoint first, and the server PUT re-attaches inline `scrapedData` by `loc` so lite-derived writes can't erase it.

**Why:** A perf optimization (lite projections) silently broke the crawl/sitemap loops in `Home.tsx`: they merged against lite objects, overwriting all prior results with each 10-URL batch (UI frozen at "URLs found: 10" while the queue drained). Also, nulls from SQL projections failed the strict zod PUT schema (`Expected string, received null`), so `sitemapUrlEntrySchema` uses `.nullish()` for those fields.

**How to apply:** When adding endpoints or client loops that write `projects.results`/`processed`, merge against full data (or merge server-side), keep the PUT scrapedData re-attach logic, and make zod schemas null-tolerant for fields coming from SQL jsonb projections. Known limitation: batch PUTs are not concurrency-safe (no CAS); two tabs can still clobber each other.
