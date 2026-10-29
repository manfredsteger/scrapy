import fs from "fs/promises";
import path from "path";
import crypto from "crypto";
import { resolveMediaRefs, emptySharedImagesRegistry, sharedImageId, legacyMediaFilename, type SharedImagesRegistry } from "./content-extraction/image-refs";

const BASE_DIR = path.resolve("./data");

function urlHash(url: string): string {
  return crypto.createHash("sha256").update(url).digest("hex").slice(0, 10);
}

export function sanitizeDirName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9.\-]/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

export function getProjectDir(projectId: number, domain: string): string {
  return path.join(BASE_DIR, "projects", `${projectId}-${sanitizeDirName(domain)}`);
}

export function getProjectPageDir(projectId: number, domain: string, url: string): string {
  const projectDir = getProjectDir(projectId, domain);
  let pathname: string;
  try {
    const parsed = new URL(url);
    pathname = parsed.pathname + (parsed.search || '');
  } catch {
    pathname = url;
  }
  const segments = pathname
    .split("/")
    .filter(Boolean)
    .map((seg) => sanitizeDirName(seg.replace(/\./g, "-")));
  if (segments.length === 0) {
    segments.push("index");
  }
  const hash = urlHash(url);
  const lastIdx = segments.length - 1;
  segments[lastIdx] = `${segments[lastIdx]}_${hash}`;
  return path.join(projectDir, "pages", ...segments);
}

export function getSinglePageDir(pageId: number, domain: string): string {
  return path.join(BASE_DIR, "single-pages", `${pageId}-${sanitizeDirName(domain)}`);
}

export async function ensureDir(dirPath: string): Promise<void> {
  await fs.mkdir(dirPath, { recursive: true });
}

export async function savePageContent(dir: string, markdown: string): Promise<void> {
  await ensureDir(dir);
  await fs.writeFile(path.join(dir, "content.md"), markdown, "utf-8");
}

export async function savePageMeta(dir: string, meta: object): Promise<void> {
  await ensureDir(dir);
  await fs.writeFile(path.join(dir, "meta.json"), JSON.stringify(meta, null, 2), "utf-8");
}

export async function saveProjectMeta(dir: string, meta: object): Promise<void> {
  await ensureDir(dir);
  await fs.writeFile(path.join(dir, "meta.json"), JSON.stringify(meta, null, 2), "utf-8");
}

// File name for a page-linked PDF. URLs that differ only in the query
// (download.php?id=1 vs ?id=2 - common for CMS download endpoints) used to
// map to the same file and overwrote each other; those get a URL hash.
// Plain URLs keep the old name so existing files are still found.
export function pdfFilenameForUrl(pdfUrl: string): string {
  const [pathPart, query] = pdfUrl.split('?');
  const last = pathPart.split('/').pop() || 'document.pdf';
  const stem = sanitizeDirName(last.replace(/\.pdf$/i, '')) || 'document';
  if (!query) return `${stem}.pdf`;
  return `${stem.slice(0, 60)}-${urlHash(pdfUrl)}.pdf`;
}

export async function savePdf(dir: string, filename: string, buffer: Buffer): Promise<string> {
  const pdfDir = path.join(dir, "pdfs");
  await ensureDir(pdfDir);
  const safeName = sanitizeDirName(filename.replace(/\.pdf$/i, "")) + ".pdf";
  const filePath = path.join(pdfDir, safeName);
  await fs.writeFile(filePath, buffer);
  return filePath;
}

export async function saveMedia(dir: string, filename: string, buffer: Buffer): Promise<string> {
  const mediaDir = path.join(dir, "media");
  await ensureDir(mediaDir);
  const ext = path.extname(filename) || "";
  const baseName = sanitizeDirName(path.basename(filename, ext));
  const safeName = baseName + ext.toLowerCase();
  const filePath = path.join(mediaDir, safeName);
  await fs.writeFile(filePath, buffer);
  return filePath;
}

// Project-wide, content-addressed store for downloaded media binaries
// (server/routes.ts writes here instead of a per-page `media/` copy). A
// recurring image (logo, badge, nav banner) referenced by thousands of pages
// is fetched from its source and written to disk exactly once per project,
// keyed by a caller-supplied id (a hash of the source URL) + extension,
// instead of once per page that references it.
function getSharedMediaDir(projectDir: string): string {
  return path.join(projectDir, "shared-media");
}

/** Returns the on-disk path if this id+ext was already downloaded for the project, else null. */
export async function sharedMediaExists(projectDir: string, id: string, ext: string): Promise<string | null> {
  const filePath = path.join(getSharedMediaDir(projectDir), `${id}${ext}`);
  try {
    await fs.access(filePath);
    return filePath;
  } catch {
    return null;
  }
}

export async function saveSharedMedia(projectDir: string, id: string, ext: string, buffer: Buffer): Promise<string> {
  const dir = getSharedMediaDir(projectDir);
  await ensureDir(dir);
  const filePath = path.join(dir, `${id}${ext}`);
  await fs.writeFile(filePath, buffer);
  return filePath;
}

/**
 * Backfill for projects scraped before shared-media storage existed: sweeps
 * every page's per-page `media/` directory and moves each file into the
 * project-wide shared store, reclaiming disk space for an already-scraped
 * project like kitanetz.de, where the same logo/badge file was downloaded
 * once per page.
 *
 * Files are re-keyed by `sharedImageId(sourceUrl)` - the exact same id the
 * live scrape path (server/routes.ts runContentScrapeBatch) uses - so both
 * paths resolve through one consistent id and any consumer can look up a
 * page's media by recomputing the id from its `src`, with no separate
 * index file to keep in sync. The source URL for each on-disk file is
 * recovered by matching the page's own orderedElements media `src` values
 * against the filename fileStorage.saveMedia used to derive (see
 * image-refs.legacyMediaFilename). A file that can't be matched to any
 * `src` on its page (should be rare - e.g. an image later removed from the
 * page) falls back to content-hash keying so it's still deduplicated and
 * disk is still reclaimed, just not resolvable by URL.
 */
export async function consolidateProjectMedia(
  projectId: number,
  domain: string,
  options: { renewLock?: () => Promise<boolean> } = {},
): Promise<{ filesScanned: number; pagesWithMedia: number; uniqueFiles: number; bytesBefore: number; bytesReclaimed: number; unmatched: number }> {
  const projectDir = getProjectDir(projectId, domain);
  const pageDirs = await listPageDirs(projectDir);
  let filesScanned = 0, pagesWithMedia = 0, uniqueFiles = 0, bytesBefore = 0, bytesReclaimed = 0, unmatched = 0;
  // Same lease-renewal concern as computeAndApplyImageDedup in
  // server/routes.ts: this walks every page's media dir under the caller's
  // scrape lock, which a large project can outlive.
  const renewLock = options.renewLock;
  const RENEW_EVERY_N_PAGES = 200;
  let pagesProcessed = 0;
  for (const dir of pageDirs) {
    const files = await listMedia(dir);
    pagesProcessed++;
    if (renewLock && pagesProcessed % RENEW_EVERY_N_PAGES === 0) {
      const stillHeld = await renewLock();
      if (!stillHeld) {
        throw new Error('Lost the project scrape lock mid-consolidation; aborting to avoid overwriting concurrent changes');
      }
    }
    if (files.length === 0) continue;
    pagesWithMedia++;

    // Map this page's already-downloaded legacy filenames back to the
    // source URL that produced them, using the same naming scheme
    // saveMedia used to derive the file from the URL.
    const meta = await readPageMeta(dir);
    // A legacy filename only unambiguously identifies a source URL if
    // exactly one distinct src on the page derives that filename. Two
    // different URLs can collide on the same sanitized legacy filename
    // (different hosts/paths/query strings, or old sanitization quirks);
    // the page's on-disk storage could only ever hold one file for that
    // name, so there's no way to tell which URL actually produced its
    // bytes. Track every distinct src seen per filename, not just the last.
    const filenameToSrcs = new Map<string, Set<string>>();
    for (const el of meta?.orderedElements || []) {
      if (el?.type === "media" && typeof el.src === "string" && !el.src.startsWith("data:")) {
        const filename = legacyMediaFilename(el.src);
        let set = filenameToSrcs.get(filename);
        if (!set) { set = new Set(); filenameToSrcs.set(filename, set); }
        set.add(el.src);
      }
    }

    for (const filePath of files) {
      let buffer: Buffer;
      try {
        buffer = await fs.readFile(filePath);
      } catch {
        continue;
      }
      filesScanned++;
      bytesBefore += buffer.length;

      const srcs = filenameToSrcs.get(path.basename(filePath));
      const src = srcs && srcs.size === 1 ? [...srcs][0] : undefined;
      if (!src) {
        // Can't confidently match this file to a single source URL (its
        // element was removed from the page, or two distinct URLs collided
        // on this legacy filename). Leave it exactly where it is rather
        // than migrating it under a key nothing can resolve back to -
        // listResolvedMedia still finds it via the page's legacy media/
        // dir, so it's never lost, just not deduplicated across pages.
        unmatched++;
        continue;
      }

      const id = sharedImageId(src);
      const ext = (path.extname(src.split("?")[0]) || ".jpg").toLowerCase();
      const existing = await sharedMediaExists(projectDir, id, ext);
      if (existing) {
        await fs.unlink(filePath).catch(() => {});
        bytesReclaimed += buffer.length;
      } else {
        await saveSharedMedia(projectDir, id, ext, buffer);
        await fs.unlink(filePath).catch(() => {});
        uniqueFiles++;
      }
    }
  }
  return { filesScanned, pagesWithMedia, uniqueFiles, bytesBefore, bytesReclaimed, unmatched };
}

export async function readPageContent(dir: string): Promise<string | null> {
  try {
    return await fs.readFile(path.join(dir, "content.md"), "utf-8");
  } catch {
    return null;
  }
}

// Derives a page's project directory from its page directory (both are
// produced by getProjectPageDir/getProjectDir), so readPageMeta can look up
// the project's shared-images registry without every call site having to
// pass projectId/domain through. Falls back to null for non-project page
// dirs (e.g. single-page imports), which simply skip ref resolution.
function projectDirFromPageDir(pageDir: string): string | null {
  const marker = `${path.sep}pages${path.sep}`;
  const idx = pageDir.indexOf(marker);
  return idx === -1 ? null : pageDir.slice(0, idx);
}

export async function readPageMeta(dir: string): Promise<any | null> {
  try {
    const raw = await fs.readFile(path.join(dir, "meta.json"), "utf-8");
    const meta = JSON.parse(raw);
    if (Array.isArray(meta?.orderedElements)) {
      const projectDir = projectDirFromPageDir(dir);
      if (projectDir) {
        const registry = await readSharedImages(projectDir);
        if (registry) {
          meta.orderedElements = resolveMediaRefs(meta.orderedElements, registry);
        }
      }
    }
    return meta;
  } catch {
    return null;
  }
}

export async function readProjectMeta(dir: string): Promise<any | null> {
  try {
    const raw = await fs.readFile(path.join(dir, "meta.json"), "utf-8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function getSharedImagesFilePath(projectDir: string): string {
  return path.join(projectDir, "shared-images.json");
}

/**
 * Reads a project's shared-images registry (recurring/boilerplate images
 * detected across its pages). Returns null if it hasn't been computed yet
 * (no project has had /dedupe-images run) - callers should treat that the
 * same as "no shared images known".
 */
export async function readSharedImages(projectDir: string): Promise<SharedImagesRegistry | null> {
  try {
    const raw = await fs.readFile(getSharedImagesFilePath(projectDir), "utf-8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export async function writeSharedImages(projectDir: string, registry: SharedImagesRegistry): Promise<void> {
  await ensureDir(projectDir);
  await fs.writeFile(getSharedImagesFilePath(projectDir), JSON.stringify(registry, null, 2), "utf-8");
}

export { emptySharedImagesRegistry };
export type { SharedImagesRegistry };

export async function listPageDirs(projectDir: string): Promise<string[]> {
  const pagesDir = path.join(projectDir, "pages");
  try {
    const dirs: string[] = [];
    const walk = async (current: string) => {
      const entries = await fs.readdir(current, { withFileTypes: true });
      const hasContent = entries.some((e) => e.isFile() && (e.name === "content.md" || e.name === "meta.json"));
      if (hasContent) {
        dirs.push(current);
      }
      for (const entry of entries) {
        if (entry.isDirectory() && entry.name !== "pdfs" && entry.name !== "media") {
          await walk(path.join(current, entry.name));
        }
      }
    };
    await walk(pagesDir);
    return dirs;
  } catch {
    return [];
  }
}

export async function listPdfs(dir: string): Promise<string[]> {
  const pdfDir = path.join(dir, "pdfs");
  try {
    const entries = await fs.readdir(pdfDir);
    return entries.filter((f) => f.toLowerCase().endsWith(".pdf")).map((f) => path.join(pdfDir, f));
  } catch {
    return [];
  }
}

export async function listMedia(dir: string): Promise<string[]> {
  const mediaDir = path.join(dir, "media");
  try {
    const entries = await fs.readdir(mediaDir);
    return entries.map((f) => path.join(mediaDir, f));
  } catch {
    return [];
  }
}

/**
 * Lists the downloaded media files that belong to a page, resolved per
 * `src` rather than as an all-or-nothing choice between "legacy" and
 * "shared", because consolidateProjectMedia only ever moves a file it can
 * confidently match to a `src` (see legacyMediaFilename) - anything it
 * can't match is deliberately left in the page's own `media/` dir rather
 * than migrated, so it's never silently lost. For each media element:
 * prefer a still-present legacy per-page file if one matches its expected
 * filename, else resolve it against the project-wide shared store via
 * sharedImageId(url) (the id both the live scrape and backfill paths write
 * under). Any legacy file left over that doesn't match a current `src`
 * (e.g. an image later removed from the page) is still included, so
 * nothing already-downloaded silently disappears from a consumer's view.
 */
export async function listResolvedMedia(projectDir: string, pageDir: string, orderedElements: any[]): Promise<string[]> {
  const legacyFiles = await listMedia(pageDir);
  const legacyBasenames = new Set(legacyFiles.map((f) => path.basename(f)));
  const consumedLegacy = new Set<string>();
  const paths: string[] = [];
  const seen = new Set<string>();

  for (const el of orderedElements || []) {
    if (el?.type === "media" && typeof el.src === "string" && !el.src.startsWith("data:")) {
      const legacyName = legacyMediaFilename(el.src);
      if (legacyBasenames.has(legacyName)) {
        consumedLegacy.add(legacyName);
        const filePath = path.join(pageDir, "media", legacyName);
        if (!seen.has(filePath)) {
          seen.add(filePath);
          paths.push(filePath);
        }
        continue;
      }
      const id = sharedImageId(el.src);
      const ext = (path.extname(el.src.split("?")[0]) || ".jpg").toLowerCase();
      const filePath = await sharedMediaExists(projectDir, id, ext);
      if (filePath && !seen.has(filePath)) {
        seen.add(filePath);
        paths.push(filePath);
      }
    }
  }

  for (const filePath of legacyFiles) {
    if (!consumedLegacy.has(path.basename(filePath)) && !seen.has(filePath)) {
      seen.add(filePath);
      paths.push(filePath);
    }
  }
  return paths;
}

export async function readPdf(filePath: string): Promise<Buffer | null> {
  try {
    return await fs.readFile(filePath);
  } catch {
    return null;
  }
}

export async function findPdfByUrl(pageDir: string, pdfUrl: string): Promise<Buffer | null> {
  const urlFilename = pdfUrl.split('/').pop()?.split('?')[0] || '';
  if (!urlFilename) return null;
  const legacyName = sanitizeDirName(urlFilename.replace(/\.pdf$/i, '')) + '.pdf';
  const pdfDir = path.join(pageDir, 'pdfs');
  // New (query-aware) name first, then the pre-hash name of older scrapes.
  for (const name of Array.from(new Set([pdfFilenameForUrl(pdfUrl), legacyName]))) {
    try {
      return await fs.readFile(path.join(pdfDir, name));
    } catch {}
  }
  return null;
}

const pdfDownloadIndexCache = new Map<string, Map<string, string>>();

async function loadPdfDownloadIndex(projectDir: string): Promise<Map<string, string>> {
  const cached = pdfDownloadIndexCache.get(projectDir);
  if (cached) return cached;
  const indexPath = path.join(projectDir, 'pdf-downloads', 'index.json');
  try {
    const data = JSON.parse(await fs.readFile(indexPath, 'utf-8'));
    const map = new Map<string, string>(Object.entries(data));
    pdfDownloadIndexCache.set(projectDir, map);
    return map;
  } catch {
    const map = new Map<string, string>();
    pdfDownloadIndexCache.set(projectDir, map);
    return map;
  }
}

async function savePdfDownloadIndex(projectDir: string, index: Map<string, string>): Promise<void> {
  const dlDir = path.join(projectDir, 'pdf-downloads');
  await ensureDir(dlDir);
  const obj: Record<string, string> = {};
  for (const [k, v] of index) obj[k] = v;
  await fs.writeFile(path.join(dlDir, 'index.json'), JSON.stringify(obj, null, 2), 'utf-8');
}

export async function findProjectPdf(projectId: number, domain: string, pdfUrl: string, pageDir?: string): Promise<Buffer | null> {
  if (pageDir) {
    const fromPage = await findPdfByUrl(pageDir, pdfUrl);
    if (fromPage) return fromPage;
  }
  const projectDir = getProjectDir(projectId, domain);
  const index = await loadPdfDownloadIndex(projectDir);
  const localPath = index.get(pdfUrl);
  if (localPath) {
    if (localPath === 'FAILED') return null;
    try {
      return await fs.readFile(localPath);
    } catch {
      index.delete(pdfUrl);
    }
  }
  return null;
}

export async function isProjectPdfFailed(projectId: number, domain: string, pdfUrl: string): Promise<boolean> {
  const projectDir = getProjectDir(projectId, domain);
  const index = await loadPdfDownloadIndex(projectDir);
  return index.get(pdfUrl) === 'FAILED';
}

export async function markProjectPdfFailed(projectId: number, domain: string, pdfUrl: string): Promise<void> {
  const projectDir = getProjectDir(projectId, domain);
  const index = await loadPdfDownloadIndex(projectDir);
  index.set(pdfUrl, 'FAILED');
  await savePdfDownloadIndex(projectDir, index);
}

export async function saveProjectPdf(projectId: number, domain: string, pdfUrl: string, buffer: Buffer): Promise<string> {
  const projectDir = getProjectDir(projectId, domain);
  const dlDir = path.join(projectDir, 'pdf-downloads');
  await ensureDir(dlDir);
  const hash = urlHash(pdfUrl);
  const urlFilename = pdfUrl.split('/').pop()?.split('?')[0] || 'document.pdf';
  const safeName = sanitizeDirName(urlFilename.replace(/\.pdf$/i, '')) + '.pdf';
  const filename = `${hash}_${safeName}`;
  const filePath = path.join(dlDir, filename);
  await fs.writeFile(filePath, buffer);
  const index = await loadPdfDownloadIndex(projectDir);
  index.set(pdfUrl, filePath);
  await savePdfDownloadIndex(projectDir, index);
  return filePath;
}

export function clearPdfDownloadIndexCache(projectId: number, domain: string): void {
  const projectDir = getProjectDir(projectId, domain);
  pdfDownloadIndexCache.delete(projectDir);
}

export async function countProjectAttachments(projectId: number, domain: string): Promise<number> {
  const projectDir = getProjectDir(projectId, domain);
  const pageDirs = await listPageDirs(projectDir);
  let total = 0;
  for (const pageDir of pageDirs) {
    try {
      const meta = await readPageMeta(pageDir);
      if (meta?.linkedPdfs && Array.isArray(meta.linkedPdfs)) {
        total += meta.linkedPdfs.length;
      }
    } catch {}
  }
  return total;
}

// getPagePdfCounts scans every page directory on disk (readdir + read meta.json
// per page), which is O(pageCount) I/O. On large projects (10k+ pages) that
// alone takes tens of seconds, and it's called on every project-detail /
// results-page / results-summary request. Cache the result briefly per
// project so opening a huge project doesn't repeat that scan on every
// request; callers that just changed PDF data (attachment sync, rescrape)
// must call invalidatePagePdfCountsCache() explicitly.
const pdfCountsCache = new Map<number, { counts: Map<string, number>; expiresAt: number }>();
const PDF_COUNTS_CACHE_TTL_MS = 30_000;

export function invalidatePagePdfCountsCache(projectId: number): void {
  pdfCountsCache.delete(projectId);
}

export async function getPagePdfCounts(projectId: number, domain: string): Promise<Map<string, number>> {
  const cached = pdfCountsCache.get(projectId);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.counts;
  }
  const projectDir = getProjectDir(projectId, domain);
  const pageDirs = await listPageDirs(projectDir);
  const counts = new Map<string, number>();
  for (const pageDir of pageDirs) {
    try {
      const meta = await readPageMeta(pageDir);
      if (meta?.url && meta?.linkedPdfs && Array.isArray(meta.linkedPdfs)) {
        counts.set(meta.url, meta.linkedPdfs.length);
      }
    } catch {}
  }
  pdfCountsCache.set(projectId, { counts, expiresAt: Date.now() + PDF_COUNTS_CACHE_TTL_MS });
  return counts;
}

export interface PdfReference {
  url: string;
  title?: string;
  linkText?: string;
  pageUrl: string;
  localPath?: string;
  downloaded: boolean;
}

export async function buildProjectPdfsJson(projectId: number, domain: string): Promise<PdfReference[]> {
  const projectDir = getProjectDir(projectId, domain);
  const pageDirs = await listPageDirs(projectDir);
  const allPdfs: PdfReference[] = [];

  for (const pageDir of pageDirs) {
    try {
      const meta = await readPageMeta(pageDir);
      if (!meta?.linkedPdfs || !Array.isArray(meta.linkedPdfs)) continue;

      const localPdfs = await listPdfs(pageDir);
      const localNames = localPdfs.map(p => p.split('/').pop() || '');

      for (const pdf of meta.linkedPdfs) {
        const urlFilename = pdf.url?.split('/').pop()?.split('?')[0] || '';
        const exactName = pdf.url ? pdfFilenameForUrl(pdf.url) : '';
        const matchedLocal =
          localPdfs.find((_, i) => localNames[i] === exactName) ??
          localPdfs.find((_, i) => {
            const name = localNames[i];
            return name === urlFilename || name.includes(sanitizeDirName(urlFilename.replace(/\.pdf$/i, '')));
          });

        allPdfs.push({
          url: pdf.url,
          title: pdf.title,
          linkText: pdf.linkText,
          pageUrl: meta.url || '',
          localPath: matchedLocal ? path.relative(projectDir, matchedLocal) : undefined,
          downloaded: !!matchedLocal,
        });
      }
    } catch {}
  }

  await ensureDir(projectDir);
  await fs.writeFile(path.join(projectDir, "pdfs.json"), JSON.stringify(allPdfs, null, 2), "utf-8");
  return allPdfs;
}

export async function readProjectPdfsJson(projectId: number, domain: string): Promise<PdfReference[] | null> {
  const projectDir = getProjectDir(projectId, domain);
  try {
    const raw = await fs.readFile(path.join(projectDir, "pdfs.json"), "utf-8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export async function saveProjectChunks(projectId: number, domain: string, chunks: any[]): Promise<void> {
  const dir = getProjectDir(projectId, domain);
  await ensureDir(dir);
  await fs.writeFile(path.join(dir, "chunks.json"), JSON.stringify(chunks), "utf-8");
}

export async function readProjectChunks(projectId: number, domain: string): Promise<any[] | null> {
  const dir = getProjectDir(projectId, domain);
  try {
    const raw = await fs.readFile(path.join(dir, "chunks.json"), "utf-8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export async function saveSinglePageChunks(pageId: number, domain: string, chunks: any[]): Promise<void> {
  const dir = getSinglePageDir(pageId, domain);
  await ensureDir(dir);
  await fs.writeFile(path.join(dir, "chunks.json"), JSON.stringify(chunks), "utf-8");
}

export async function readSinglePageChunks(pageId: number, domain: string): Promise<any[] | null> {
  const dir = getSinglePageDir(pageId, domain);
  try {
    const raw = await fs.readFile(path.join(dir, "chunks.json"), "utf-8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export async function deleteProjectDir(projectId: number, domain: string): Promise<void> {
  const dir = getProjectDir(projectId, domain);
  try {
    await fs.rm(dir, { recursive: true, force: true });
  } catch {
  }
}

export async function deleteSinglePageDir(pageId: number, domain: string): Promise<void> {
  const dir = getSinglePageDir(pageId, domain);
  try {
    await fs.rm(dir, { recursive: true, force: true });
  } catch {
  }
}

export async function getStorageStats(): Promise<{ totalFiles: number; totalSizeBytes: number }> {
  let totalFiles = 0;
  let totalSizeBytes = 0;

  const walk = async (dirPath: string) => {
    try {
      const entries = await fs.readdir(dirPath, { withFileTypes: true });
      for (const entry of entries) {
        const fullPath = path.join(dirPath, entry.name);
        if (entry.isDirectory()) {
          await walk(fullPath);
        } else if (entry.isFile()) {
          totalFiles++;
          try {
            const stat = await fs.stat(fullPath);
            totalSizeBytes += stat.size;
          } catch {
          }
        }
      }
    } catch {
    }
  };

  await walk(BASE_DIR);
  return { totalFiles, totalSizeBytes };
}
