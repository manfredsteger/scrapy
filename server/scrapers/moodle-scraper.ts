import { JSDOM } from "jsdom";
import { BaseScraper } from "./base-scraper";
import type { ScraperResult, WebsiteType } from "./base-scraper";
import type { ScrapedElement } from "@shared/schema";

export class MoodleScraper extends BaseScraper {
  get type(): WebsiteType {
    return 'moodle';
  }

  scrapePageContent(html: string, url: string): ScraperResult {
    const dom = new JSDOM(html, { url });
    const doc = dom.window.document;

    // Check if URL has a section hash (e.g., #section-3)
    const sectionMatch = url.match(/#section-(\d+)/);
    const targetSection = sectionMatch ? parseInt(sectionMatch[1]) : null;

    // Get the section element if targeting a specific section
    let scopeElement: Element | null = null;
    if (targetSection !== null) {
      scopeElement = doc.querySelector(`#section-${targetSection}, [data-section="${targetSection}"], li#section-${targetSection}`);
    }

    const title = this.extractTitle(doc, targetSection);
    const content = this.extractMoodleContent(doc, targetSection);
    
    // Extract images/videos/links from section scope if available, otherwise from full doc
    const images = scopeElement 
      ? this.extractImagesFromElement(scopeElement, url)
      : this.extractImages(doc, url);
    const videos = scopeElement 
      ? this.extractVideosFromElement(scopeElement, url)
      : this.extractVideos(doc, url);
    const links = this.extractMoodleLinks(doc, url, scopeElement);
    
    const structuredData = this.options.extractStructuredData 
      ? this.extractStructuredData(doc) 
      : undefined;

    return {
      url,
      title,
      content,
      images,
      videos,
      links,
      structuredData,
    };
  }
  
  private extractImagesFromElement(element: Element, baseUrl: string): { loc: string; title?: string }[] {
    const images: { loc: string; title?: string }[] = [];
    const seen = new Set<string>();
    element.querySelectorAll('img[src]').forEach(img => {
      const src = img.getAttribute('src');
      if (src && !src.startsWith('data:')) {
        try {
          const absoluteUrl = new URL(src, baseUrl).href;
          if (!seen.has(absoluteUrl)) {
            seen.add(absoluteUrl);
            const alt = img.getAttribute('alt');
            images.push({ loc: absoluteUrl, title: alt || undefined });
          }
        } catch {}
      }
    });
    return images;
  }
  
  private extractVideosFromElement(element: Element, baseUrl: string): { loc: string; title?: string }[] {
    const videos: { loc: string; title?: string }[] = [];
    const seen = new Set<string>();
    element.querySelectorAll('video source[src], video[src], iframe[src]').forEach(el => {
      const src = el.getAttribute('src');
      if (src) {
        try {
          const absoluteUrl = new URL(src, baseUrl).href;
          if (!seen.has(absoluteUrl)) {
            seen.add(absoluteUrl);
            videos.push({ loc: absoluteUrl });
          }
        } catch {}
      }
    });
    return videos;
  }

  protected extractTitle(doc: Document, targetSection: number | null = null): string {
    // If targeting a specific section, try to get section title
    if (targetSection !== null) {
      const sectionEl = doc.querySelector(`#section-${targetSection}, [data-section="${targetSection}"], li#section-${targetSection}`);
      if (sectionEl) {
        const sectionTitle = sectionEl.querySelector('h3, h4, .sectionname, .section-title');
        if (sectionTitle?.textContent?.trim()) {
          const courseTitle = doc.querySelector('.page-header-headings h1, #page-header h1')?.textContent?.trim();
          const sectionName = sectionTitle.textContent.trim();
          return courseTitle ? `${courseTitle} - ${sectionName}` : sectionName;
        }
      }
    }
    
    const courseTitle = doc.querySelector('.page-header-headings h1, #page-header h1');
    if (courseTitle?.textContent?.trim()) {
      return targetSection !== null 
        ? `${courseTitle.textContent.trim()} - Sektion ${targetSection}` 
        : courseTitle.textContent.trim();
    }
    
    const pageTitle = doc.querySelector('title')?.textContent?.trim() || '';
    return pageTitle.replace(/\s*\|\s*.*$/, '').trim() || pageTitle;
  }

  private extractMoodleContent(doc: Document, targetSection: number | null = null): ScrapedElement[] {
    const elements: ScrapedElement[] = [];
    
    // If targeting a specific section, extract only that section's content
    let mainContent: Element | null = null;
    
    if (targetSection !== null) {
      // Try to find the specific section element
      const sectionSelectors = [
        `#section-${targetSection}`,
        `[data-section="${targetSection}"]`,
        `li#section-${targetSection}`,
        `section#section-${targetSection}`,
      ];
      
      for (const selector of sectionSelectors) {
        const sectionEl = doc.querySelector(selector);
        if (sectionEl && sectionEl.textContent && sectionEl.textContent.trim().length > 10) {
          mainContent = sectionEl;
          console.log(`[MoodleScraper] Found section ${targetSection} using selector: ${selector}`);
          break;
        }
      }
      
      if (!mainContent) {
        console.log(`[MoodleScraper] Section ${targetSection} not found, falling back to full page`);
      }
    }
    
    // If no section found or not targeting section, use standard content selectors
    if (!mainContent) {
      const contentSelectors = [
        '#region-main',
        '#page-content',
        '.course-content',
        '.activity-description',
        'section#region-main',
        'main#maincontent',
        '[role="main"]',
        '.snap-activity',
        '.snap-course-content',
      ];

      for (const selector of contentSelectors) {
        const el = doc.querySelector(selector);
        if (el && el.textContent && el.textContent.trim().length > 50) {
          mainContent = el;
          break;
        }
      }
    }

    if (!mainContent) {
      mainContent = doc.body;
    }

    const skipSelectors = new Set([
      '.navbar', '.nav', 'nav', 'header', 'footer', '.footer',
      '.breadcrumb', '.breadcrumbs',
      '.usermenu', '.logininfo',
      '.sidebar', '.block', '.snap-blocks',
      '.editing_button', '.mod-indent-outer',
      'script', 'style', 'noscript', 'form',
      '.langmenu', '.contextual-menu',
    ]);

    const processElement = (el: Element): void => {
      const tag = el.tagName.toLowerCase();
      
      const skipArr = Array.from(skipSelectors);
      for (let i = 0; i < skipArr.length; i++) {
        if (el.matches(skipArr[i]) || el.closest(skipArr[i])) {
          return;
        }
      }

      if (['h1', 'h2', 'h3', 'h4', 'h5', 'h6'].includes(tag)) {
        const text = el.textContent?.trim();
        if (text && text.length > 2) {
          elements.push({
            type: 'heading',
            tag,
            content: text,
            level: parseInt(tag[1]),
          });
        }
      } else if (tag === 'p') {
        const text = el.textContent?.trim();
        if (text && text.length > 10) {
          elements.push({
            type: 'paragraph',
            content: text,
          });
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
            tag,
            children: items,
          });
        }
      } else if (tag === 'div' || tag === 'section') {
        Array.from(el.children).forEach(child => processElement(child));
      } else if (tag === 'article') {
        Array.from(el.children).forEach(child => processElement(child));
      }
    };

    Array.from(mainContent.children).forEach(child => processElement(child));

    // Extract activities from within mainContent only (not entire document)
    const activities = mainContent.querySelectorAll('.activity, .snap-activity, .activityinstance');
    activities.forEach(activity => {
      const title = activity.querySelector('.instancename, .activityname, .snap-asset-link')?.textContent?.trim();
      const description = activity.querySelector('.contentafterlink, .activity-description, .snap-asset-description')?.textContent?.trim();
      
      if (title) {
        elements.push({
          type: 'heading',
          tag: 'h4',
          content: title,
          level: 4,
        });
      }
      if (description && description.length > 20) {
        elements.push({
          type: 'paragraph',
          content: description,
        });
      }
    });

    return elements;
  }

  extractMoodleLinks(doc: Document, baseUrl: string, scopeElement: Element | null = null): string[] {
    const links: string[] = [];
    const baseDomain = new URL(baseUrl).origin;
    
    const skipPatterns = [
      '/login/',
      '/admin/',
      '/user/profile.php',
      '/message/',
      '/calendar/',
      '/theme/',
      '/lib/',
      '/pluginfile.php',
      '/blocks/',
      '/auth/',
      'sesskey=',
      'download.moodle.org',
      'moodlerooms.com',
    ];

    const priorityPatterns = [
      '/course/view.php',
      '/mod/page/',
      '/mod/book/',
      '/mod/resource/',
      '/mod/lesson/',
      '/mod/wiki/',
      '/mod/glossary/',
      '/mod/data/',
      '/course/index.php',
    ];

    // Use scope element if provided, otherwise use full document
    const searchRoot = scopeElement || doc;
    searchRoot.querySelectorAll('a[href]').forEach(a => {
      const href = a.getAttribute('href');
      if (!href) return;
      if (href.startsWith('#') || href.startsWith('javascript:') || 
          href.startsWith('mailto:') || href.startsWith('tel:')) return;

      try {
        const resolvedUrl = new URL(href, baseUrl).href;
        
        if (!resolvedUrl.startsWith(baseDomain)) return;
        
        if (skipPatterns.some(pattern => resolvedUrl.includes(pattern))) return;
        
        if (resolvedUrl.match(/\.(pdf|jpg|jpeg|png|gif|svg|css|js|zip|tar|gz|ico|woff|woff2|ttf|eot)$/i)) return;

        let cleanUrl = resolvedUrl.split('#')[0];
        
        const urlObj = new URL(cleanUrl);
        const importantParams = ['id', 'section', 'chapterid', 'entryid'];
        const newParams = new URLSearchParams();
        importantParams.forEach(param => {
          const val = urlObj.searchParams.get(param);
          if (val) newParams.set(param, val);
        });
        urlObj.search = newParams.toString();
        cleanUrl = urlObj.href;

        if (cleanUrl && !links.includes(cleanUrl)) {
          const isPriority = priorityPatterns.some(pattern => cleanUrl.includes(pattern));
          if (isPriority) {
            links.unshift(cleanUrl);
          } else {
            links.push(cleanUrl);
          }
        }
      } catch {}
    });

    return Array.from(new Set(links));
  }

  async crawlMoodleCourses(startUrl: string, maxPages: number = 100): Promise<ScraperResult[]> {
    const results: ScraperResult[] = [];
    const queue: string[] = [];
    const visited = new Set<string>();
    
    try {
      const html = await this.fetchPage(startUrl);
      const dom = new JSDOM(html, { url: startUrl });
      const doc = dom.window.document;
      
      const links = this.extractMoodleLinks(doc, startUrl);
      
      const courseLinks = links.filter(link => 
        link.includes('/course/view.php') || 
        link.includes('/course/index.php')
      );
      
      queue.push(...courseLinks);
      
      if (!courseLinks.includes(startUrl)) {
        queue.unshift(startUrl);
      }
    } catch (error) {
      console.error('Error fetching start page:', error);
      queue.push(startUrl);
    }

    while (queue.length > 0 && results.length < maxPages) {
      const url = queue.shift()!;
      
      const normalizedUrl = this.normalizeUrl(url);
      if (visited.has(normalizedUrl)) continue;
      visited.add(normalizedUrl);

      try {
        const result = await this.scrape(url);
        if (!result.error) {
          results.push(result);
          
          for (const link of result.links) {
            const normalizedLink = this.normalizeUrl(link);
            if (!visited.has(normalizedLink)) {
              queue.push(link);
            }
          }
        }
      } catch (error) {
        console.error(`Error scraping ${url}:`, error);
      }
    }

    return results;
  }

  private normalizeUrl(url: string): string {
    try {
      const urlObj = new URL(url);
      urlObj.hash = '';
      const entries: [string, string][] = [];
      urlObj.searchParams.forEach((val, key) => entries.push([key, val]));
      entries.sort((a, b) => a[0].localeCompare(b[0]));
      const sortedParams = new URLSearchParams(entries);
      urlObj.search = sortedParams.toString();
      return urlObj.href;
    } catch {
      return url;
    }
  }
}
