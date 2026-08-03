import { describe, it, expect } from 'vitest';
import { normalizeCrawlUrl } from '../crawl-url';

const PAGE = 'https://www.kitanetz.de/bayern/bayern.php';
const DOMAIN = 'www.kitanetz.de';

describe('normalizeCrawlUrl', () => {
  it('keeps content-bearing query params (kitanetz kreis links)', () => {
    const result = normalizeCrawlUrl(
      '/bezirke/bezirke.php?land=Bayern&kreis=Alt%C3%B6tting',
      PAGE, DOMAIN,
    );
    expect(result).toBe('https://www.kitanetz.de/bezirke/bezirke.php?kreis=Alt%C3%B6tting&land=Bayern');
  });

  it('produces identical URLs regardless of query key order', () => {
    const a = normalizeCrawlUrl('/x.php?land=Bayern&kreis=Dachau', PAGE, DOMAIN);
    const b = normalizeCrawlUrl('/x.php?kreis=Dachau&land=Bayern', PAGE, DOMAIN);
    expect(a).toBe(b);
  });

  it('canonicalizes repeated params by key then value', () => {
    const a = normalizeCrawlUrl('/x.php?filter=a&filter=b', PAGE, DOMAIN);
    const b = normalizeCrawlUrl('/x.php?filter=b&filter=a', PAGE, DOMAIN);
    expect(a).toBe(b);
    expect(a).toBe('https://www.kitanetz.de/x.php?filter=a&filter=b');
  });

  it('keeps query params on non-PHP URLs too', () => {
    const result = normalizeCrawlUrl('/search?q=kita&page=2', PAGE, DOMAIN);
    expect(result).toBe('https://www.kitanetz.de/search?page=2&q=kita');
  });

  it('strips tracking params but keeps content params', () => {
    const result = normalizeCrawlUrl(
      '/x.php?kreis=Dachau&utm_source=nl&fbclid=abc&gclid=1&PHPSESSID=xyz',
      PAGE, DOMAIN,
    );
    expect(result).toBe('https://www.kitanetz.de/x.php?kreis=Dachau');
  });

  it('keeps ambiguous keys like ref/source/sid (may be content-bearing)', () => {
    const result = normalizeCrawlUrl('/x.php?sid=42&ref=home', PAGE, DOMAIN);
    expect(result).toBe('https://www.kitanetz.de/x.php?ref=home&sid=42');
  });

  it('removes hash fragments', () => {
    expect(normalizeCrawlUrl('/a.php?b=1#top', PAGE, DOMAIN))
      .toBe('https://www.kitanetz.de/a.php?b=1');
  });

  it('skips external domains but allows subdomains', () => {
    expect(normalizeCrawlUrl('https://example.com/x', PAGE, DOMAIN)).toBeNull();
    expect(normalizeCrawlUrl('https://sub.www.kitanetz.de/x', PAGE, DOMAIN))
      .toBe('https://sub.www.kitanetz.de/x');
  });

  it('skips anchors, javascript, mailto, tel', () => {
    expect(normalizeCrawlUrl('#top', PAGE, DOMAIN)).toBeNull();
    expect(normalizeCrawlUrl('javascript:void(0)', PAGE, DOMAIN)).toBeNull();
    expect(normalizeCrawlUrl('mailto:a@b.de', PAGE, DOMAIN)).toBeNull();
    expect(normalizeCrawlUrl('tel:+491234', PAGE, DOMAIN)).toBeNull();
  });

  it('skips asset extensions and auth/admin/logout patterns', () => {
    expect(normalizeCrawlUrl('/foto.jpg', PAGE, DOMAIN)).toBeNull();
    expect(normalizeCrawlUrl('/wp-admin/options.php', PAGE, DOMAIN)).toBeNull();
    expect(normalizeCrawlUrl('/index.php?action=logout', PAGE, DOMAIN)).toBeNull();
    expect(normalizeCrawlUrl('/mod/x.php?sesskey=abc', PAGE, DOMAIN)).toBeNull();
  });

  it('enforces Moodle id requirements for view.php/mod.php', () => {
    expect(normalizeCrawlUrl('/mod/page/view.php', PAGE, DOMAIN)).toBeNull();
    expect(normalizeCrawlUrl('/mod/page/view.php?id=12', PAGE, DOMAIN))
      .toBe('https://www.kitanetz.de/mod/page/view.php?id=12');
    expect(normalizeCrawlUrl('/admin2/mod.php', PAGE, DOMAIN)).toBeNull();
  });

  it('keeps pagination params (go/page) so multi-page lists are discovered', () => {
    const result = normalizeCrawlUrl(
      '/bezirke/bezirke.php?go=2&land=Bayern&kreis=Alt%C3%B6tting',
      PAGE, DOMAIN,
    );
    expect(result).toBe('https://www.kitanetz.de/bezirke/bezirke.php?go=2&kreis=Alt%C3%B6tting&land=Bayern');
  });
});
