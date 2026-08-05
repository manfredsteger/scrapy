import { JSDOM } from "jsdom";
import { CgiListScraper } from "./cgi-list-scraper";
import type { ScraperResult } from "./base-scraper";
import { parseKitaBayernPage, kitaBayernSoftNotFound } from "./sources/kita-bayern";

// Source-specific scraper for kita-bayern.de's suche_merkliste.pl list
// endpoint. Row extraction/field mapping lives in sources/kita-bayern.ts;
// this class just wires it into the BaseScraper/CgiListScraper contract.
export class KitaBayernScraper extends CgiListScraper {
  scrapePageContent(html: string, url: string): ScraperResult {
    const dom = new JSDOM(html, { url });
    const doc = dom.window.document;

    let kreisCode = '';
    try {
      kreisCode = new URL(url).searchParams.get('kreis') || '';
    } catch {
      // leave empty; parseKitaBayernPage still works, just without a kreis label
    }

    const warnings: string[] = [];
    const rows = parseKitaBayernPage(html, {
      kreisCode,
      observedAt: new Date().toISOString().slice(0, 10),
      onWarning: (msg) => warnings.push(msg),
    });
    if (warnings.length > 0) {
      console.log(`[KitaBayernScraper] ${url}: ${warnings.length} warning(s): ${warnings.slice(0, 5).join(' | ')}`);
    }

    const title = doc.title || url;
    const images = this.extractImages(doc, url);
    const videos = this.extractVideos(doc, url);
    const links = this.extractLinks(doc, url);

    return {
      url,
      title,
      content: [],
      images,
      videos,
      links,
      structuredData: { rows } as any,
    };
  }

  softNotFound(doc: Document, html: string): boolean {
    return kitaBayernSoftNotFound(doc, html);
  }
}
