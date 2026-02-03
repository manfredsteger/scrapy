import { JSDOM } from "jsdom";
import { BaseScraper } from "./base-scraper";
import type { ScraperResult, ScraperOptions, WebsiteType } from "./base-scraper";
import type { ScrapedElement } from "@shared/schema";

export class WikiJsScraper extends BaseScraper {
  get type(): WebsiteType {
    return 'wikijs';
  }

  scrapePageContent(html: string, url: string): ScraperResult {
    const dom = new JSDOM(html);
    const doc = dom.window.document;

    const title = this.extractTitle(doc);
    const content = this.extractWikiContent(doc);
    const images = this.extractImages(doc, url);
    const videos = this.extractVideos(doc, url);
    const links = this.extractLinks(doc, url);
    const structuredData = this.options.extractStructuredData 
      ? this.extractStructuredData(doc) 
      : undefined;

    return {
      url,
      title,
      content,
      images,
      videos,
      links: links.filter(link => this.isInternalLink(link)),
      structuredData,
    };
  }

  private extractWikiContent(doc: Document): ScrapedElement[] {
    const elements: ScrapedElement[] = [];

    const contentSelectors = [
      'div.contents',
      'article.contents',
      '.contents-wrapper .contents',
      'main .contents',
      '#page-content',
      '.page-content',
      'article',
      'main',
      '.markdown-body',
      '.v-main__wrap article',
    ];

    let mainContent: Element | null = null;
    for (const selector of contentSelectors) {
      try {
        const el = doc.querySelector(selector);
        if (el && el.textContent && el.textContent.trim().length > 50) {
          mainContent = el;
          break;
        }
      } catch {}
    }

    if (!mainContent) {
      mainContent = doc.body;
    }

    const skipTags = new Set(['script', 'style', 'noscript', 'nav', 'header', 'footer', 'aside', 'iframe', 'svg', 'form']);
    const skipClasses = new Set([
      'navigation', 'nav', 'navbar', 'menu', 'sidebar', 'side-nav', 'sidenav',
      'breadcrumb', 'breadcrumbs', 'toc', 'table-of-contents', 'page-toc',
      'footer', 'header', 'v-navigation-drawer', 'v-app-bar',
    ]);

    const shouldSkip = (el: Element): boolean => {
      const tag = el.tagName?.toLowerCase();
      if (skipTags.has(tag)) return true;

      const classList = el.className?.toLowerCase?.() || '';
      const skipClassesArr = Array.from(skipClasses);
      for (let i = 0; i < skipClassesArr.length; i++) {
        if (classList.includes(skipClassesArr[i])) return true;
      }

      if (el.getAttribute('role') === 'navigation') return true;
      return false;
    };

    const processNode = (node: Node) => {
      if (node.nodeType !== 1) return;

      const el = node as Element;
      const tag = el.tagName?.toLowerCase();

      if (shouldSkip(el)) return;

      if (tag && tag.match(/^h[1-6]$/)) {
        const text = el.textContent?.trim() || '';
        if (text && text.length > 1) {
          elements.push({
            type: 'heading',
            tag,
            content: text,
            level: parseInt(tag[1]),
          });
        }
      } else if (tag === 'p') {
        const text = el.textContent?.trim() || '';
        if (text && text.length > 5) {
          elements.push({ type: 'paragraph', content: text });
        }
      } else if (tag === 'ul' || tag === 'ol') {
        const items: string[] = [];
        el.querySelectorAll(':scope > li').forEach(li => {
          const text = li.textContent?.trim();
          if (text) items.push(text);
        });
        if (items.length > 0) {
          elements.push({
            type: 'list',
            listType: tag === 'ul' ? 'unordered' : 'ordered',
            items,
          });
        }
      } else if (tag === 'pre' || (tag === 'div' && el.classList.contains('prismjs'))) {
        const codeEl = el.querySelector('code') || el;
        const code = codeEl.textContent?.trim() || '';
        if (code) {
          const langClass = Array.from(codeEl.classList || []).find(c => c.startsWith('language-'));
          const language = langClass ? langClass.replace('language-', '') : undefined;
          elements.push({
            type: 'code',
            content: code,
            language,
          });
        }
      } else if (tag === 'blockquote') {
        const text = el.textContent?.trim() || '';
        if (text) {
          elements.push({ type: 'quote', content: text });
        }
      } else if (tag === 'table') {
        const headers: string[] = [];
        const rows: string[][] = [];

        el.querySelectorAll('thead th, thead td').forEach(th => {
          headers.push(th.textContent?.trim() || '');
        });

        el.querySelectorAll('tbody tr').forEach(tr => {
          const row: string[] = [];
          tr.querySelectorAll('td, th').forEach(cell => {
            row.push(cell.textContent?.trim() || '');
          });
          if (row.length > 0) rows.push(row);
        });

        if (headers.length > 0 || rows.length > 0) {
          elements.push({
            type: 'table',
            headers,
            rows,
          });
        }
      } else {
        el.childNodes.forEach(child => processNode(child));
      }
    };

    mainContent.childNodes.forEach(child => processNode(child));

    return elements;
  }

  protected extractTitle(doc: Document): string {
    const breadcrumb = doc.querySelector('.breadcrumb-item.is-active');
    if (breadcrumb?.textContent?.trim()) {
      return breadcrumb.textContent.trim();
    }

    const pageTitle = doc.querySelector('.page-title');
    if (pageTitle?.textContent?.trim()) {
      return pageTitle.textContent.trim();
    }

    return doc.querySelector('h1')?.textContent?.trim() ||
           doc.querySelector('title')?.textContent?.trim() ||
           '';
  }

  async findSitemap(): Promise<string[]> {
    const sitemapUrls = [
      `${this.baseUrl}/sitemap.xml`,
      `${this.baseUrl}/sitemap.txt`,
      `${this.baseUrl}/sitemap`,
    ];

    for (const sitemapUrl of sitemapUrls) {
      try {
        const response = await fetch(sitemapUrl, {
          headers: { 'Accept': 'text/xml,application/xml,text/plain' },
        });

        if (response.ok) {
          const content = await response.text();
          return this.parseSitemap(content);
        }
      } catch {}
    }

    return [];
  }

  private parseSitemap(content: string): string[] {
    const urls: string[] = [];

    if (content.includes('<?xml') || content.includes('<urlset')) {
      const dom = new JSDOM(content, { contentType: 'text/xml' });
      const locElements = dom.window.document.querySelectorAll('loc');
      locElements.forEach(loc => {
        const url = loc.textContent?.trim();
        if (url) urls.push(url);
      });
    } else {
      content.split('\n').forEach(line => {
        const url = line.trim();
        if (url && url.startsWith('http')) {
          urls.push(url);
        }
      });
    }

    return urls;
  }

  async scrapeAll(maxPages: number = 100): Promise<ScraperResult[]> {
    const sitemapUrls = await this.findSitemap();
    
    if (sitemapUrls.length > 0) {
      const results: ScraperResult[] = [];
      for (const url of sitemapUrls.slice(0, maxPages)) {
        if (!this.visited.has(url)) {
          this.visited.add(url);
          const result = await this.scrape(url);
          results.push(result);
        }
      }
      return results;
    }

    return this.crawl(this.baseUrl, maxPages);
  }
}
