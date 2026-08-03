// Crawl depth enforcement (shared between the client crawl loop and tests).
//
// Each queued URL carries a depth in the project's `crawlDepths` map. Links
// discovered on a page get `parentDepth + 1`; anything beyond the project's
// configured maxDepth is not enqueued. URLs without a recorded depth (e.g.
// projects created before depth tracking existed) count as depth 0, so
// existing crawls keep their previous behavior.

export interface DiscoveredLinkState {
  /** Crawl queue (mutated: accepted links are appended). */
  queue: string[];
  /** Depth per URL (mutated: accepted links get parentDepth + 1). */
  depths: Record<string, number>;
  /** Number of results collected so far (for the global URL cap). */
  resultCount: number;
  /** URLs already stored as results. */
  existingLocs: Set<string>;
  /** URLs already processed. */
  existingProcessed: Set<string>;
  /** URLs already queued (mutated: accepted links are added). */
  existingQueue: Set<string>;
}

export function addDiscoveredLinks(
  state: DiscoveredLinkState,
  parentUrl: string,
  links: string[],
  maxDepth: number,
  maxTotalUrls: number,
): void {
  const linkDepth = (state.depths[parentUrl] ?? 0) + 1;
  if (linkDepth > maxDepth) return;
  for (const link of links) {
    if (state.resultCount + state.queue.length >= maxTotalUrls) return;
    if (
      !state.existingLocs.has(link) &&
      !state.existingProcessed.has(link) &&
      !state.existingQueue.has(link)
    ) {
      state.queue.push(link);
      state.existingQueue.add(link);
      state.depths[link] = linkDepth;
    }
  }
}
