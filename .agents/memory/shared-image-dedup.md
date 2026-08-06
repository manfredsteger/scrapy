---
name: Shared/boilerplate image interning pattern
description: How recurring images across a project's pages are collapsed into a compact reference, and the traps to avoid
---

For a project where the same image (logo, badge, nav banner) recurs across most pages, storing the full entry on every page balloons metadata size, and downloading/writing the same binary once per page balloons disk size. Both the metadata and the binary layer need fixing — a metadata-only interning fix does not by itself reduce disk usage, since the bytes are the dominant cost.

Key structural decisions:
- Resolution back to the full value is centralized in one low-level read path, not scattered across every consumer, so markdown export / RAG chunking / preview are unaffected automatically.
- The interning registry is append-only — recompute passes only add/refresh entries, never remove them, so an old reference stays resolvable forever.
- Detecting *which* items are shared requires scanning many records and is a periodic/on-demand pass; applying *already-known* shared items to a freshly-created record is cheap and can happen inline.
- Both the metadata layer and the binary-storage layer must resolve through the same deterministic id (e.g. a hash of the source identity), not two independent addressing schemes — otherwise a backfill can key files in a way the live-write path can never look up again, silently breaking resolution for anything already migrated.

**Why:** avoids touching every consumer call site individually, keeps the optimization safe to re-run/backfill, and keeps the two storage layers resolvable through one id instead of needing a separate index to keep in sync.

**How to apply:** reuse this shape (append-only registry + centralized resolve-on-read + one consistent id across every storage layer) for any future "intern a repeated value across many stored records" problem, not just images.

Concurrency and data-loss pitfalls worth checking for in this shape of feature:
- A compaction/backfill pass that scans+rewrites many records outside the DB (e.g. plain files) needs the project's normal write-serialization mechanism held for the *whole* pass, not just checked at the start — snapshot-then-rewrite over a long scan is a lost-update race against anything else writing those same records concurrently. If the pass can run long, renew the lock/lease periodically or it can expire mid-scan and reopen the race.
- When work items are processed concurrently, a "does the shared resource already exist" check-then-fetch-then-write sequence is itself racy: two items discovering the same not-yet-cached resource in the same tick will both pass the existence check before either has written. Needs an in-flight-request map (or equivalent) shared across the concurrent batch.
- Never migrate or delete an existing record onto a new key unless the mapping back to that key is unambiguous. If the old storage scheme can't tell you for certain which logical identity produced a given record (e.g. two distinct sources collide on the same legacy identifier), leave it where it is and count it as unresolved rather than guessing — a wrong guess silently destroys data, while leaving it in place at worst leaves it un-deduplicated.
