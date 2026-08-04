---
name: Normalized crawl results
description: Crawl results live in the project_results table, not the projects.results jsonb column
---

Crawl results are normalized into a `project_results` table (one row per URL, unique on project_id+loc); the legacy `projects.results` jsonb column is kept but always `[]` after the idempotent startup migration.

**Why:** appending to a multi-MB jsonb value forced Postgres to rewrite the whole TOAST value per batch; row inserts + a unique index keep large projects fast and dedup race-safe.

**How to apply:** never write to `projects.results` directly — go through the storage layer, which transparently maps `results` arrays to rows (getProject/updateProject/createProject) and does append-only inserts in appendCrawlProgress. `stats.totalUrls` is authoritative from the row count. New raw SQL touching results must target `project_results`, not the column.
