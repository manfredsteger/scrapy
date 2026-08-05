// Detects "soft 404s": pages that respond with HTTP 200 but whose body is
// really an error/not-found page. Some sources (old CGI/Perl backends in
// particular) never return a real 4xx status, so a `!response.ok` check
// alone lets empty error pages through as if they were real content.
//
// Kept deliberately conservative — a filter that's too aggressive would
// throw away genuine short pages. Two independent signals:
//   1. A generic heuristic (small body + a "not found"-ish heading) that
//      applies to any source.
//   2. An optional per-scraper hook (`BaseScraper.softNotFound`) for
//      sources with a known, more precise error-page marker.
export type SoftNotFoundHook = (doc: Document, html: string) => boolean;

const NOT_FOUND_HEADING_PATTERN = /seite nicht gefunden|page not found|404|nicht verfügbar/i;
const MAX_SOFT_404_BODY_BYTES = 4096;

export function detectSoftNotFound(doc: Document, html: string, sourceHook?: SoftNotFoundHook): boolean {
  if (sourceHook && sourceHook(doc, html)) {
    return true;
  }

  if (Buffer.byteLength(html, 'utf-8') >= MAX_SOFT_404_BODY_BYTES) {
    return false;
  }

  let matched = false;
  doc.querySelectorAll('h1, h2').forEach(heading => {
    if (matched) return;
    if (NOT_FOUND_HEADING_PATTERN.test(heading.textContent ?? '')) {
      matched = true;
    }
  });

  return matched;
}
