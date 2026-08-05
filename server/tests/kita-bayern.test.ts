import { describe, it, expect } from "vitest";
import { parseKitaBayernPage, isWithinBavaria, buildKitaBayernSeedUrls, KITA_BAYERN_ZERO_ROW_KREIS } from "../scrapers/sources/kita-bayern";

// Minimal synthetic fixtures mirroring the real page structure (JS marker
// block + a <tr data-latlon="..."> with phone/träger/age-group cells),
// since we can't ship a live-fetched fixture. Field values match the shape
// seen in kita-bayern-basisliste.json.
function pageWithMarker(opts: {
  slug: string; lat: number; lon: number; addr: string;
  name: string; traeger: string; phone: string; ages: [string, string, string];
}): string {
  const { slug, lat, lon, addr, name, traeger, phone, ages } = opts;
  return `
    <html><body>
    <script>
      var text = '${addr}';
      var link = '/./${slug}';
      showFrontendMarker(${lat}, ${lon}, 'marker-${slug}');
    </script>
    <table>
      <tr data-latlon="latlon-${lat}-${lon}">
        <td>
          <a href="/./${slug}/index.html" target="_blank">${name}</a>
          <small>${addr}</small>
          <small>${phone}</small>
          Tr&auml;ger: ${traeger}<br>
        </td>
        <td></td>
        <td>${ages[0]}</td>
        <td>${ages[1]}</td>
        <td>${ages[2]}</td>
      </tr>
    </table>
    </body></html>`;
}

describe("parseKitaBayernPage", () => {
  it("parses a standard row: address, coordinates from JS marker, single phone, age flags", () => {
    const html = pageWithMarker({
      slug: 'a/krippe-kiku-wellenburg', lat: 48.3342, lon: 10.82593,
      addr: 'Wellenburg 5, 86199 Augsburg',
      name: 'Krippe Kiku Wellenburg', traeger: 'Kinderzentrum Kunterbunt gGmbH',
      phone: '', ages: ['Ja', 'Nein', 'Nein'],
    });
    const rows = parseKitaBayernPage(html, { kreisCode: 'a', observedAt: '2026-08-05' });
    expect(rows).toHaveLength(1);
    const r = rows[0];
    expect(r.sourceSlug).toBe('a/krippe-kiku-wellenburg');
    expect(r.street).toBe('Wellenburg');
    expect(r.streetNumber).toBe('5');
    expect(r.zipCode).toBe('86199');
    expect(r.city).toBe('Augsburg');
    expect(r.latitude).toBeCloseTo(48.3342);
    expect(r.longitude).toBeCloseTo(10.82593);
    expect(r.name).toBe('Krippe Kiku Wellenburg');
    expect(r.traeger).toBe('Kinderzentrum Kunterbunt gGmbH');
    expect(r.ageU3).toBe(true);
    expect(r.age3to6).toBe(false);
    expect(r.ageSchool).toBe(false);
  });

  it("parses a single phone number with area code before the separator", () => {
    const html = pageWithMarker({
      slug: 'ab-l/westerngrund', lat: 50.12026, lon: 9.2419565,
      addr: 'Huckelheimer Straße 11, 63825 Westerngrund',
      name: 'Kath. Kindergarten Westerngrund', traeger: 'St. Hildegardverein Westerngrund e. V.',
      phone: '(0 60 24) 37 13', ages: ['Ja', 'Ja', 'Ja'],
    });
    const rows = parseKitaBayernPage(html, { kreisCode: 'ab-l', observedAt: '2026-08-05' });
    expect(rows[0].phone).toBe('06024 3713');
    expect(rows[0].phoneInfo).toBe('');
  });

  it("parses multiple labeled phone numbers, with 'oder' inheriting the area code", () => {
    const html = pageWithMarker({
      slug: 'x/kita-mehrfach', lat: 49.0, lon: 11.0,
      addr: 'Teststraße 1, 90000 Teststadt',
      name: 'Kita Mehrfach', traeger: 'Traeger e.V.',
      phone: 'B&uuml;ro: 0921-745416 oder 745417, Krippe: 0921-745999',
      ages: ['Ja', 'Nein', 'Nein'],
    });
    const rows = parseKitaBayernPage(html, { kreisCode: 'x', observedAt: '2026-08-05' });
    const r = rows[0];
    expect(r.phone).toBe('0921 745416');
    expect(r.phone2).toBe('0921 745417');
    expect(r.phone3).toBe('0921 745999');
    expect(r.phoneInfo3).toBe('Krippe');
  });

  it("treats placeholders ('k. A.') as no phone number", () => {
    const html = pageWithMarker({
      slug: 'x/kita-ka', lat: 49.0, lon: 11.0,
      addr: 'Teststraße 2, 90000 Teststadt',
      name: 'Kita KA', traeger: 'Traeger e.V.',
      phone: 'k. A.', ages: ['Nein', 'Ja', 'Nein'],
    });
    const rows = parseKitaBayernPage(html, { kreisCode: 'x', observedAt: '2026-08-05' });
    expect(rows[0].phone).toBe('');
  });

  it("falls back to the <tr> data-latlon attribute when no JS marker exists, treating '-' as a separator not a sign", () => {
    const html = `
      <html><body>
      <table>
        <tr data-latlon="latlon-49.92329-11.5975">
          <td>
            <a href="/./x/kita-no-marker/index.html" target="_blank">Kita ohne Marker</a>
            <small>Teststraße 3</small>
            <small></small>
            Tr&auml;ger: Traeger e.V.<br>
          </td>
          <td></td>
          <td>Ja</td><td>Nein</td><td>Nein</td>
        </tr>
      </table>
      </body></html>`;
    const rows = parseKitaBayernPage(html, { kreisCode: 'x', observedAt: '2026-08-05' });
    expect(rows).toHaveLength(1);
    expect(rows[0].latitude).toBeCloseTo(49.92329);
    expect(rows[0].longitude).toBeCloseTo(11.5975);
    expect(isWithinBavaria(rows[0].latitude!, rows[0].longitude!)).toBe(true);
  });

  it("flags coordinates outside the Bavaria bounding box via a warning callback", () => {
    const html = pageWithMarker({
      slug: 'x/kita-outside', lat: 60.0, lon: 11.0,
      addr: 'Teststraße 4, 90000 Teststadt',
      name: 'Kita Outside', traeger: 'Traeger e.V.',
      phone: '', ages: ['Ja', 'Nein', 'Nein'],
    });
    const warnings: string[] = [];
    parseKitaBayernPage(html, { kreisCode: 'x', observedAt: '2026-08-05', onWarning: (m) => warnings.push(m) });
    expect(warnings.some(w => w.includes('ausserhalb Bayern'))).toBe(true);
  });
});

describe("buildKitaBayernSeedUrls", () => {
  it("generates 35 seed URLs, one per kreis code, with the _Maske param", () => {
    const urls = buildKitaBayernSeedUrls();
    expect(urls).toHaveLength(35);
    expect(urls.every(u => u.includes('_Maske=_suche_allgemein'))).toBe(true);
    expect(urls.some(u => u.includes('kreis=n&'))).toBe(true);
    expect(urls.some(u => u.includes('kreis=er&'))).toBe(true);
  });

  it("marks the 7 known zero-row kreise so they aren't retried as errors", () => {
    expect(KITA_BAYERN_ZERO_ROW_KREIS.size).toBe(7);
    expect(KITA_BAYERN_ZERO_ROW_KREIS.has('fs')).toBe(true);
  });
});
