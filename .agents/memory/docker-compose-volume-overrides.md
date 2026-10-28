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

**Dependency-volume rule:** Development starts that rebuild the image must
also recreate the container with a renewed anonymous dependency volume.

**Why:** Compose can reuse the old anonymous `/app/node_modules` volume,
masking correctly installed image dependencies. A successful image build
therefore does not prove that the mounted development container can find
`tsx` or `drizzle-kit`.

**How to apply:** Verify executable availability in the built image and
check volume renewal on development startup. Never use deletion of database
volumes as a dependency repair.

**Portable dependency builds:** Normalize Replit-internal registry URLs inside
the Docker build before installing, rather than only editing the checked-in
lockfile.

**Why:** The user reported incomplete dependency installs outside Replit from
unreachable `package-firewall.replit.local` URLs, including an npm failure that
returned success. Internal URLs were confirmed in the lockfile; Replit updates
can introduce them again.

**How to apply:** Rewrite the internal npm prefix to the public npm registry
before `npm ci`, preserve integrity hashes, and independently assert required
executables exist so a false-success install cannot produce a broken image.
