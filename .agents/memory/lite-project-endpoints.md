---
name: Lite project endpoints vs. client merges
description: Project list/detail APIs return stripped "lite" objects; client read-modify-write loops must not merge against them.
---

**Rule:** `GET /api/projects` (list) returns projects WITHOUT `results`/`processed`; `GET /api/projects/:id` returns lite-mapped results with `scrapedData` stripped and `lastmod`/`changefreq`/`priority` possibly `null`. Any client loop doing read-modify-write of `results`/`processed` must fetch the detail endpoint first, and the server PUT re-attaches inline `scrapedData` by `loc` so lite-derived writes can't erase it.

**Why:** A perf optimization (lite projections) silently broke the crawl/sitemap loops in `Home.tsx`: they merged against lite objects, overwriting all prior results with each 10-URL batch (UI frozen at "URLs found: 10" while the queue drained). Also, nulls from SQL projections failed the strict zod PUT schema (`Expected string, received null`), so `sitemapUrlEntrySchema` uses `.nullish()` for those fields.

**How to apply:** When adding endpoints or client loops that write `projects.results`/`processed`, merge against full data (or merge server-side), keep the PUT scrapedData re-attach logic, and make zod schemas null-tolerant for fields coming from SQL jsonb projections. Progress writes must also follow the atomic lease/version rules in `project-write-concurrency.md`.

**Cache rule:** Separately fetched result pages and summaries must participate in project progress invalidation, not just metadata.

**Why:** A cached zero summary took precedence over fresh metadata counts, hiding both discovered URLs and the extraction action even though discovery succeeded. A finite staleTime alone does not trigger refetching.

**How to apply:** When splitting a project view into new queries, test a mounted empty view transitioning to populated results through the same invalidation used by progress writes, without navigation or reload.
