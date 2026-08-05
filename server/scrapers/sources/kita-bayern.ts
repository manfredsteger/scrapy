// Source definition for kita-bayern.de's CGI list endpoint
// (suche_merkliste.pl). Built on top of CgiListScraper (Aufgabe 6).
//
// The table markup on this source is irregular enough (rows sometimes
// missing a <small> block, JS marker blocks that don't line up 1:1 with
// table rows) that regex extraction on the raw HTML is more robust than
// DOM querying here — this mirrors how the row data is actually laid out
// in the page (a JS block with the full address+coordinates, separate from
// the <tr> that carries phone/träger/age-group data, joined by slug).

export const KITA_BAYERN_KREIS: Record<string, string> = {
  a: 'Augsburg', ab: 'Aschaffenburg', 'ab-l': 'Landkreis Aschaffenburg',
  an: 'Ansbach', 'ba-l': 'Landkreis Bamberg', bt: 'Bayreuth',
  'bt-l': 'Landkreis Bayreuth', don: 'Donau-Ries', er: 'Erlangen',
  erh: 'Erlangen-Höchstadt', ffb: 'Fürstenfeldbruck', fo: 'Forchheim',
  fs: 'Freising', fue: 'Fürth', 'fue-l': 'Landkreis Fürth', ho: 'Hof',
  in: 'Ingolstadt', ku: 'Kulmbach', lau: 'Nürnberger Land',
  ll: 'Landsberg am Lech', m: 'München', 'm-l': 'Landkreis München',
  mb: 'Miesbach', n: 'Nürnberg', nm: 'Neumarkt i.d.OPf.',
  paf: 'Pfaffenhofen a.d.Ilm', r: 'Regensburg', rh: 'Roth', sc: 'Schwabach',
  sr: 'Straubing', 'sr-l': 'Straubing-Bogen', sta: 'Starnberg',
  toel: 'Bad Tölz-Wolfratshausen', wue: 'Würzburg', wug: 'Weißenburg-Gunzenhausen',
};

// Codes without an -l counterpart, where city/Landkreis isn't derivable from
// the code alone. The real city is on each individual entry regardless.
export const KITA_BAYERN_AMBIGUOUS_KREIS = new Set([
  'fo', 'ho', 'ku', 'r', 'don', 'rh', 'sta', 'toel', 'wug', 'erh', 'mb', 'lau', 'll', 'fs', 'paf',
]);

// These 7 kreis codes legitimately return 0 rows on this source — not an
// error, don't retry / don't flag as a scrape failure.
export const KITA_BAYERN_ZERO_ROW_KREIS = new Set(['fs', 'in', 'paf', 'rh', 'sr-l', 'sta', 'wug']);

const BASE_URL = 'https://www.kita-bayern.de';

export function buildKitaBayernSeedUrls(): string[] {
  return Object.keys(KITA_BAYERN_KREIS).map(k =>
    `${BASE_URL}/cgi-bin/redaktion/suche_merkliste.pl?_Aktion=Suche&_Maske=_suche_allgemein&kreis=${k}&_sort=strasse`
  );
}

export interface KitaBayernRow {
  sourceSlug: string;
  sourceUrl: string;
  kreisCode: string;
  kreisLabel: string;
  kreisLabelAmbiguous: boolean;
  name: string;
  traeger: string;
  street: string;
  streetNumber: string;
  zipCode: string;
  city: string;
  latitude: number | null;
  longitude: number | null;
  phoneRaw: string;
  phone: string; phoneInfo: string;
  phone2: string; phoneInfo2: string;
  phone3: string; phoneInfo3: string;
  phone4: string; phoneInfo4: string;
  phone5: string; phoneInfo5: string;
  ageU3: boolean | null;
  age3to6: boolean | null;
  ageSchool: boolean | null;
}

function decodeHtmlEntities(s: string): string {
  return s
    .replace(/&auml;/g, 'ä').replace(/&ouml;/g, 'ö').replace(/&uuml;/g, 'ü')
    .replace(/&Auml;/g, 'Ä').replace(/&Ouml;/g, 'Ö').replace(/&Uuml;/g, 'Ü')
    .replace(/&szlig;/g, 'ß').replace(/&amp;/g, '&').replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#39;/g, "'").replace(/&quot;/g, '"');
}

function clean(s: string): string {
  return decodeHtmlEntities(s.replace(/<[^>]+>/g, '')).replace(/\s+/g, ' ').trim();
}

// 'Albert-Einstein-Ring 53' -> ['Albert-Einstein-Ring', '53']
function splitStreet(addr: string): [string, string] {
  const m = addr.trim().match(/^(.*?)[\s,]+(\d+\s*[a-zA-Z]?(?:\s*[-/]\s*\d+\s*[a-zA-Z]?)?)$/);
  if (!m) return [addr.trim(), ''];
  return [m[1].trim().replace(/[\s,]+$/, ''), m[2].replace(/\s+/g, '')];
}

// Source placeholders that are not a phone number.
const PLACEHOLDER = /^\s*(k\.\s*A\.?|-+|n\.\s*n\.?|siehe\s+website)\s*$/i;

// One number: starts with '(' or a digit, followed by digits/separators.
const NUM_PATTERN = /\(?\d[\d\s/()-]{4,}\d/g;

// '(09 21) 51 37 30' / '0921/990090' / '0921-745416' -> '0921 51373 0'-shape.
// The area code always precedes '(', '/', or '-' on this source.
function splitNumber(s: string): string {
  const paren = s.match(/\((.*?)\)\s*(.*)$/);
  let area: string, rest: string;
  if (paren) {
    area = paren[1]; rest = paren[2];
  } else if (s.includes('/')) {
    [area, rest] = s.split('/', 2) as [string, string];
    rest = s.slice(s.indexOf('/') + 1);
  } else if (s.includes('-')) {
    area = s.slice(0, s.indexOf('-'));
    rest = s.slice(s.indexOf('-') + 1);
  } else if (/^\s*0[\d\s]*?\d\s+\d/.test(s)) {
    const parts = s.trim().split(/\s+/);
    area = parts[0];
    rest = parts.slice(1).join(' ');
  } else {
    return s.replace(/\D/g, '');
  }
  const a = area.replace(/\D/g, '');
  const b = rest.replace(/\D/g, '');
  return a && b ? `${a} ${b}` : s.replace(/\D/g, '');
}

interface ParsedPhone { number: string; info: string; }

// A cell can contain several labeled numbers ('Büro: 0921-745, Krippe: 0921-746').
function extractPhones(raw: string): ParsedPhone[] {
  if (!raw || PLACEHOLDER.test(raw)) return [];
  const out: ParsedPhone[] = [];
  let pos = 0;
  let m: RegExpExecArray | null;
  NUM_PATTERN.lastIndex = 0;
  while ((m = NUM_PATTERN.exec(raw)) !== null) {
    if (m[0].replace(/\D/g, '').length < 6) continue;
    let label = raw.slice(pos, m.index).trim().replace(/^[\s:,;.-]+|[\s:,;.-]+$/g, '');
    pos = m.index + m[0].length;
    let num = splitNumber(m[0]);
    if (!num) continue;
    // 'oder'/'bzw.'/'und' is not a label but an enumeration: the following
    // number shares the previous one's area code.
    if (/^(oder|bzw\.?|und|u\.|sowie)$/i.test(label)) label = '';
    if (out.length > 0 && !num.includes(' ') && !num.startsWith('0')) {
      const area = out[out.length - 1].number.split(' ')[0];
      if (area) num = `${area} ${num}`;
    }
    if (out.some(p => p.number === num)) continue;
    out.push({ number: num.slice(0, 32), info: label.slice(0, 32) });
  }
  return out;
}

function ageFlag(cellText: string): boolean | null {
  const t = clean(cellText);
  if (t === 'Ja') return true;
  if (t === 'Nein') return false;
  return null;
}

const BAVARIA_BOUNDS = { latMin: 47.2, latMax: 50.6, lonMin: 8.9, lonMax: 13.9 };

export function isWithinBavaria(lat: number, lon: number): boolean {
  return lat >= BAVARIA_BOUNDS.latMin && lat <= BAVARIA_BOUNDS.latMax &&
    lon >= BAVARIA_BOUNDS.lonMin && lon <= BAVARIA_BOUNDS.lonMax;
}

export interface ParseKitaBayernOptions {
  kreisCode: string;
  observedAt: string; // ISO date, e.g. '2026-08-05'
  onWarning?: (message: string) => void;
}

// Parses one kreis result page (raw HTML, as fetched — this source mixes
// ISO-8859-1 and UTF-8 across pages, so callers must decode via
// server/utils/decode-response.ts before calling this).
export function parseKitaBayernPage(html: string, opts: ParseKitaBayernOptions): KitaBayernRow[] {
  const { kreisCode, observedAt } = opts;
  const warn = opts.onWarning ?? (() => {});
  const evidenceUrl = `${BASE_URL}/cgi-bin/redaktion/suche_merkliste.pl?_Aktion=Suche&_Maske=_suche_allgemein&kreis=${kreisCode}&_sort=strasse`;

  // 1) JS markers: full address + coordinates, keyed by link slug.
  const markers = new Map<string, { text: string; lat: number; lon: number }>();
  const markerPattern = /var text = '(.*?)';\s*var link = '(.*?)';\s*showFrontendMarker\(\s*([-\d.]+)\s*,\s*([-\d.]+)\s*,\s*'(.*?)'/gs;
  let mm: RegExpExecArray | null;
  while ((mm = markerPattern.exec(html)) !== null) {
    const [, txt, link, latStr, lonStr] = mm;
    const slug = link.replace(/^\/\.\/|\/index\.html$/g, '');
    markers.set(slug, { text: txt, lat: parseFloat(latStr), lon: parseFloat(lonStr) });
  }

  // 2) Table rows: phone, träger, age groups. Whitespace inside <tr> varies
  // by _Maske, so match tolerantly.
  const rows: KitaBayernRow[] = [];
  const trPattern = /<tr[^>]*\bdata-latlon="[^"]*"[^>]*>.*?<\/tr>/gs;
  let tm: RegExpExecArray | null;
  while ((tm = trPattern.exec(html)) !== null) {
    const tr = tm[0];
    const linkMatch = tr.match(/href="\/\.\/([^"]+?)\/index\.html"/);
    if (!linkMatch) continue;
    const slug = linkMatch[1];

    const tds = Array.from(tr.matchAll(/<td[^>]*>(.*?)<\/td>/gs)).map(x => x[1]);
    const smalls = tds.length > 0 ? Array.from(tds[0].matchAll(/<small>(.*?)<\/small>/gs)).map(x => x[1]) : [];
    const nameMatch = tr.match(/target="_blank">(.*?)<\/a>/s);
    const traegerMatch = tr.match(/Tr&auml;ger:\s*(.*?)<br/s);

    const marker = markers.get(slug);
    let lat: number | null = marker?.lat ?? null;
    let lon: number | null = marker?.lon ?? null;
    if (lat === null) {
      // Fallback: coordinates also live on the <tr> itself.
      // NOTE: '-' here is a separator, not a sign.
      const llMatch = tr.match(/data-latlon="latlon-(\d+\.\d+)-(\d+\.\d+)"/);
      if (llMatch) {
        lat = parseFloat(llMatch[1]);
        lon = parseFloat(llMatch[2]);
      }
    }

    let street = '', streetNumber = '', zipCode = '', city = '';
    if (marker?.text) {
      // 'Albert-Einstein-Ring 53, 95448 Bayreuth'
      const addrMatch = clean(marker.text).match(/^(.*),\s*(\d{5})\s+(.*)$/);
      if (addrMatch) {
        [street, streetNumber] = splitStreet(addrMatch[1]);
        zipCode = addrMatch[2];
        city = addrMatch[3].trim();
      } else {
        [street, streetNumber] = splitStreet(clean(marker.text));
        warn(`${slug}: Adresse ohne PLZ/Ort -> ${clean(marker.text)}`);
      }
    } else {
      const addr = smalls[0] ? clean(smalls[0]) : '';
      [street, streetNumber] = splitStreet(addr);
      warn(`${slug}: kein JS-Marker (keine PLZ/Ort/Koordinaten)`);
    }

    const phoneRaw = smalls.length > 1 ? clean(smalls[1]) : '';
    const phones = extractPhones(phoneRaw);
    if (phones.length > 5) {
      warn(`${slug}: ${phones.length} Nummern, nur 5 Slots -> Rest verworfen`);
    }
    const pslots: Record<string, string> = {};
    phones.slice(0, 5).forEach((p, i) => {
      const sfx = i === 0 ? '' : String(i + 1);
      pslots[`phone${sfx}`] = p.number;
      pslots[`phoneInfo${sfx}`] = p.info;
    });
    for (let i = 1; i <= 5; i++) {
      const sfx = i === 1 ? '' : String(i);
      if (pslots[`phone${sfx}`] === undefined) pslots[`phone${sfx}`] = '';
      if (pslots[`phoneInfo${sfx}`] === undefined) pslots[`phoneInfo${sfx}`] = '';
    }

    if (lat !== null && lon !== null && !isWithinBavaria(lat, lon)) {
      warn(`${slug}: Koordinate ausserhalb Bayern (${lat}, ${lon})`);
    }

    rows.push({
      sourceSlug: slug,
      sourceUrl: `${BASE_URL}/${slug}/index.html`,
      kreisCode,
      kreisLabel: KITA_BAYERN_KREIS[kreisCode] ?? kreisCode,
      kreisLabelAmbiguous: KITA_BAYERN_AMBIGUOUS_KREIS.has(kreisCode),
      name: nameMatch ? clean(nameMatch[1]) : '',
      traeger: traegerMatch ? clean(traegerMatch[1]) : '',
      street, streetNumber, zipCode, city,
      latitude: lat, longitude: lon,
      phoneRaw,
      phone: pslots.phone, phoneInfo: pslots.phoneInfo,
      phone2: pslots.phone2, phoneInfo2: pslots.phoneInfo2,
      phone3: pslots.phone3, phoneInfo3: pslots.phoneInfo3,
      phone4: pslots.phone4, phoneInfo4: pslots.phoneInfo4,
      phone5: pslots.phone5, phoneInfo5: pslots.phoneInfo5,
      ageU3: tds.length > 2 ? ageFlag(tds[2]) : null,
      age3to6: tds.length > 3 ? ageFlag(tds[3]) : null,
      ageSchool: tds.length > 4 ? ageFlag(tds[4]) : null,
    });
  }

  return rows;
}

// This source is `www.kita-bayern.de`. Row-level extraction is intentionally
// specific (not part of the generic CgiListScraper) because the field names
// and phone/age parsing rules only make sense for this source's schema.
export function isKitaBayernUrl(url: string): boolean {
  try {
    return new URL(url).hostname.endsWith('kita-bayern.de');
  } catch {
    return false;
  }
}

// Marker for this source's soft-404 page (search result page rendered for a
// kreis/query that hit no editorial content, e.g. bt/suche1.html — HTTP 200,
// but the body is an empty-result shell, not a listing or a real page).
export function kitaBayernSoftNotFound(doc: Document, html: string): boolean {
  if (doc.querySelector('.error_online') !== null) return true;
  // No result rows and no JS marker block => an empty/error result page,
  // not a real content page.
  const hasRows = /<tr[^>]*\bdata-latlon="[^"]*"[^>]*>/.test(html);
  const hasMarkers = /showFrontendMarker\(/.test(html);
  if (!hasRows && !hasMarkers && Buffer.byteLength(html, 'utf-8') < 8192) {
    return /keine\s+(einrichtung|treffer|ergebnisse)/i.test(html) || /nichts\s+gefunden/i.test(html);
  }
  return false;
}
