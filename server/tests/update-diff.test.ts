import { describe, it, expect } from 'vitest';
import { diffSitemapUpdate, diffCrawlFinish, type ExistingEntry } from '../update-diff';

const scraped = (loc: string, lastmod?: string): ExistingEntry => ({
  loc, lastmod, images: [], videos: [], hasScrapedData: true,
});
const unscraped = (loc: string, lastmod?: string): ExistingEntry => ({
  loc, lastmod, images: [], videos: [],
});

describe('diffSitemapUpdate', () => {
  it('detects new, changed, and removed URLs', () => {
    const existing = [
      scraped('https://a.de/1', '2026-01-01'),
      scraped('https://a.de/2', '2026-01-01'),
      scraped('https://a.de/3', '2026-01-01'),
    ];
    const discovered = [
      { loc: 'https://a.de/1', lastmod: '2026-01-01' }, // unchanged
      { loc: 'https://a.de/2', lastmod: '2026-06-01' }, // changed
      { loc: 'https://a.de/4', lastmod: '2026-06-01' }, // new
    ];
    const r = diffSitemapUpdate(existing, discovered);
    expect(r.newUrls).toBe(1);
    expect(r.changedUrls).toBe(1);
    expect(r.removedUrls).toBe(1);
    expect(r.queue.sort()).toEqual(['https://a.de/2', 'https://a.de/4']);
    const removed = r.results.find(e => e.loc === 'https://a.de/3');
    expect(removed?.removedFromSource).toBe(true);
    expect(removed?.hasScrapedData).toBe(true); // content kept
    const changed = r.results.find(e => e.loc === 'https://a.de/2');
    expect(changed?.lastmod).toBe('2026-06-01');
  });

  it('queues previously unscraped URLs without counting them as new', () => {
    const r = diffSitemapUpdate(
      [unscraped('https://a.de/fail')],
      [{ loc: 'https://a.de/fail' }],
    );
    expect(r.queue).toEqual(['https://a.de/fail']);
    expect(r.newUrls).toBe(0);
    expect(r.changedUrls).toBe(0);
  });

  it('does not double-count already removed entries and revives reappearing ones', () => {
    const gone: ExistingEntry = { ...scraped('https://a.de/x'), removedFromSource: true };
    const r1 = diffSitemapUpdate([gone], []);
    expect(r1.removedUrls).toBe(0);
    const r2 = diffSitemapUpdate([gone], [{ loc: 'https://a.de/x' }]);
    expect(r2.results[0].removedFromSource).toBeUndefined();
  });

  it('does not treat missing lastmod as change and dedupes discovered', () => {
    const r = diffSitemapUpdate(
      [scraped('https://a.de/1')],
      [{ loc: 'https://a.de/1', lastmod: '2026-06-01' }, { loc: 'https://a.de/1', lastmod: '2026-06-01' }],
    );
    expect(r.changedUrls).toBe(0); // no stored lastmod -> cannot detect change
    expect(r.results).toHaveLength(1);
  });
});

describe('diffCrawlFinish', () => {
  it('flags unreachable entries and queues content-less ones', () => {
    const existing = [
      scraped('https://a.de/1'),
      scraped('https://a.de/2'),
      unscraped('https://a.de/new'),
    ];
    const r = diffCrawlFinish(existing, ['https://a.de/1', 'https://a.de/new']);
    expect(r.removedUrls).toBe(1);
    expect(r.results.find(e => e.loc === 'https://a.de/2')?.removedFromSource).toBe(true);
    expect(r.queue).toEqual(['https://a.de/new']);
    expect(r.newUrls).toBe(1);
  });

  it('does not flag errored URLs as removed', () => {
    const existing = [scraped('https://a.de/ok'), scraped('https://a.de/err')];
    const r = diffCrawlFinish(existing, ['https://a.de/ok'], ['https://a.de/err']);
    expect(r.removedUrls).toBe(0);
    expect(r.results.find(e => e.loc === 'https://a.de/err')?.removedFromSource).toBeUndefined();
  });

  it('revives entries that are reachable again', () => {
    const gone: ExistingEntry = { ...scraped('https://a.de/x'), removedFromSource: true };
    const r = diffCrawlFinish([gone], ['https://a.de/x']);
    expect(r.results[0].removedFromSource).toBeUndefined();
    expect(r.removedUrls).toBe(0);
  });
});
