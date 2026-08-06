// Pure helpers for interning recurring "boilerplate" images (logos, badges,
// nav icons, ad banners, ...) that repeat identically across most pages of a
// large directory-style site (e.g. kitanetz.de's ~11k Kita listing pages).
//
// A page's orderedElements normally stores each <img> as a full
// { type: 'media', tag: 'img', src, alt } entry. When the same src repeats
// across thousands of pages, storing it in full every time balloons the
// project's on-disk/DB footprint for no benefit. Once an image is recognized
// as shared, pages reference it via a compact { type: 'media-ref', ref: id }
// entry instead, and the full { src, alt, tag } lives once in the project's
// shared-images registry (see fileStorage.readSharedImages/writeSharedImages).
//
// This module has no I/O and no dependency on fileStorage, so fileStorage
// can safely import it (avoids a circular import between the two).
import crypto from "crypto";

export interface SharedImageEntry {
  id: string;
  src: string;
  alt?: string;
  tag?: string;
  occurrenceCount: number;
  firstDetectedAt: string;
  lastComputedAt: string;
}

export interface SharedImagesRegistry {
  images: Record<string, SharedImageEntry>;
  lastComputedAt: string | null;
  threshold: { minOccurrences: number; minSharePercent: number } | null;
}

export function emptySharedImagesRegistry(): SharedImagesRegistry {
  return { images: {}, lastComputedAt: null, threshold: null };
}

/** Deterministic short id for an image URL, stable across recompute runs. */
export function sharedImageId(src: string): string {
  return crypto.createHash("sha256").update(src).digest("hex").slice(0, 12);
}

/**
 * Reproduces the filename fileStorage.saveMedia used to derive from a source
 * URL before shared-media storage existed (sanitizeDirName'd basename +
 * lowercased extension - duplicated here rather than imported, to keep this
 * module free of any fileStorage dependency; see file header). Used only to
 * match a page's already-downloaded legacy `media/<file>` back to the URL
 * that produced it, so the one-time backfill
 * (fileStorage.consolidateProjectMedia) can re-key it by sharedImageId(url) -
 * the same scheme the live scrape path uses - instead of by file content, so
 * both paths resolve through the same id and stay consistent.
 */
export function legacyMediaFilename(url: string): string {
  const filename = url.split("/").pop()?.split("?")[0] || "image.jpg";
  const dot = filename.lastIndexOf(".");
  const ext = dot > 0 ? filename.slice(dot) : "";
  const nameWithoutExt = dot > 0 ? filename.slice(0, dot) : filename;
  const sanitized = nameWithoutExt
    .toLowerCase()
    .replace(/[^a-z0-9.\-]/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
  return sanitized + ext.toLowerCase();
}

/**
 * Expands any `media-ref` elements back into full media elements using the
 * project's shared-images registry, so every consumer (markdown export, RAG
 * chunking, page preview) sees ordinary media entries and needs no changes.
 * If the registry is missing or a ref can't be found (should not normally
 * happen since entries are never removed from the registry), the ref is left
 * in place rather than silently dropped, so a data problem stays visible
 * instead of quietly deleting content.
 */
export function resolveMediaRefs(elements: any[], registry: SharedImagesRegistry | null | undefined): any[] {
  if (!Array.isArray(elements) || elements.length === 0) return elements;
  const hasRefs = elements.some(el => el?.type === "media-ref");
  if (!hasRefs) return elements;
  return elements.map(el => {
    if (el?.type !== "media-ref") return el;
    const entry = registry?.images?.[el.ref];
    if (!entry) return el;
    return { type: "media", tag: entry.tag || "img", src: entry.src, alt: entry.alt, shared: true };
  });
}

/**
 * Replaces media elements whose src is a known-shared image with a compact
 * `media-ref`. Only collapses <img> media (not video/iframe) since those are
 * page-specific by nature. Returns the (possibly) new array plus how many
 * elements were collapsed, so callers can skip a write when nothing changed.
 */
export function collapseSharedImages(
  elements: any[],
  sharedSrcToId: Map<string, string>,
): { elements: any[]; collapsedCount: number } {
  if (!Array.isArray(elements) || elements.length === 0 || sharedSrcToId.size === 0) {
    return { elements, collapsedCount: 0 };
  }
  let collapsedCount = 0;
  const next = elements.map(el => {
    if (el?.type === "media" && el.tag === "img" && typeof el.src === "string") {
      const id = sharedSrcToId.get(el.src);
      if (id) {
        collapsedCount++;
        return { type: "media-ref", ref: id };
      }
    }
    return el;
  });
  return { elements: next, collapsedCount };
}
