// Central place that turns a fetched HTML page into the structured
// `orderedElements` shape used everywhere downstream (markdown conversion,
// chunking, RAG pack export). This used to live inline inside routes.ts;
// it was extracted into its own module so the dispatch to specialized
// scrapers (Moodle, CGI-list, ...) is easy to find and extend without
// growing routes.ts further.
//
// Dispatch: most pages are extracted generically below. Pages recognized
// as a specific CMS/pattern are routed to their dedicated scraper class
// (see server/scrapers/) and their result is converted to the same
// output shape so downstream code doesn't need to know the difference.

import { JSDOM } from "jsdom";
import type { StructuredData } from "@shared/schema";
import { MoodleScraper } from "../scrapers/moodle-scraper";
import { CgiListScraper } from "../scrapers/cgi-list-scraper";
import { KitaBayernScraper } from "../scrapers/kita-bayern-scraper";
import { isKitaBayernUrl } from "../scrapers/sources/kita-bayern";
import { detectCgiList } from "../utils/detector";
import { detectSoftNotFound } from "./soft-404";

// Skip URLs that point to non-HTML content (PDFs, images, etc.)
const SKIP_EXTENSIONS = new Set(['.pdf', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx', '.zip', '.rar', '.tar', '.gz', '.7z', '.exe', '.dmg', '.iso', '.mp3', '.mp4', '.avi', '.mov', '.wmv', '.flv', '.webm', '.ogg', '.wav', '.jpg', '.jpeg', '.png', '.gif', '.bmp', '.svg', '.webp', '.ico', '.tiff']);

// Inline/text-level tags whose text should fold into surrounding loose text
// when they appear directly inside a generic container, rather than being
// dropped or treated as their own block. Deliberately excludes 'img' (has
// its own case), block-level tags, and 'br' (no meaningful text).
const INLINE_TEXT_TAGS = new Set(['a', 'span', 'b', 'strong', 'i', 'em', 'small', 'label', 'font', 'u', 'mark', 'abbr', 'time', 'sub', 'sup']);

export function shouldSkipUrl(url: string): boolean {
  try {
    const parsedUrl = new URL(url);
    const pathname = parsedUrl.pathname.toLowerCase();
    const extensionsArray = Array.from(SKIP_EXTENSIONS);
    for (let i = 0; i < extensionsArray.length; i++) {
      if (pathname.endsWith(extensionsArray[i])) {
        return true;
      }
    }
    return false;
  } catch {
    return false;
  }
}

// Detect programming language from element class names
function detectCodeLanguage(el: Element): string | undefined {
  const classNames = el.className || '';
  const parentClassNames = el.parentElement?.className || '';
  const allClasses = `${classNames} ${parentClassNames}`.toLowerCase();

  // Common patterns for syntax highlighting libraries
  const languagePatterns = [
    /language-(\w+)/,
    /lang-(\w+)/,
    /hljs-?(\w+)/,
    /highlight-(\w+)/,
    /brush:\s*(\w+)/,
    /prism-(\w+)/,
    /syntax-(\w+)/,
    /code-(\w+)/,
  ];

  for (const pattern of languagePatterns) {
    const match = allClasses.match(pattern);
    if (match && match[1]) {
      const lang = match[1];
      // Filter out non-language classes
      if (!['block', 'inline', 'highlight', 'source', 'code'].includes(lang)) {
        return lang;
      }
    }
  }

  // Check for specific language class names
  const knownLanguages = ['javascript', 'typescript', 'python', 'java', 'cpp', 'csharp', 'ruby', 'go', 'rust', 'php', 'html', 'css', 'sql', 'bash', 'shell', 'json', 'xml', 'yaml', 'markdown'];
  for (const lang of knownLanguages) {
    if (allClasses.includes(lang)) {
      return lang;
    }
  }

  return undefined;
}

function extractStructuredData(doc: Document): StructuredData {
  const structuredData: StructuredData = {};

  // 1. Extract JSON-LD from <script type="application/ld+json"> tags
  const jsonLdScripts = doc.querySelectorAll('script[type="application/ld+json"]');
  if (jsonLdScripts.length > 0) {
    structuredData.jsonLd = [];
    jsonLdScripts.forEach(script => {
      try {
        const content = script.textContent?.trim();
        if (content) {
          const parsed = JSON.parse(content);
          structuredData.jsonLd!.push(parsed);
        }
      } catch (e) {
        // Skip invalid JSON-LD
      }
    });
  }

  // 2. Extract Schema.org Microdata (itemscope/itemtype/itemprop)
  const itemscopeElements = doc.querySelectorAll('[itemscope]');
  if (itemscopeElements.length > 0) {
    structuredData.schemaOrg = [];

    itemscopeElements.forEach(element => {
      const itemtype = element.getAttribute('itemtype');
      const schemaItem: Record<string, any> = {};

      if (itemtype) {
        schemaItem['@type'] = itemtype;
      }

      // Extract all itemprop values within this itemscope
      const itempropElements = element.querySelectorAll('[itemprop]');
      itempropElements.forEach(propEl => {
        const propName = propEl.getAttribute('itemprop');
        if (!propName) return;

        // Check if this itemprop belongs to a nested itemscope
        const closestItemscope = propEl.closest('[itemscope]');
        if (closestItemscope !== element) return;

        // Get the value based on element type
        let value: string | undefined;
        const tagName = propEl.tagName.toLowerCase();

        if (tagName === 'meta') {
          value = propEl.getAttribute('content') || undefined;
        } else if (tagName === 'link' || tagName === 'a') {
          value = propEl.getAttribute('href') || undefined;
        } else if (tagName === 'img' || tagName === 'video' || tagName === 'audio') {
          value = propEl.getAttribute('src') || undefined;
        } else if (tagName === 'time') {
          value = propEl.getAttribute('datetime') || propEl.textContent?.trim();
        } else if (tagName === 'data') {
          value = propEl.getAttribute('value') || propEl.textContent?.trim();
        } else {
          value = propEl.textContent?.trim();
        }

        if (value) {
          // Handle multiple values for the same property
          if (schemaItem[propName]) {
            if (Array.isArray(schemaItem[propName])) {
              schemaItem[propName].push(value);
            } else {
              schemaItem[propName] = [schemaItem[propName], value];
            }
          } else {
            schemaItem[propName] = value;
          }
        }
      });

      if (Object.keys(schemaItem).length > 0) {
        structuredData.schemaOrg!.push(schemaItem);
      }
    });
  }

  // 3. Extract OpenGraph meta tags (og:*)
  const ogMetas = doc.querySelectorAll('meta[property^="og:"]');
  if (ogMetas.length > 0) {
    structuredData.openGraph = {};
    ogMetas.forEach(meta => {
      const property = meta.getAttribute('property');
      const content = meta.getAttribute('content');
      if (property && content) {
        // Remove 'og:' prefix for cleaner keys
        const key = property.replace(/^og:/, '');
        structuredData.openGraph![key] = content;
      }
    });
  }

  // 4. Extract Twitter Card meta tags (twitter:*)
  const twitterMetas = doc.querySelectorAll('meta[name^="twitter:"], meta[property^="twitter:"]');
  if (twitterMetas.length > 0) {
    structuredData.twitterCard = {};
    twitterMetas.forEach(meta => {
      const name = meta.getAttribute('name') || meta.getAttribute('property');
      const content = meta.getAttribute('content');
      if (name && content) {
        // Remove 'twitter:' prefix for cleaner keys
        const key = name.replace(/^twitter:/, '');
        structuredData.twitterCard![key] = content;
      }
    });
  }

  return structuredData;
}

export function scrapePageContent(html: string, url: string, extractStructuredDataFlag: boolean = true): any {
  const dom = new JSDOM(html, { url });
  const doc = dom.window.document;

  // Check for <base> tag to get the correct base URL for resolving relative URLs
  const baseTag = doc.querySelector('base');
  const effectiveBaseUrl = baseTag?.getAttribute('href') || url;

  // Soft-404 check: some sources answer with HTTP 200 for "not found" pages.
  // Computed up front so it applies regardless of which branch below handles
  // the actual content extraction.
  const isSoftNotFound = detectSoftNotFound(doc, html);

  // Check if this is a Moodle page and use MoodleScraper for proper extraction
  const isMoodlePage =
    doc.querySelector('#course-toc, .snap-course-content, #snap-course-wrapper, .course-content') !== null ||
    doc.querySelector('meta[name="keywords"][content*="moodle"]') !== null ||
    doc.querySelector('link[href*="/theme/snap/"]') !== null ||
    html.includes('class="path-course-view"') ||
    html.includes('class="path-course"') ||
    url.includes('/course/view.php') ||
    url.includes('/mod/');

  if (isMoodlePage) {
    console.log(`[scrapePageContent] Detected Moodle page, using MoodleScraper for: ${url}`);
    const moodleScraper = new MoodleScraper(url, { extractStructuredData: extractStructuredDataFlag });
    const result = moodleScraper.scrapePageContent(html, url);

    // Convert to the expected format
    const structuredData = extractStructuredDataFlag ? extractStructuredData(doc) : null;
    const wordCount = result.content.reduce((count: number, el: any) => {
      const text = el.content || (el.children ? el.children.join(' ') : '');
      return count + (text.match(/\S+/g) || []).length;
    }, 0);

    // Extract PDF links from Moodle page
    const moodlePdfs: Array<{ url: string; title?: string; linkText?: string }> = [];
    const seenMoodlePdfUrls = new Set<string>();
    doc.querySelectorAll('a[href]').forEach(anchor => {
      const href = anchor.getAttribute('href');
      if (!href) return;
      try {
        const absoluteUrl = new URL(href, effectiveBaseUrl).href;
        if (!/^https?:/i.test(absoluteUrl)) return; // no javascript:/data: links
        const lowerUrl = absoluteUrl.toLowerCase();
        if (lowerUrl.endsWith('.pdf') || lowerUrl.includes('.pdf?') || lowerUrl.includes('/pluginfile.php/') && lowerUrl.includes('pdf')) {
          if (!seenMoodlePdfUrls.has(absoluteUrl)) {
            seenMoodlePdfUrls.add(absoluteUrl);
            const linkText = anchor.textContent?.trim() || undefined;
            const titleAttr = anchor.getAttribute('title')?.trim() || undefined;
            moodlePdfs.push({ url: absoluteUrl, title: titleAttr || linkText || undefined, linkText });
          }
        }
      } catch {}
    });

    const moodleResult: any = {
      title: result.title,
      timestamp: new Date().toISOString(),
      wordCount,
      structuredData,
      orderedElements: result.content,
      isSoftNotFound,
    };

    if (moodlePdfs.length > 0) {
      moodleResult.linkedPdfs = moodlePdfs;
    }

    return moodleResult;
  }

  // Check for the cgi-list pattern (CGI/PHP/ASP list endpoints where each
  // row is a full record). Known sources with a dedicated field mapping
  // (e.g. kita-bayern.de) always dispatch to their specific scraper;
  // everything else falls back to the generic confidence heuristic.
  const isKnownCgiListSource = isKitaBayernUrl(url);
  const cgiListDetection = isKnownCgiListSource
    ? { confidence: 1, indicators: ['Known source: kita-bayern.de'] }
    : detectCgiList(doc, html, url);
  if (cgiListDetection.confidence >= 0.7) {
    console.log(`[scrapePageContent] Detected cgi-list page (${cgiListDetection.indicators.join('; ')}), using CgiListScraper for: ${url}`);
    const cgiListScraper = isKnownCgiListSource
      ? new KitaBayernScraper(url, { extractStructuredData: extractStructuredDataFlag })
      : new CgiListScraper(url, { extractStructuredData: extractStructuredDataFlag });
    const result = cgiListScraper.scrapePageContent(html, url);
    const structuredData = extractStructuredDataFlag ? extractStructuredData(doc) : null;
    const rows = (result.structuredData as any)?.rows || [];
    const wordCount = rows.reduce((count: number, row: Record<string, string>) => {
      return count + Object.values(row).join(' ').split(/\s+/).filter(Boolean).length;
    }, 0);

    return {
      title: result.title,
      timestamp: new Date().toISOString(),
      wordCount,
      structuredData: { ...(structuredData || {}), rows },
      orderedElements: [],
      isSoftNotFound: cgiListScraper.softNotFound ? cgiListScraper.softNotFound(doc, html) : isSoftNotFound,
    };
  }

  const orderedElements: any[] = [];
  let totalWords = 0;

  // Extended selectors for main content - prioritize more specific document/article selectors
  // Also handle government/legal sites with specific content classes
  const contentSelectors = [
    // Document-specific selectors (for legal/government sites)
    '.document-all',
    '.document-content',
    '#documentContent',
    '.gesetzestext',
    '.rechtstext',
    '.legal-content',
    // Standard article/content selectors
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
    // Generic content selectors (last resort before body)
    '#content:not(#navigation)',
    '.content:not(.navigation)',
    '#content',
    '.content',
    '.container main',
    '.wrapper main',
  ];

  let mainContent: Element | null = null;

  // Special handling for Wiki.js: content is inside <template slot="contents">
  const wikiJsTemplate = doc.querySelector('template[slot="contents"]');
  if (wikiJsTemplate) {
    // Wiki.js uses Vue.js template slots - extract content from the template
    const templateContent = wikiJsTemplate.innerHTML;
    if (templateContent && templateContent.trim().length > 50) {
      // Create a temporary element to parse the template content
      const tempDiv = doc.createElement('div');
      tempDiv.innerHTML = templateContent;
      mainContent = tempDiv;
    }
  }

  // If no Wiki.js content found, try standard selectors
  if (!mainContent) {
    for (const selector of contentSelectors) {
      try {
        const el = doc.querySelector(selector);
        if (el && el.textContent && el.textContent.trim().length > 100) {
          mainContent = el;
          break;
        }
      } catch {}
    }
  }

  if (!mainContent) {
    mainContent = doc.body;
  }

  // Elements and classes to skip (navigation, sidebars, etc.)
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

  function shouldSkipElement(el: Element): boolean {
    const tag = el.tagName?.toLowerCase();
    if (skipTags.has(tag)) return true;

    // Check element's own classes and id - use word-boundary matching
    const classListStr = el.className?.toLowerCase?.() || '';
    const classListArr = classListStr.split(/\s+/).filter(Boolean);
    const id = el.id?.toLowerCase() || '';

    // Check each individual class name against skipClasses
    for (const cls of classListArr) {
      if (skipClasses.has(cls)) return true;
      // Also check if class name starts with skip class prefix (like nav-, menu-, etc.)
      for (const skipCls of skipClasses) {
        if (cls.startsWith(skipCls + '-') || cls.startsWith(skipCls + '_')) return true;
      }
    }

    // Check ID - use word-boundary matching
    for (const skipId of skipIds) {
      if (id === skipId || id.startsWith(skipId + '-') || id.startsWith(skipId + '_')) return true;
    }

    // Check for role="navigation"
    if (el.getAttribute('role') === 'navigation') return true;

    return false;
  }

  function processNode(node: Node, depth = 0) {
    if (node.nodeType === 3) {
      return;
    }

    if (node.nodeType !== 1) return;

    const el = node as Element;
    const tag = el.tagName?.toLowerCase();

    // Use enhanced skip detection with word-boundary matching
    if (shouldSkipElement(el)) {
      return;
    }

    // Detect CSS-based team/member lists (like mod_teamList, layout_teamMember)
    const classList = el.className?.toLowerCase?.() || '';
    const isTeamMemberCard = classList.includes('teammember') || classList.includes('team-member') ||
      classList.includes('layout_teammember') || classList.includes('person-card') ||
      classList.includes('staff-card') || classList.includes('mitarbeiter');

    if (isTeamMemberCard) {
      // Extract team member card with image, name, role, contact info
      const img = el.querySelector('img');
      const nameEl = el.querySelector('.name, .title, h3, h4, a[href*="profil"], a[href*="team"]');
      const roleEl = el.querySelector('.position, .role, .job, .function, .subtitle');
      const phoneEl = el.querySelector('.phone, .telefon, .tel, [class*="phone"]');
      const emailEl = el.querySelector('.email, .mail, a[href^="mailto:"]');

      const parts: string[] = [];

      // Name (bold)
      const name = nameEl?.textContent?.trim();
      if (name) parts.push(`**${name}**`);

      // Role/Position
      const role = roleEl?.textContent?.trim();
      if (role && role !== name) parts.push(role);

      // Phone - clean up the text
      let phone = phoneEl?.textContent?.trim();
      if (phone) {
        // Remove "Telefon:", "Tel:", "Mobile:" prefixes if present
        phone = phone.replace(/^(Telefon|Tel|Phone|Mobile):\s*/gi, '').trim();
        // Remove empty labels
        phone = phone.replace(/^(Telefon|Tel|Phone|Mobile):\s*$/gim, '').trim();
        if (phone && phone.length > 3) parts.push(`Tel: ${phone}`);
      }

      // Email - clean up the text
      let email = emailEl?.getAttribute('href')?.replace('mailto:', '') || emailEl?.textContent?.trim();
      if (email) {
        // Remove "E-Mail:" prefix if present
        email = email.replace(/^(E-Mail|Email|Mail):\s*/gi, '').trim();
        if (email.includes('@')) parts.push(`E-Mail: ${email}`);
      }

      // If no structured content found, get all text
      if (parts.length === 0) {
        const allText = el.textContent?.trim();
        if (allText && allText.length > 10 && allText.length < 500) {
          parts.push(allText);
        }
      }

      // Get image
      let imageSrc: string | undefined;
      let imageAlt: string | undefined;
      if (img) {
        let src = img.getAttribute('src');
        if (!src || src.startsWith('data:')) {
          src = img.getAttribute('data-src') || img.getAttribute('data-lazy-src');
        }
        if (src && !src.startsWith('data:')) {
          try {
            imageSrc = new URL(src, effectiveBaseUrl).href;
            imageAlt = img.getAttribute('alt') || undefined;
          } catch {}
        }
      }

      if (parts.length > 0 || imageSrc) {
        orderedElements.push({
          type: 'card',
          content: parts.join('\n'),
          image: imageSrc,
          imageAlt: imageAlt,
        });
      }
      return; // Don't recurse into children, we've extracted everything
    }

    if (tag && tag.match(/^h[1-6]$/)) {
      const text = el.textContent?.trim() || '';
      if (text && text.length > 1) {
        orderedElements.push({
          type: 'heading',
          tag,
          content: text,
          level: parseInt(tag[1]),
        });
      }
    } else if (tag === 'p') {
      const text = el.textContent?.trim() || '';
      if (text && text.length > 10) {
        orderedElements.push({ type: 'paragraph', content: text });
        totalWords += text.split(/\s+/).length;
      }
    } else if (tag === 'ul' || tag === 'ol') {
      const items: string[] = [];
      el.querySelectorAll(':scope > li').forEach(li => {
        const text = li.textContent?.trim();
        if (text) items.push(text);
      });
      if (items.length > 0) {
        orderedElements.push({
          type: 'list',
          tag,
          children: items,
        });
        totalWords += items.join(' ').split(/\s+/).length;
      }
    } else if (tag === 'blockquote') {
      const text = el.textContent?.trim() || '';
      if (text) {
        orderedElements.push({ type: 'blockquote', content: text });
        totalWords += text.split(/\s+/).length;
      }
    } else if (tag === 'pre' || (tag === 'code' && el.parentElement?.tagName.toLowerCase() !== 'pre')) {
      // Handle code blocks - check for pre or standalone code elements
      const codeEl = tag === 'pre' ? (el.querySelector('code') || el) : el;
      const text = codeEl.textContent?.trim() || '';
      if (text && text.length > 5) {
        // Detect programming language from class names
        const language = detectCodeLanguage(codeEl) || detectCodeLanguage(el);
        const lineCount = text.split('\n').length;

        orderedElements.push({
          type: 'code',
          tag,
          content: text,
          language,
          lineCount,
        });
      }
    } else if (tag === 'table') {
      // Enhanced table extraction - handles complex tables with images and rich content
      const caption = el.querySelector('caption')?.textContent?.trim();
      const headers: string[] = [];
      const dataRows: string[][] = [];
      const tableImages: { src: string; alt?: string; rowIndex: number; cellIndex: number }[] = [];

      // Helper arrow function to extract cell content (text + image info)
      const extractCellContent = (cell: Element, rowIdx: number, cellIdx: number): string => {
        // Check for images in the cell
        const img = cell.querySelector('img');
        if (img) {
          let imgSrc = img.getAttribute('src');
          // Check for lazy-loaded images
          if (!imgSrc || imgSrc.startsWith('data:')) {
            imgSrc = img.getAttribute('data-src')
              || img.getAttribute('data-lazy-src')
              || img.getAttribute('data-original')
              || img.getAttribute('data-lazy');
          }
          if (imgSrc && !imgSrc.startsWith('data:')) {
            try {
              const absoluteSrc = new URL(imgSrc, effectiveBaseUrl).href;
              tableImages.push({
                src: absoluteSrc,
                alt: img.getAttribute('alt') || undefined,
                rowIndex: rowIdx,
                cellIndex: cellIdx
              });
            } catch {}
          }
        }

        // Get text content, but also check for links
        let text = '';
        const link = cell.querySelector('a');
        if (link) {
          text = link.textContent?.trim() || '';
        }
        if (!text) {
          text = cell.textContent?.trim() || '';
        }

        // If cell has image but no text, use alt text or "[Image]"
        if (!text && img) {
          text = img.getAttribute('alt') || '[Image]';
        }

        return text;
      }

      // Extract headers from thead or first row with th elements
      const thead = el.querySelector('thead');
      if (thead) {
        thead.querySelectorAll('th').forEach((th, idx) => {
          headers.push(extractCellContent(th, -1, idx));
        });
      }

      // Extract all rows
      let rowIndex = 0;
      el.querySelectorAll('tbody tr, tr').forEach(tr => {
        // Skip if this is a header row we already processed
        if (tr.closest('thead')) return;

        const cells: string[] = [];
        const hasOnlyTh = tr.querySelectorAll('td').length === 0;

        // If first row has only th cells and no headers extracted yet, use as headers
        if (hasOnlyTh && headers.length === 0) {
          tr.querySelectorAll('th').forEach((th, idx) => {
            headers.push(extractCellContent(th, -1, idx));
          });
          return;
        }

        tr.querySelectorAll('td, th').forEach((cell, cellIdx) => {
          cells.push(extractCellContent(cell, rowIndex, cellIdx));
        });
        if (cells.length > 0) {
          dataRows.push(cells);
          rowIndex++;
        }
      });

      if (dataRows.length > 0 || headers.length > 0) {
        orderedElements.push({
          type: 'table',
          tag: 'table',
          headers: headers.length > 0 ? headers : undefined,
          rows: dataRows,
          caption,
          children: dataRows, // Keep for backwards compatibility
          images: tableImages.length > 0 ? tableImages : undefined,
        });

        // Also add table images as separate media elements for RAG processing
        tableImages.forEach(img => {
          orderedElements.push({
            type: 'media',
            tag: 'img',
            src: img.src,
            alt: img.alt,
            context: 'table',
          });
        });
      }
    } else if (tag === 'img') {
      // Try multiple attributes for lazy-loaded images
      let src = el.getAttribute('src');

      // Skip data URIs and placeholder images
      const isDataUri = src?.startsWith('data:');
      const isPlaceholder = src?.includes('placeholder') || src?.includes('blank') || src?.includes('1x1');

      if (!src || isDataUri || isPlaceholder) {
        // Check alternative attributes for lazy-loaded images
        src = el.getAttribute('data-src')
          || el.getAttribute('data-lazy-src')
          || el.getAttribute('data-original')
          || el.getAttribute('data-lazy')
          || el.getAttribute('data-image');
      }

      // Try srcset as fallback
      if (!src) {
        const srcset = el.getAttribute('srcset') || el.getAttribute('data-srcset');
        if (srcset) {
          // Get the first URL from srcset
          const firstUrl = srcset.split(',')[0]?.trim().split(' ')[0];
          if (firstUrl && !firstUrl.startsWith('data:')) {
            src = firstUrl;
          }
        }
      }

      if (src && !src.startsWith('data:')) {
        try {
          const absolute = new URL(src, effectiveBaseUrl).href;
          orderedElements.push({
            type: 'media',
            tag: 'img',
            src: absolute,
            alt: el.getAttribute('alt') || undefined
          });
        } catch {}
      }
    } else if (tag === 'video') {
      const src = el.getAttribute('src') || el.querySelector('source')?.getAttribute('src');
      if (src) {
        try {
          const absolute = new URL(src, effectiveBaseUrl).href;
          orderedElements.push({ type: 'media', tag: 'video', src: absolute });
        } catch {}
      }
    } else {
      // Recurse into child nodes (see processChildNodes for how loose text
      // between them is recovered instead of being dropped).
      processChildNodes(el.childNodes, depth + 1);
    }
  }

  // Walks a NodeList, dispatching element children through processNode and
  // folding "loose" text that sits directly inside a generic container
  // (div/span/a/... or the page's top level) instead of a recognized block
  // tag (p/h1-6/li/...). Older, non-semantic markup (e.g.
  // `<div class="label">Email:</div><br><a>...</a>`, or bare text nodes
  // sitting directly under <body>/<main> after invalid `<div>`-inside-`<p>`
  // markup gets auto-corrected by HTML parsing) puts real content as bare
  // text/inline nodes between siblings; since text nodes are otherwise
  // ignored entirely (see nodeType === 3 early-return in processNode) and
  // inline tags like <a>/<span> have no case of their own, that content used
  // to be silently dropped, sometimes leaving a page with headings but none
  // of its actual body text. Used both for the top-level mainContent walk
  // and for recursion into generic containers, so loose text is recovered
  // wherever it appears, not just one level deep.
  function processChildNodes(nodes: NodeListOf<ChildNode> | ChildNode[], depth: number) {
    let looseText: string[] = [];
    const flushLooseText = () => {
      const combined = looseText.join(' ').replace(/\s+/g, ' ').trim();
      looseText = [];
      if (combined.length > 1) {
        orderedElements.push({ type: 'paragraph', content: combined });
        totalWords += combined.split(/\s+/).length;
      }
    };
    nodes.forEach(child => {
      if (child.nodeType === 3) {
        const text = child.textContent?.trim();
        if (text) looseText.push(text);
        return;
      }
      if (child.nodeType === 1) {
        const childEl = child as Element;
        const childTag = childEl.tagName?.toLowerCase();
        if (childTag && INLINE_TEXT_TAGS.has(childTag) && !shouldSkipElement(childEl)) {
          // Fold inline elements (links, spans, bold/italic, ...) into the
          // current run of loose text instead of treating them as their own
          // block, so "Email: " + <a>foo@bar.de</a> reads as one line.
          const text = childEl.textContent?.trim();
          if (text) looseText.push(text);
          return;
        }
      }
      // Any other element ends the current run of loose text and is
      // processed through the normal dispatch (which may itself recurse).
      flushLooseText();
      processNode(child, depth);
    });
    flushLooseText();
  }

  processChildNodes(mainContent.childNodes, 0);

  if (orderedElements.length === 0) {
    doc.querySelectorAll('h1, h2, h3, h4, h5, h6, p').forEach(el => {
      const tag = el.tagName.toLowerCase();
      const text = el.textContent?.trim() || '';
      if (!text || text.length < 3) return;

      if (tag.match(/^h[1-6]$/)) {
        orderedElements.push({ type: 'heading', tag, content: text, level: parseInt(tag[1]) });
      } else {
        orderedElements.push({ type: 'paragraph', content: text });
        totalWords += text.split(/\s+/).length;
      }
    });
  }

  // A page that isn't a soft-404 but still ends up with no extracted
  // content is otherwise indistinguishable from a genuinely successful
  // scrape (hasScrapedData stays true downstream) — surface it in logs so a
  // systematic extraction gap on a given site/template shows up quickly
  // instead of silently shipping empty results.
  if (orderedElements.length === 0 && !isSoftNotFound) {
    console.warn(`[scrapePageContent] No content extracted for ${url} (empty page, or main-content selection failed to find any text)`);
  }

  // Extract PDF links from the page
  const linkedPdfs: Array<{ url: string; title?: string; linkText?: string }> = [];
  const seenPdfUrls = new Set<string>();

  doc.querySelectorAll('a[href]').forEach(anchor => {
    const href = anchor.getAttribute('href');
    if (!href) return;

    try {
      const absoluteUrl = new URL(href, effectiveBaseUrl).href;
      if (!/^https?:/i.test(absoluteUrl)) return; // no javascript:/data: links
      const lowerUrl = absoluteUrl.toLowerCase();

      if (lowerUrl.endsWith('.pdf') || lowerUrl.includes('.pdf?') || lowerUrl.includes('/pdf/')) {
        if (!seenPdfUrls.has(absoluteUrl)) {
          seenPdfUrls.add(absoluteUrl);
          const linkText = anchor.textContent?.trim() || undefined;
          const titleAttr = anchor.getAttribute('title')?.trim() || undefined;
          linkedPdfs.push({
            url: absoluteUrl,
            title: titleAttr || linkText || undefined,
            linkText: linkText,
          });
        }
      }
    } catch {}
  });

  const result: any = {
    title: doc.title || url,
    orderedElements,
    timestamp: new Date().toISOString(),
    wordCount: totalWords,
    isSoftNotFound,
  };

  if (linkedPdfs.length > 0) {
    result.linkedPdfs = linkedPdfs;
  }

  if (extractStructuredDataFlag) {
    const structuredData = extractStructuredData(doc);
    if (Object.keys(structuredData).length > 0) {
      result.structuredData = structuredData;
    }
  }

  return result;
}
