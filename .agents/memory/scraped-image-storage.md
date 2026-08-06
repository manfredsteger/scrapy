---
name: Scraped image storage split
description: Where scraped-page image data actually lives, and where its size actually comes from
---

A project's scraped images exist in three separate places that are easy to conflate:
1. Lightweight sitemap-derived `images[]` metadata (loc/title/caption) — DB jsonb on `project_results` rows. Never rendered in markdown/RAG, never downloaded as binaries.
2. `media` entries inside a page's `orderedElements` (DOM-extracted `<img>`/video/etc.) — filesystem `meta.json` per page, not the DB. This is what markdown export, RAG chunking, and the UI preview actually render.
3. Downloaded binary image files — previously saved once per page in that page's own media directory; now saved project-wide in a shared store keyed by source identity (see shared-image-dedup.md), since (3) was the dominant contributor to a project's on-disk size, far more than (2).

**Why:** on a large directory-style site, recurring boilerplate images (site logo, nav banners, certification badges) appear in every page's `orderedElements`, so metadata size for (2) scales with page count × distinct-recurring-images even though the underlying image is identical. Layer (3) has the same multiplication problem for the actual bytes, and is a separate pipeline with its own fix.

**How to apply:** when working on image-related size/perf issues, determine which of the three you're actually looking at. (1) and (2) are DB vs. filesystem metadata; (3) is the binary storage layer. A metadata-only fix (interning `orderedElements` entries) does not by itself reduce disk usage — the binary layer needs its own content-addressed/dedup fix, see shared-image-dedup.md.
