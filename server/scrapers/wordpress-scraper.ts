import { JSDOM } from "jsdom";
import { BaseScraper } from "./base-scraper";
import type { ScraperResult, ScraperOptions, WebsiteType } from "./base-scraper";
import type { ScrapedElement } from "@shared/schema";

export class WordPressScraper extends BaseScraper {
  get type(): WebsiteType {
    return 'wordpress';
  }

  scrapePageContent(html: string, url: string): ScraperResult {
    const dom = new JSDOM(html);
    const doc = dom.window.document;

    const title = this.extractTitle(doc);
    const content = this.extractWordPressContent(doc);
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

  private extractWordPressContent(doc: Document): ScrapedElement[] {
    const elements: ScrapedElement[] = [];

    const contentSelectors = [
      '.entry-content',
      '.post-content',
      '.page-content',
      'article .content',
      '.wp-block-post-content',
      '.elementor-widget-theme-post-content',
      '.single-post-content',
      '#content article',
      'article',
      'main',
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
      'navigation', 'nav', 'navbar', 'menu', 'sidebar', 'widget-area',
      'comments', 'comment-respond', 'related-posts', 'post-navigation',
      'social-share', 'share-buttons', 'wp-block-latest-posts',
      'cookie-notice', 'popup', 'modal', 'advertisement',
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
      } else if (tag === 'p' || el.classList.contains('wp-block-paragraph')) {
        const text = el.textContent?.trim() || '';
        if (text && text.length > 5) {
          elements.push({ type: 'paragraph', content: text });
        }
      } else if (tag === 'ul' || tag === 'ol' || el.classList.contains('wp-block-list')) {
        const items: string[] = [];
        el.querySelectorAll(':scope > li').forEach(li => {
          const text = li.textContent?.trim();
          if (text) items.push(text);
        });
        if (items.length > 0) {
          elements.push({
            type: 'list',
            listType: tag === 'ol' ? 'ordered' : 'unordered',
            items,
          });
        }
      } else if (tag === 'pre' || el.classList.contains('wp-block-code')) {
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
      } else if (tag === 'blockquote' || el.classList.contains('wp-block-quote')) {
        const text = el.textContent?.trim() || '';
        if (text) {
          elements.push({ type: 'quote', content: text });
        }
      } else if (tag === 'table' || el.classList.contains('wp-block-table')) {
        const tableEl = tag === 'table' ? el : el.querySelector('table');
        if (tableEl) {
          const headers: string[] = [];
          const rows: string[][] = [];

          tableEl.querySelectorAll('thead th, thead td').forEach(th => {
            headers.push(th.textContent?.trim() || '');
          });

          tableEl.querySelectorAll('tbody tr').forEach(tr => {
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
        }
      } else if (el.classList.contains('wp-block-gallery') || el.classList.contains('gallery')) {
        el.childNodes.forEach(child => processNode(child));
      } else {
        el.childNodes.forEach(child => processNode(child));
      }
    };

    mainContent.childNodes.forEach(child => processNode(child));

    return elements;
  }

  protected extractTitle(doc: Document): string {
    const entryTitle = doc.querySelector('.entry-title');
    if (entryTitle?.textContent?.trim()) {
      return entryTitle.textContent.trim();
    }

    const postTitle = doc.querySelector('.post-title');
    if (postTitle?.textContent?.trim()) {
      return postTitle.textContent.trim();
    }

    return doc.querySelector('h1')?.textContent?.trim() ||
           doc.querySelector('title')?.textContent?.trim() ||
           '';
  }

  async findSitemap(): Promise<string[]> {
    const sitemapUrls = [
      `${this.baseUrl}/sitemap.xml`,
      `${this.baseUrl}/sitemap_index.xml`,
      `${this.baseUrl}/wp-sitemap.xml`,
      `${this.baseUrl}/post-sitemap.xml`,
      `${this.baseUrl}/page-sitemap.xml`,
    ];

    const allUrls: string[] = [];

    for (const sitemapUrl of sitemapUrls) {
      try {
        const response = await fetch(sitemapUrl, {
          headers: { 'Accept': 'text/xml,application/xml' },
        });

        if (response.ok) {
          const content = await response.text();
          const urls = this.parseSitemap(content);
          
          for (const url of urls) {
            if (url.includes('sitemap') && url.endsWith('.xml')) {
              try {
                const subResponse = await fetch(url);
                if (subResponse.ok) {
                  const subContent = await subResponse.text();
                  allUrls.push(...this.parseSitemap(subContent));
                }
              } catch {}
            } else {
              allUrls.push(url);
            }
          }
        }
      } catch {}
    }

    return Array.from(new Set(allUrls));
  }

  private parseSitemap(content: string): string[] {
    const urls: string[] = [];

    try {
      const dom = new JSDOM(content, { contentType: 'text/xml' });
      const locElements = dom.window.document.querySelectorAll('loc');
      locElements.forEach(loc => {
        const url = loc.textContent?.trim();
        if (url) urls.push(url);
      });
    } catch {}

    return urls;
  }

  async fetchWpJsonPosts(perPage: number = 100): Promise<any[]> {
    const posts: any[] = [];
    let page = 1;

    while (posts.length < perPage) {
      try {
        const response = await fetch(
          `${this.baseUrl}/wp-json/wp/v2/posts?per_page=100&page=${page}`,
          { headers: { 'Accept': 'application/json' } }
        );

        if (!response.ok) break;

        const data = await response.json();
        if (!Array.isArray(data) || data.length === 0) break;

        posts.push(...data);
        page++;

        const totalPages = parseInt(response.headers.get('X-WP-TotalPages') || '1');
        if (page > totalPages) break;
      } catch {
        break;
      }
    }

    return posts.slice(0, perPage);
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
