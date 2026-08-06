---
name: Docker Compose volume list overrides
description: Why `volumes: []` in an override file does not clear a base file's volumes, and the override.yml pattern that actually works.
---

Compose merges `volumes:` (and other list-valued keys) across `-f` files by
concatenation, not replacement. Setting `volumes: []` in an override file is
a no-op — the base file's entries survive untouched. Verified with
`docker compose -f base.yml -f override-with-empty-list.yml config`.

**Why:** A prod override that tries to "clear" a dev bind-mount this way
silently fails, so the host source tree stays bind-mounted over `/app` even
in "production" mode, shadowing the built image contents.

**How to apply:** To make a file truly dev-only, put dev-only volumes (and
similar list keys) in `docker-compose.override.yml` instead of the base
file. `docker compose up` (no `-f` flags) auto-loads `docker-compose.yml` +
`docker-compose.override.yml`; any invocation with explicit `-f` flags
(e.g. `-f docker-compose.yml -f docker-compose.prod.yml`) does NOT auto-load
`override.yml`, so prod naturally never inherits the dev volumes. Confirm
with `docker compose config` (default vs. explicit `-f` invocation) before
trusting it.
