import { JSDOM } from "jsdom";
import type { ScrapedElement, StructuredData } from "@shared/schema";

export interface ScraperResult {
  url: string;
  title: string;
  content: ScrapedElement[];
  images: { loc: string; title?: string }[];
  videos: { loc: string; title?: string }[];
  structuredData?: StructuredData;
  links: string[];
  error?: string;
}

export interface ScraperOptions {
  extractStructuredData?: boolean;
  followLinks?: boolean;
  maxDepth?: number;
  timeout?: number;
}

export type WebsiteType = 'wikijs' | 'wordpress' | 'generic';

export interface WebsiteDetectionResult {
  type: WebsiteType;
  confidence: number;
  indicators: string[];
}

export abstract class BaseScraper {
  protected baseUrl: string;
  protected domain: string;
  protected visited: Set<string> = new Set();
  protected options: ScraperOptions;

  constructor(baseUrl: string, options: ScraperOptions = {}) {
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.domain = new URL(baseUrl).hostname;
    this.options = {
      extractStructuredData: true,
      followLinks: false,
      maxDepth: 1,
      timeout: 30000,
      ...options,
    };
  }

  abstract get type(): WebsiteType;

  abstract scrapePageContent(html: string, url: string): ScraperResult;

  async fetchPage(url: string): Promise<string> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.options.timeout);

    try {
      const response = await fetch(url, {
        signal: controller.signal,
        headers: {
          'User-Agent': 'Mozilla/5.0 (compatible; MapScraperPro/1.0)',
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'Accept-Language': 'de-DE,de;q=0.9,en;q=0.8',
        },
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      return await response.text();
    } finally {
      clearTimeout(timeoutId);
    }
  }

  async scrape(url: string): Promise<ScraperResult> {
    try {
      const html = await this.fetchPage(url);
      return this.scrapePageContent(html, url);
    } catch (error) {
      return {
        url,
        title: '',
        content: [],
        images: [],
        videos: [],
        links: [],
        error: (error as Error).message,
      };
    }
  }

  async crawl(startUrl: string, maxPages: number = 100): Promise<ScraperResult[]> {
    const results: ScraperResult[] = [];
    const queue: string[] = [startUrl];

    while (queue.length > 0 && results.length < maxPages) {
      const url = queue.shift()!;
      
      if (this.visited.has(url)) continue;
      this.visited.add(url);

      const result = await this.scrape(url);
      results.push(result);

      if (this.options.followLinks && !result.error) {
        for (const link of result.links) {
          if (!this.visited.has(link) && this.isInternalLink(link)) {
            queue.push(link);
          }
        }
      }
    }

    return results;
  }

  protected isInternalLink(url: string): boolean {
    try {
      const linkDomain = new URL(url).hostname;
      return linkDomain === this.domain || linkDomain.endsWith('.' + this.domain);
    } catch {
      return false;
    }
  }

  protected extractTitle(doc: Document): string {
    return doc.querySelector('h1')?.textContent?.trim() ||
           doc.querySelector('title')?.textContent?.trim() ||
           '';
  }

  protected extractImages(doc: Document, baseUrl: string): { loc: string; title?: string }[] {
    const images: { loc: string; title?: string }[] = [];
    
    doc.querySelectorAll('img[src]').forEach(img => {
      const src = img.getAttribute('src');
      if (src) {
        try {
          const resolvedSrc = new URL(src, baseUrl).href;
          images.push({
            loc: resolvedSrc,
            title: img.getAttribute('alt') || img.getAttribute('title') || undefined,
          });
        } catch {}
      }
    });

    return images;
  }

  protected extractVideos(doc: Document, baseUrl: string): { loc: string; title?: string }[] {
    const videos: { loc: string; title?: string }[] = [];
    
    doc.querySelectorAll('video source[src], video[src]').forEach(video => {
      const src = video.getAttribute('src');
      if (src) {
        try {
          const resolvedSrc = new URL(src, baseUrl).href;
          videos.push({ loc: resolvedSrc, title: undefined });
        } catch {}
      }
    });

    return videos;
  }

  protected extractLinks(doc: Document, baseUrl: string): string[] {
    const links: string[] = [];
    
    doc.querySelectorAll('a[href]').forEach(a => {
      const href = a.getAttribute('href');
      if (!href) return;
      if (href.startsWith('#') || href.startsWith('javascript:') || 
          href.startsWith('mailto:') || href.startsWith('tel:')) return;

      try {
        const resolvedUrl = new URL(href, baseUrl).href;
        if (!resolvedUrl.match(/\.(pdf|jpg|jpeg|png|gif|svg|css|js|zip|tar|gz|ico|woff|woff2|ttf|eot)$/i)) {
          const cleanUrl = resolvedUrl.split('#')[0].split('?')[0];
          if (cleanUrl) links.push(cleanUrl);
        }
      } catch {}
    });

    return Array.from(new Set(links));
  }

  protected extractStructuredData(doc: Document): StructuredData {
    const structuredData: StructuredData = {};

    const jsonLdScripts = doc.querySelectorAll('script[type="application/ld+json"]');
    if (jsonLdScripts.length > 0) {
      structuredData.jsonLd = [];
      jsonLdScripts.forEach(script => {
        try {
          const data = JSON.parse(script.textContent || '');
          structuredData.jsonLd!.push(data);
        } catch {}
      });
    }

    const ogMetas = doc.querySelectorAll('meta[property^="og:"]');
    if (ogMetas.length > 0) {
      structuredData.openGraph = {};
      ogMetas.forEach(meta => {
        const property = meta.getAttribute('property');
        const content = meta.getAttribute('content');
        if (property && content) {
          const key = property.replace(/^og:/, '');
          structuredData.openGraph![key] = content;
        }
      });
    }

    const twitterMetas = doc.querySelectorAll('meta[name^="twitter:"], meta[property^="twitter:"]');
    if (twitterMetas.length > 0) {
      structuredData.twitterCard = {};
      twitterMetas.forEach(meta => {
        const name = meta.getAttribute('name') || meta.getAttribute('property');
        const content = meta.getAttribute('content');
        if (name && content) {
          const key = name.replace(/^twitter:/, '');
          structuredData.twitterCard![key] = content;
        }
      });
    }

    return structuredData;
  }
}
