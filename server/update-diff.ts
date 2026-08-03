// Pure diff logic for incremental project updates ("Aktualisieren").
// Compares the current results with freshly discovered URLs and computes
// what is new, changed, or removed — without ever deleting scraped content.

export interface ExistingEntry {
  loc: string;
  lastmod?: string | null;
  changefreq?: string | null;
  priority?: string | null;
  images?: unknown[];
  videos?: unknown[];
  scrapedData?: unknown;
  hasScrapedData?: boolean;
  removedFromSource?: boolean;
  [key: string]: unknown;
}

export interface DiscoveredEntry {
  loc: string;
  lastmod?: string | null;
  changefreq?: string | null;
  priority?: string | null;
  images?: unknown[];
  videos?: unknown[];
}

export interface SitemapDiffResult {
  results: ExistingEntry[];
  queue: string[];
  newUrls: number;
  changedUrls: number;
  removedUrls: number;
}

function hasContent(e: ExistingEntry): boolean {
  return !!e.hasScrapedData || (e.scrapedData != null && typeof e.scrapedData === 'object');
}

/**
 * Sitemap-mode diff: merge freshly discovered sitemap entries into existing
 * results. New URLs are appended and queued; existing URLs whose lastmod
 * changed are queued for re-scrape; URLs that disappeared from the sitemap are
 * flagged removedFromSource (content is kept). Existing URLs without content
 * are also queued (catch-up) but not counted as new.
 */
export function diffSitemapUpdate(
  existing: ExistingEntry[],
  discovered: DiscoveredEntry[],
): SitemapDiffResult {
  const discoveredByLoc = new Map<string, DiscoveredEntry>();
  for (const d of discovered) {
    if (!discoveredByLoc.has(d.loc)) discoveredByLoc.set(d.loc, d);
  }
  const existingLocs = new Set(existing.map(e => e.loc));

  const queue: string[] = [];
  const queued = new Set<string>();
  let newUrls = 0;
  let changedUrls = 0;
  let removedUrls = 0;

  const enqueue = (loc: string) => {
    if (!queued.has(loc)) {
      queued.add(loc);
      queue.push(loc);
    }
  };

  const results: ExistingEntry[] = existing.map(e => {
    const d = discoveredByLoc.get(e.loc);
    if (!d) {
      // Disappeared from the source
      if (!e.removedFromSource) removedUrls++;
      return { ...e, removedFromSource: true };
    }
    const updated: ExistingEntry = {
      ...e,
      lastmod: d.lastmod ?? e.lastmod,
      changefreq: d.changefreq ?? e.changefreq,
      priority: d.priority ?? e.priority,
      removedFromSource: undefined,
    };
    delete updated.removedFromSource;
    if (hasContent(e)) {
      if (d.lastmod && e.lastmod && d.lastmod !== e.lastmod) {
        changedUrls++;
        enqueue(e.loc);
      }
    } else {
      // Never scraped (or failed before): catch up, but don't count as new
      enqueue(e.loc);
    }
    return updated;
  });

  for (const d of discovered) {
    if (!existingLocs.has(d.loc) && !queued.has(d.loc)) {
      results.push({
        loc: d.loc,
        lastmod: d.lastmod ?? undefined,
        changefreq: d.changefreq ?? undefined,
        priority: d.priority ?? undefined,
        images: d.images ?? [],
        videos: d.videos ?? [],
      });
      newUrls++;
      enqueue(d.loc);
    }
  }

  return { results, queue, newUrls, changedUrls, removedUrls };
}

export interface CrawlFinishResult {
  results: ExistingEntry[];
  queue: string[];
  newUrls: number;
  removedUrls: number;
}

/**
 * Crawl-mode finish diff: after an update re-crawl completed, `processed`
 * contains every reachable URL. Entries not reached are flagged
 * removedFromSource; entries without content (the newly discovered ones and
 * previous failures) are queued for extraction. Crawl mode cannot detect
 * content changes (no lastmod), so changedUrls is always 0.
 */
export function diffCrawlFinish(
  existing: ExistingEntry[],
  processed: string[],
  erroredUrls: string[] = [],
): CrawlFinishResult {
  const reached = new Set(processed);
  const errored = new Set(erroredUrls);
  const queue: string[] = [];
  let newUrls = 0;
  let removedUrls = 0;

  const results: ExistingEntry[] = existing.map(e => {
    if (!reached.has(e.loc)) {
      // A fetch error during discovery is not proof of removal — leave the
      // entry unchanged rather than flagging it.
      if (errored.has(e.loc)) return e;
      if (!e.removedFromSource) removedUrls++;
      return { ...e, removedFromSource: true };
    }
    const updated = { ...e };
    delete updated.removedFromSource;
    if (!hasContent(updated)) {
      queue.push(updated.loc);
      newUrls++;
    }
    return updated;
  });

  return { results, queue, newUrls, removedUrls };
}
