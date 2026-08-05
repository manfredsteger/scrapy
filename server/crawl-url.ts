// URL normalization for crawl link discovery.
// Keeps content-bearing query params (e.g. kitanetz bezirke.php?land=...&kreis=...),
// strips only known tracking/session params, and normalizes for stable dedup.

// URL patterns to skip (auth, admin, resources, etc.)
const SKIP_PATTERNS = [
  '/login/', '/auth/', '/admin/', '/user/profile',
  '/message/', '/calendar/', '/blocks/', '/theme/',
  '/lib/', '/pluginfile.php', 'sesskey=', 'download.moodle.org',
  '/wp-login', '/wp-admin', '?action=logout', '&action=logout',
];

// Blocklist: tracking, analytics, and session params that create duplicate URLs.
// Deliberately narrow — ambiguous keys like `ref`, `source`, or `sid` can be
// content-bearing on some sites and are therefore kept.
const TRACKING_PARAMS = new Set([
  'utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content', 'utm_id',
  'fbclid', 'gclid', 'gclsrc', 'dclid', 'msclkid', 'twclid', 'igshid',
  'mc_cid', 'mc_eid',
  'sessionid', 'session_id', 'phpsessid', 'jsessionid', 'sesskey',
  '_ga', '_gl', 'wt_mc', 'pk_campaign', 'pk_kwd', 'cachebuster',
]);

const SKIPPED_EXTENSIONS = /\.(pdf|jpg|jpeg|png|gif|svg|css|js|zip|tar|gz|ico|woff|woff2|ttf|eot)$/i;

/**
 * Resolve and normalize an internal link discovered while crawling.
 * Returns the normalized absolute URL, or null when the link should be skipped.
 */
export function normalizeCrawlUrl(href: string, pageUrl: string, domain: string): string | null {
  if (!href) return null;
  if (href.startsWith('#') || href.startsWith('javascript:') ||
      href.startsWith('mailto:') || href.startsWith('tel:')) return null;

  let resolvedUrl: string;
  let urlDomain: string;
  try {
    resolvedUrl = new URL(href, pageUrl).href;
    urlDomain = new URL(resolvedUrl).hostname;
  } catch {
    return null;
  }

  // Only include links from the same domain (subdomains allowed)
  if (urlDomain !== domain && !urlDomain.endsWith('.' + domain)) return null;

  // Skip file extensions we don't want
  if (SKIPPED_EXTENSIONS.test(resolvedUrl)) return null;

  // Skip auth/admin/resource URLs
  if (SKIP_PATTERNS.some(pattern => resolvedUrl.includes(pattern))) return null;

  // Remove hash fragment only, keep query params (important for Moodle, PHP sites)
  const cleanUrl = resolvedUrl.split('#')[0];

  let urlObj: URL;
  try {
    urlObj = new URL(cleanUrl);
  } catch {
    return null;
  }
  const pathname = urlObj.pathname;

  // Skip Moodle PHP files that require params but don't have them
  if (pathname.endsWith('/view.php') && !urlObj.searchParams.has('id')) return null;
  if (pathname.endsWith('/mod.php') && !urlObj.searchParams.has('id')) return null;

  // Skip CGI search-mask requests missing the internal editorial mask param
  // (bare suche.pl calls are an internal-tooling entry point, not content).
  if (pathname.endsWith('/suche.pl') && !urlObj.searchParams.has('_Maske')) return null;
  // Skip editorial "awaiting release" pages — internal workflow state, not
  // public content.
  if (resolvedUrl.includes('freigabewarten')) return null;

  const kept: Array<[string, string]> = [];
  urlObj.searchParams.forEach((value, key) => {
    if (!TRACKING_PARAMS.has(key.toLowerCase())) kept.push([key, value]);
  });
  // Sort by key, then value, so param order never creates duplicate URLs
  kept.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0));
  const newParams = new URLSearchParams();
  kept.forEach(([key, value]) => newParams.append(key, value));
  urlObj.search = newParams.toString();

  const result = urlObj.href;
  if (!result || result.endsWith('/manifest.json')) return null;
  return result;
}
