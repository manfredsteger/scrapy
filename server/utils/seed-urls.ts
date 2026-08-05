import { decodeResponse } from "./decode-response";
import type { ProjectSettings } from "@shared/schema";

// Resolves the full set of seed URLs for a crawl start: explicit seedUrls
// plus anything generated from seedTemplate (a URL template filled in with
// either a fixed value list or values scraped from a <select> element).
//
// Note: on some sources (e.g. kita-bayern.de's kreis dropdown) the <option>
// elements have no `value` attribute at all, so the option's value must
// fall back to its text content — handled below.
export async function resolveSeedUrls(scraping: ProjectSettings['scraping'] | undefined): Promise<string[]> {
  const explicit = scraping?.seedUrls ?? [];
  const template = scraping?.seedTemplate;
  if (!template) return explicit;

  let values = template.values ?? [];
  if (template.valuesFromSelect) {
    try {
      const generated = await fetchSelectOptionValues(
        template.valuesFromSelect.url,
        template.valuesFromSelect.selectName,
      );
      const exclude = new Set(template.valuesFromSelect.exclude ?? []);
      values = generated.filter(v => !exclude.has(v));
    } catch (err) {
      console.error(`[SeedUrls] Failed to load <select> options from ${template.valuesFromSelect.url}:`, (err as Error).message);
    }
  }

  const generatedUrls = values.map(v => template.urlTemplate.replace('{value}', encodeURIComponent(v)));
  return Array.from(new Set([...explicit, ...generatedUrls]));
}

async function fetchSelectOptionValues(url: string, selectName: string): Promise<string[]> {
  const { JSDOM } = await import("jsdom");
  const response = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; MapScraperPro/1.0)' },
    signal: AbortSignal.timeout(15000),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const html = await decodeResponse(response);
  const dom = new JSDOM(html);
  const select = dom.window.document.querySelector(`select[name="${selectName}"]`);
  if (!select) throw new Error(`No <select name="${selectName}"> found`);
  return Array.from(select.querySelectorAll('option'))
    // Some sources omit the `value` attribute entirely; fall back to the
    // visible text content in that case.
    .map(opt => opt.getAttribute('value') || opt.textContent?.trim() || '')
    .filter(Boolean);
}
