import { JSDOM } from "jsdom";
import { BaseScraper } from "./base-scraper";
import type { ScraperResult, WebsiteType } from "./base-scraper";

// Generic reusable pattern for CGI/PHP/ASP endpoints that return list pages
// where each row is a full record — the classic "old backend search form"
// shape (an enum query param whose values come from a <select>, one <tr>
// per matched record). Does NOT contain any source-specific field mapping;
// that lives in a per-source config layered on top (see
// server/scrapers/sources/*.ts), consulted by the content-extraction
// dispatch the same way the Moodle special case works today.
//
// The ScraperResult contract stays exactly as for every other scraper type:
// row data goes under structuredData.rows so downstream consumers that only
// know about the generic shape still get something useful.
export class CgiListScraper extends BaseScraper {
  get type(): WebsiteType {
    return 'cgi-list';
  }

  scrapePageContent(html: string, url: string): ScraperResult {
    const dom = new JSDOM(html, { url });
    const doc = dom.window.document;

    const title = this.extractTitle(doc);
    const rows = this.extractRows(doc);
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

  // Generic row extraction: every <tr> with at least one <td> becomes a
  // record of { <column index as string>: cell text }. Source-specific
  // scrapers built on top of this class (e.g. KitaBayernScraper) override
  // this method to return properly-named fields instead.
  protected extractRows(doc: Document): Record<string, string>[] {
    const rows: Record<string, string>[] = [];
    doc.querySelectorAll('tr').forEach(tr => {
      const cells = Array.from(tr.querySelectorAll('td'));
      if (cells.length === 0) return;
      const row: Record<string, string> = {};
      cells.forEach((cell, i) => {
        row[String(i)] = cell.textContent?.trim() ?? '';
      });
      rows.push(row);
    });
    return rows;
  }
}
