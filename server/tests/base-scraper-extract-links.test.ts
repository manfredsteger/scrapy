import { describe, it, expect } from 'vitest';
import { JSDOM } from 'jsdom';
import { GenericScraper } from '../scrapers/generic-scraper';

// Aufgabe 1: extractLinks must delegate to normalizeCrawlUrl (single source of
// truth for link normalization) and therefore keep query parameters instead of
// stripping them. Losing query strings here caused the kita-bayern.de CGI
// results (which are only reachable via query params) to be silently dropped.
describe('BaseScraper.extractLinks', () => {
  it('keeps query parameters on discovered links', () => {
    const scraper = new GenericScraper('https://www.kita-bayern.de');
    const dom = new JSDOM(`
      <html><body>
        <a href="/cgi-bin/redaktion/suche_merkliste.pl?_Aktion=Suche&_Maske=_suche_n2&kreis=n">Nürnberg</a>
      </body></html>
    `);
    const links: string[] = (scraper as any).extractLinks(dom.window.document, 'https://www.kita-bayern.de/bt/index.html');
    expect(links).toHaveLength(1);
    const url = new URL(links[0]);
    expect(url.searchParams.get('kreis')).toBe('n');
    expect(url.searchParams.get('_Maske')).toBe('_suche_n2');
  });

  it('produces the same normalization as normalizeCrawlUrl (no second divergent path)', () => {
    const scraper = new GenericScraper('https://example.de');
    const dom = new JSDOM(`
      <html><body><a href="/x.php?b=2&a=1#frag">link</a></body></html>
    `);
    const links: string[] = (scraper as any).extractLinks(dom.window.document, 'https://example.de/page');
    expect(links).toEqual(['https://example.de/x.php?a=1&b=2']);
  });
});
