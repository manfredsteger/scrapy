import { JSDOM } from "jsdom";
import { BaseScraper, ScraperResult, ScraperOptions, WebsiteType } from "./base-scraper";
import type { ScrapedElement } from "@shared/schema";

function isCardElement(el: Element): boolean {
  const tag = el.tagName?.toLowerCase();
  const classList = (el.className || '').toLowerCase();
  const cardPatterns = [
    'card', 'person', 'team', 'member', 'profile', 'staff', 
    'mitarbeiter', 'kontakt', 'employee', 'author', 'speaker'
  ];
  
  if (tag === 'article' || tag === 'section') {
    const hasImage = el.querySelector('img');
    const text = el.textContent?.trim() || '';
    if (hasImage && text.length > 20 && text.length < 500) {
      return true;
    }
  }
  
  for (const pattern of cardPatterns) {
    if (classList.includes(pattern)) {
      return true;
    }
  }
  
  return false;
}

function extractCardContent(el: Element, baseUrl: string): ScrapedElement | null {
  const img = el.querySelector('img');
  const headings = el.querySelectorAll('h1, h2, h3, h4, h5, h6');
  const paragraphs = el.querySelectorAll('p');
  const links = el.querySelectorAll('a');
  
  const parts: string[] = [];
  
  headings.forEach(h => {
    const text = h.textContent?.trim();
    if (text) parts.push(`**${text}**`);
  });
  
  paragraphs.forEach(p => {
    const text = p.textContent?.trim();
    if (text && text.length > 3) parts.push(text);
  });
  
  if (parts.length === 0) {
    const directText = el.textContent?.trim() || '';
    if (directText && directText.length > 10 && directText.length < 500) {
      parts.push(directText);
    }
  }
  
  links.forEach(a => {
    const href = a.getAttribute('href');
    const text = a.textContent?.trim();
    if (href && text && (href.includes('mailto:') || href.includes('tel:'))) {
      parts.push(`${text}: ${href.replace('mailto:', '').replace('tel:', '')}`);
    }
  });
  
  if (parts.length === 0 && !img) {
    return null;
  }
  
  let imageSrc: string | undefined;
  let imageAlt: string | undefined;
  
  if (img) {
    const src = img.getAttribute('src');
    if (src) {
      try {
        imageSrc = new URL(src, baseUrl).href;
        imageAlt = img.getAttribute('alt') || undefined;
      } catch {}
    }
  }
  
  return {
    type: 'card',
    content: parts.join('\n'),
    image: imageSrc,
    imageAlt: imageAlt,
  };
}

export class GenericScraper extends BaseScraper {
  get type(): WebsiteType {
    return 'generic';
  }

  scrapePageContent(html: string, url: string): ScraperResult {
    const dom = new JSDOM(html);
    const doc = dom.window.document;

    const title = this.extractTitle(doc);
    const content = this.extractGenericContent(doc, url);
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

  private extractGenericContent(doc: Document, baseUrl: string): ScrapedElement[] {
    const elements: ScrapedElement[] = [];

    const contentSelectors = [
      '.document-all',
      '.document-content',
      '#documentContent',
      '.gesetzestext',
      '.rechtstext',
      '.legal-content',
      'main article',
      'article.content',
      'article',
      'main',
      '[role="main"]',
      '.main-content',
      '#main-content',
      '.post-content',
      '.entry-content',
      '.article-content',
      '.page-content',
      '#content:not(#navigation)',
      '.content:not(.navigation)',
      '#content',
      '.content',
      '.container main',
      '.wrapper main',
    ];

    let mainContent: Element | null = null;
    for (const selector of contentSelectors) {
      try {
        const el = doc.querySelector(selector);
        if (el && el.textContent && el.textContent.trim().length > 100) {
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
      'breadcrumb', 'breadcrumbs', 'toc', 'table-of-contents', 'inhaltsverzeichnis',
      'footer', 'header', 'banner', 'advertisement', 'ad', 'ads',
      'social-share', 'share-buttons', 'related-posts', 'comments',
      'cookie-banner', 'cookie-notice', 'popup', 'modal',
    ]);
    const skipIds = new Set([
      'navigation', 'nav', 'navbar', 'menu', 'sidebar', 'toc',
      'breadcrumb', 'footer', 'header', 'comments',
    ]);

    const shouldSkip = (el: Element): boolean => {
      const tag = el.tagName?.toLowerCase();
      if (skipTags.has(tag)) return true;

      const classList = el.className?.toLowerCase?.() || '';
      const id = el.id?.toLowerCase() || '';

      const skipClassesArr = Array.from(skipClasses);
      for (let i = 0; i < skipClassesArr.length; i++) {
        if (classList.includes(skipClassesArr[i])) return true;
      }

      const skipIdsArr = Array.from(skipIds);
      for (let i = 0; i < skipIdsArr.length; i++) {
        if (id.includes(skipIdsArr[i])) return true;
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
        if (text && text.length > 10) {
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
      } else if (tag === 'pre') {
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

        if (headers.length === 0 && rows.length > 0) {
          const firstRowEl = el.querySelector('tr');
          if (firstRowEl) {
            firstRowEl.querySelectorAll('th, td').forEach(cell => {
              headers.push(cell.textContent?.trim() || '');
            });
          }
        }

        if (headers.length > 0 || rows.length > 0) {
          elements.push({
            type: 'table',
            headers,
            rows,
          });
        }
      } else if (tag === 'figure') {
        const figcaption = el.querySelector('figcaption');
        if (figcaption) {
          elements.push({ type: 'paragraph', content: figcaption.textContent?.trim() || '' });
        }
        el.childNodes.forEach(child => processNode(child));
      } else if (tag === 'img') {
        const src = el.getAttribute('src');
        if (src) {
          try {
            const resolvedSrc = new URL(src, baseUrl).href;
            elements.push({
              type: 'media',
              tag: 'img',
              src: resolvedSrc,
              alt: el.getAttribute('alt') || undefined,
            });
          } catch {}
        }
      } else if (isCardElement(el)) {
        const card = extractCardContent(el, baseUrl);
        if (card) {
          elements.push(card);
        }
      } else {
        el.childNodes.forEach(child => processNode(child));
      }
    };

    mainContent.childNodes.forEach(child => processNode(child));

    return elements;
  }

  async findSitemap(): Promise<string[]> {
    const sitemapUrls = [
      `${this.baseUrl}/sitemap.xml`,
      `${this.baseUrl}/sitemap_index.xml`,
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

    if (content.includes('<?xml') || content.includes('<urlset') || content.includes('<sitemapindex')) {
      try {
        const dom = new JSDOM(content, { contentType: 'text/xml' });
        const locElements = dom.window.document.querySelectorAll('loc');
        locElements.forEach(loc => {
          const url = loc.textContent?.trim();
          if (url) urls.push(url);
        });
      } catch {}
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
