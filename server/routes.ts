import type { Express } from "express";
import type { Server } from "http";
import { storage } from "./storage";
import { api } from "@shared/routes";
import { z } from "zod";
import { JSDOM } from "jsdom";
import { encode } from "gpt-tokenizer";
import crypto from "crypto";
import JSZip from "jszip";
import type { RagChunk, ProjectSettings, ScrapedElement, SitemapUrlEntry, StructuredData, ChunkQuality, TableChunk, CodeBlock, RateLimitState } from "@shared/schema";

const CONCURRENCY = 10;

// Default project settings with all new fields
function getDefaultSettings(): ProjectSettings {
  return {
    scraping: {
      parallelRequests: 10,
      delayMs: 500,
      contentSelectors: ['article', 'main', '.content', '#content'],
      excludeSelectors: ['nav', 'footer', 'header', '.sidebar', '.ads'],
      maxDepth: 5,
      rateLimiting: {
        enabled: true,
        baseDelayMs: 500,
        maxDelayMs: 30000,
        backoffMultiplier: 2,
      },
      proxies: [],
      rotateProxies: false,
      extractStructuredData: true,
    },
    chunking: {
      targetTokens: 350,
      overlapTokens: 55,
      boundaryRules: ['paragraph', 'heading'],
      preserveHeadingHierarchy: true,
      minChunkTokens: 50,
      preserveTables: true,
      preserveCodeBlocks: true,
      multiLanguageTokenization: true,
      qualityChecks: {
        enabled: true,
        minWordCount: 10,
        warnOnShortChunks: true,
        warnOnNoContent: true,
      },
      deduplication: {
        enabled: true,
        similarityThreshold: 0.95,
      },
    },
    ai: {
      enabled: false,
      model: 'gpt-4o-mini',
      features: {
        semanticChunking: false,
        summaries: false,
        keywordExtraction: false,
      },
      embeddings: {
        enabled: false,
        model: 'text-embedding-3-small',
        dimensions: 1536,
      },
      metadataEnrichment: {
        enabled: false,
        extractKeywords: true,
        generateSummary: true,
        detectCategory: false,
        extractEntities: false,
      },
    },
    export: {
      formats: ['json'],
      includeEmbeddings: false,
      incrementalUpdates: true,
    },
  };
}

// Chunking utility functions
function estimateTokens(text: string): number {
  try {
    return encode(text).length;
  } catch {
    // Fallback: ~4 chars per token
    return Math.ceil(text.length / 4);
  }
}

function sha256(text: string): string {
  return crypto.createHash('sha256').update(text).digest('hex');
}

function extractTextFromElements(elements: ScrapedElement[]): { text: string; heading: string | null; headingPath: string[] }[] {
  const sections: { text: string; heading: string | null; headingPath: string[] }[] = [];
  let currentHeading: string | null = null;
  let currentHeadingPath: string[] = [];
  let currentText = '';

  for (const el of elements) {
    if (el.type === 'heading' && el.content) {
      // Save previous section if has content
      if (currentText.trim()) {
        sections.push({ 
          text: currentText.trim(), 
          heading: currentHeading,
          headingPath: [...currentHeadingPath]
        });
      }
      currentHeading = el.content;
      currentText = el.content + '\n\n';
      
      // Update heading path based on level
      const level = el.level || 1;
      currentHeadingPath = currentHeadingPath.slice(0, level - 1);
      currentHeadingPath[level - 1] = el.content;
    } else if (el.type === 'paragraph' && el.content) {
      currentText += el.content + '\n\n';
    } else if (el.type === 'list' && el.children) {
      const listText = el.children.map((item: any) => `• ${typeof item === 'string' ? item : item.content || ''}`).join('\n');
      currentText += listText + '\n\n';
    } else if (el.type === 'blockquote' && el.content) {
      currentText += `> ${el.content}\n\n`;
    }
  }

  // Don't forget the last section
  if (currentText.trim()) {
    sections.push({ 
      text: currentText.trim(), 
      heading: currentHeading,
      headingPath: [...currentHeadingPath]
    });
  }

  return sections;
}

function getOverlapText(text: string, overlapTokens: number): string {
  if (overlapTokens <= 0) return '';
  
  // Split by sentences for cleaner overlap
  const sentences = text.split(/(?<=[.!?])\s+/);
  let overlap = '';
  let currentTokens = 0;
  
  // Work backwards from end to get overlap
  for (let i = sentences.length - 1; i >= 0 && currentTokens < overlapTokens; i--) {
    const sentenceTokens = estimateTokens(sentences[i]);
    if (currentTokens + sentenceTokens <= overlapTokens * 1.5) {
      overlap = sentences[i] + (overlap ? ' ' + overlap : '');
      currentTokens += sentenceTokens;
    } else {
      break;
    }
  }
  
  return overlap;
}

function chunkText(
  sections: { text: string; heading: string | null; headingPath: string[] }[],
  targetTokens: number,
  overlapTokens: number,
  minChunkTokens: number
): { text: string; heading: string | null; headingPath: string[] }[] {
  const chunks: { text: string; heading: string | null; headingPath: string[] }[] = [];
  let currentChunk = '';
  let currentHeading: string | null = null;
  let currentHeadingPath: string[] = [];

  function saveChunk() {
    if (currentChunk && estimateTokens(currentChunk) >= minChunkTokens) {
      chunks.push({ 
        text: currentChunk.trim(), 
        heading: currentHeading,
        headingPath: [...currentHeadingPath]
      });
      return true;
    }
    return false;
  }

  for (const section of sections) {
    const sectionTokens = estimateTokens(section.text);
    const currentTokens = estimateTokens(currentChunk);

    // If section fits in current chunk
    if (currentTokens + sectionTokens <= targetTokens) {
      if (!currentChunk) {
        currentHeading = section.heading;
        currentHeadingPath = section.headingPath;
      }
      currentChunk += (currentChunk ? '\n\n' : '') + section.text;
    } else if (sectionTokens > targetTokens) {
      // Section is too large - need to split it by paragraphs
      if (saveChunk()) {
        const overlap = getOverlapText(currentChunk, overlapTokens);
        currentChunk = overlap;
      }
      
      currentHeading = section.heading;
      currentHeadingPath = section.headingPath;
      
      const paragraphs = section.text.split(/\n\n+/);
      for (const para of paragraphs) {
        const paraTokens = estimateTokens(para);
        const chunkTokens = estimateTokens(currentChunk);
        
        if (chunkTokens + paraTokens > targetTokens) {
          if (saveChunk()) {
            const overlap = getOverlapText(currentChunk, overlapTokens);
            currentChunk = overlap + (overlap ? '\n\n' : '') + para;
          } else {
            currentChunk += (currentChunk ? '\n\n' : '') + para;
          }
        } else {
          currentChunk += (currentChunk ? '\n\n' : '') + para;
        }
      }
    } else {
      // Section doesn't fit but isn't too large - save current and start new
      if (saveChunk()) {
        const overlap = getOverlapText(currentChunk, overlapTokens);
        currentChunk = overlap + (overlap ? '\n\n' : '') + section.text;
      } else {
        currentChunk += (currentChunk ? '\n\n' : '') + section.text;
      }
      
      currentHeading = section.heading;
      currentHeadingPath = section.headingPath;
    }
  }

  // Don't forget the last chunk
  if (currentChunk) {
    const tokens = estimateTokens(currentChunk);
    if (tokens >= minChunkTokens) {
      chunks.push({ 
        text: currentChunk.trim(), 
        heading: currentHeading,
        headingPath: currentHeadingPath
      });
    } else if (chunks.length > 0) {
      // Merge with previous chunk if too small
      chunks[chunks.length - 1].text += '\n\n' + currentChunk.trim();
    } else {
      // Even if small, we need at least one chunk
      chunks.push({ 
        text: currentChunk.trim(), 
        heading: currentHeading,
        headingPath: currentHeadingPath
      });
    }
  }

  return chunks;
}

function generateChunksForProject(
  results: SitemapUrlEntry[],
  domain: string,
  settings: ProjectSettings
): RagChunk[] {
  const allChunks: RagChunk[] = [];
  const chunkingSettings = settings.chunking || {
    targetTokens: 350,
    overlapTokens: 55,
    minChunkTokens: 50,
    boundaryRules: ['paragraph', 'heading'],
    preserveHeadingHierarchy: true,
  };

  for (const entry of results) {
    if (!entry.scrapedData?.orderedElements) continue;

    const docId = `doc_${sha256(entry.loc).slice(0, 12)}`;
    const sections = extractTextFromElements(entry.scrapedData.orderedElements);
    
    const chunkedSections = chunkText(
      sections,
      chunkingSettings.targetTokens,
      chunkingSettings.overlapTokens,
      chunkingSettings.minChunkTokens
    );

    chunkedSections.forEach((chunk, index) => {
      const chunkId = `${docId}::c${String(index).padStart(4, '0')}`;
      const tokens = estimateTokens(chunk.text);
      
      let pathname = '/';
      try {
        pathname = new URL(entry.loc).pathname || '/';
      } catch {}

      const ragChunk: RagChunk = {
        chunk_id: chunkId,
        doc_id: docId,
        chunk_index: index,
        text: chunk.text,
        location: {
          url: entry.loc,
          heading_path: chunkingSettings.preserveHeadingHierarchy ? chunk.headingPath.filter(Boolean) : undefined,
        },
        structure: {
          section_path: chunk.headingPath.filter(Boolean).join(' > ') || null,
          heading: chunk.heading,
        },
        language: 'de', // Could be detected
        source: {
          source_url: `https://${domain}`,
        },
        hashes: {
          text_sha256: sha256(chunk.text),
        },
        tokens_estimate: tokens,
        citation: `${entry.scrapedData?.title || pathname}, ${chunk.heading || 'Inhalt'}`,
      };

      allChunks.push(ragChunk);
    });
  }

  return allChunks;
}

async function fetchWithTimeout(url: string, timeout = 15000): Promise<string> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeout);
  
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; SitemapScraper/1.0)',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      },
    });
    
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    
    return await response.text();
  } finally {
    clearTimeout(timeoutId);
  }
}

function validateUrl(url: string, baseDomain?: string): boolean {
  try {
    const u = new URL(url.trim());
    if (baseDomain) {
      const host = u.hostname.toLowerCase();
      const target = baseDomain.toLowerCase().replace(/^www\./, '').split('/')[0];
      return host.endsWith(target) || host.includes('.' + target);
    }
    return true;
  } catch {
    return false;
  }
}

async function discoverSitemaps(domain: string): Promise<string[]> {
  const sitemaps = new Set<string>();
  let baseUrl = domain.trim();
  if (!baseUrl.startsWith('http')) baseUrl = `https://${baseUrl}`;
  baseUrl = baseUrl.replace(/\/$/, '');
  const cleanDomain = baseUrl.replace(/^https?:\/\//, '').split('/')[0];
  
  const paths = ['/robots.txt', '/sitemap.xml', '/sitemap_index.xml', '/sitemap-index.xml', '/sitemap1.xml'];
  
  await Promise.all(paths.map(async (path) => {
    try {
      const content = await fetchWithTimeout(baseUrl + path);
      if (path === '/robots.txt') {
        const matches = Array.from(content.matchAll(/Sitemap:\s*(.*)/gi));
        for (const match of matches) {
          if (match[1]) {
            const url = match[1].trim();
            if (validateUrl(url, cleanDomain)) sitemaps.add(url);
          }
        }
      } else if (content.includes('<urlset') || content.includes('<sitemapindex')) {
        sitemaps.add(baseUrl + path);
      }
    } catch {}
  }));
  
  return Array.from(sitemaps);
}

function parseSitemap(xmlString: string, baseDomain?: string): { urls: any[], subSitemaps: string[] } {
  const results: any[] = [];
  const subSitemaps: string[] = [];
  
  const dom = new JSDOM(xmlString, { contentType: 'text/xml' });
  const doc = dom.window.document;
  
  const isError = doc.querySelector("parsererror");
  if (isError) {
    return { urls: results, subSitemaps };
  }
  
  doc.querySelectorAll("sitemap").forEach(idx => {
    const loc = idx.querySelector("loc")?.textContent;
    if (loc && validateUrl(loc, baseDomain)) subSitemaps.push(loc.trim());
  });
  
  doc.querySelectorAll("url").forEach(el => {
    const loc = el.querySelector("loc")?.textContent;
    if (!loc || !validateUrl(loc, baseDomain)) return;
    
    const images: any[] = [];
    el.querySelectorAll("image").forEach(img => {
      const iLoc = img.querySelector("loc")?.textContent;
      if (iLoc) images.push({ loc: iLoc });
    });
    
    const videos: any[] = [];
    el.querySelectorAll("video").forEach(vid => {
      const title = vid.querySelector("title")?.textContent;
      const thumbnailLoc = vid.querySelector("thumbnail_loc")?.textContent;
      if (title || thumbnailLoc) videos.push({ title, thumbnailLoc });
    });
    
    results.push({
      loc: loc.trim(),
      lastmod: el.querySelector("lastmod")?.textContent || undefined,
      changefreq: el.querySelector("changefreq")?.textContent || undefined,
      priority: el.querySelector("priority")?.textContent || undefined,
      images,
      videos,
    });
  });
  
  return { urls: results, subSitemaps };
}

function scrapePageContent(html: string, url: string): any {
  const dom = new JSDOM(html);
  const doc = dom.window.document;
  
  const orderedElements: any[] = [];
  let totalWords = 0;
  
  const mainContent = doc.querySelector('main, article, [role="main"], .content, #content, .post-content, .entry-content') || doc.body;
  
  function processNode(node: Node, depth = 0) {
    if (node.nodeType === 3) {
      return;
    }
    
    if (node.nodeType !== 1) return;
    
    const el = node as Element;
    const tag = el.tagName?.toLowerCase();
    
    if (['script', 'style', 'noscript', 'nav', 'header', 'footer', 'aside', 'iframe', 'svg', 'form'].includes(tag)) {
      return;
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
    } else if (tag === 'pre' || tag === 'code') {
      const text = el.textContent?.trim() || '';
      if (text && text.length > 5) {
        orderedElements.push({ type: 'code', tag, content: text });
      }
    } else if (tag === 'table') {
      const rows: string[][] = [];
      el.querySelectorAll('tr').forEach(tr => {
        const cells: string[] = [];
        tr.querySelectorAll('td, th').forEach(cell => {
          cells.push(cell.textContent?.trim() || '');
        });
        if (cells.length > 0) rows.push(cells);
      });
      if (rows.length > 0) {
        orderedElements.push({ type: 'table', children: rows });
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
          const absolute = new URL(src, url).href;
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
          const absolute = new URL(src, url).href;
          orderedElements.push({ type: 'media', tag: 'video', src: absolute });
        } catch {}
      }
    } else {
      el.childNodes.forEach(child => processNode(child, depth + 1));
    }
  }
  
  mainContent.childNodes.forEach(child => processNode(child));
  
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
  
  return {
    title: doc.title || url,
    orderedElements,
    timestamp: new Date().toISOString(),
    wordCount: totalWords,
  };
}

export async function registerRoutes(
  httpServer: Server,
  app: Express
): Promise<Server> {
  
  app.get(api.projects.list.path, async (req, res) => {
    const allProjects = await storage.getProjects();
    res.json(allProjects);
  });

  app.get(api.projects.get.path, async (req, res) => {
    const project = await storage.getProject(Number(req.params.id));
    if (!project) {
      return res.status(404).json({ message: 'Project not found' });
    }
    res.json(project);
  });

  app.post(api.projects.create.path, async (req, res) => {
    try {
      const input = api.projects.create.input.parse(req.body);
      const project = await storage.createProject({
        domain: input.domain,
        displayName: input.displayName || input.domain,
        status: input.status || 'idle',
        queue: input.queue || [],
        processed: input.processed || [],
        results: input.results || [],
        errors: input.errors || [],
        stats: input.stats || {
          totalSitemaps: 0,
          processedSitemaps: 0,
          totalUrls: 0,
          totalImages: 0,
          totalVideos: 0,
          startTime: Date.now(),
        },
      });
      res.status(201).json(project);
    } catch (err) {
      if (err instanceof z.ZodError) {
        return res.status(400).json({
          message: err.errors[0].message,
          field: err.errors[0].path.join('.'),
        });
      }
      throw err;
    }
  });

  app.put(api.projects.update.path, async (req, res) => {
    try {
      const input = api.projects.update.input.parse(req.body);
      const project = await storage.updateProject(Number(req.params.id), input);
      if (!project) {
        return res.status(404).json({ message: 'Project not found' });
      }
      res.json(project);
    } catch (err) {
      if (err instanceof z.ZodError) {
        return res.status(400).json({
          message: err.errors[0].message,
          field: err.errors[0].path.join('.'),
        });
      }
      throw err;
    }
  });

  app.delete(api.projects.delete.path, async (req, res) => {
    await storage.deleteProject(Number(req.params.id));
    res.status(204).send();
  });

  app.get(api.settings.get.path, async (req, res) => {
    const key = Array.isArray(req.params.key) ? req.params.key[0] : req.params.key;
    const setting = await storage.getSetting(key);
    if (!setting) {
      return res.status(404).json({ message: 'Setting not found' });
    }
    res.json(setting);
  });

  app.put(api.settings.set.path, async (req, res) => {
    const input = api.settings.set.input.parse(req.body);
    const key = Array.isArray(req.params.key) ? req.params.key[0] : req.params.key;
    const setting = await storage.setSetting(key, input.value);
    res.json(setting);
  });

  app.post(api.scrape.discover.path, async (req, res) => {
    try {
      const input = api.scrape.discover.input.parse(req.body);
      const sitemaps = await discoverSitemaps(input.domain);
      res.json({ sitemaps });
    } catch (err) {
      if (err instanceof z.ZodError) {
        return res.status(400).json({
          message: err.errors[0].message,
          field: err.errors[0].path.join('.'),
        });
      }
      res.status(400).json({ message: (err as Error).message });
    }
  });

  app.post(api.scrape.fetchSitemap.path, async (req, res) => {
    try {
      const input = api.scrape.fetchSitemap.input.parse(req.body);
      const xml = await fetchWithTimeout(input.url);
      const parsed = parseSitemap(xml);
      res.json(parsed);
    } catch (err) {
      if (err instanceof z.ZodError) {
        return res.status(400).json({
          message: err.errors[0].message,
          field: err.errors[0].path.join('.'),
        });
      }
      res.status(400).json({ message: (err as Error).message });
    }
  });

  app.post(api.scrape.fetchContent.path, async (req, res) => {
    try {
      const input = api.scrape.fetchContent.input.parse(req.body);
      const urls = input.urls.slice(0, CONCURRENCY);
      
      const results = await Promise.all(urls.map(async (url) => {
        try {
          const html = await fetchWithTimeout(url);
          const data = scrapePageContent(html, url);
          return { url, data, error: null };
        } catch (err) {
          return { url, data: null, error: (err as Error).message };
        }
      }));
      
      res.json({ results });
    } catch (err) {
      if (err instanceof z.ZodError) {
        return res.status(400).json({
          message: err.errors[0].message,
          field: err.errors[0].path.join('.'),
        });
      }
      res.status(400).json({ message: (err as Error).message });
    }
  });

  // Track active chunking operations for cancellation
  const activeChunkingJobs = new Map<number, { cancelled: boolean }>();

  // Generate chunks from scraped content (original endpoint for backwards compatibility)
  app.post('/api/projects/:id/chunks', async (req, res) => {
    try {
      const projectId = parseInt(req.params.id);
      const project = await storage.getProject(projectId);
      
      if (!project) {
        return res.status(404).json({ message: 'Project not found' });
      }

      const scrapedResults = (project.results || []).filter(r => r.scrapedData);
      if (scrapedResults.length === 0) {
        return res.status(400).json({ message: 'No scraped content available. Run deep scraping first.' });
      }

      const settings: ProjectSettings = project.projectSettings || getDefaultSettings();

      const chunks = generateChunksForProject(scrapedResults, project.domain, settings);

      await storage.updateProject(projectId, { chunks });

      res.json({ 
        success: true, 
        chunksGenerated: chunks.length,
        pagesProcessed: scrapedResults.length,
      });
    } catch (err) {
      console.error('Chunk generation error:', err);
      res.status(500).json({ message: (err as Error).message });
    }
  });

  // SSE endpoint for chunking with progress updates
  app.get('/api/projects/:id/chunks/stream', async (req, res) => {
    const projectId = parseInt(req.params.id);
    
    // Set SSE headers
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();

    const jobState = { cancelled: false };
    activeChunkingJobs.set(projectId, jobState);

    const sendEvent = (data: object) => {
      if (!res.writableEnded) {
        res.write(`data: ${JSON.stringify(data)}\n\n`);
      }
    };

    // Handle client disconnect
    req.on('close', () => {
      jobState.cancelled = true;
      activeChunkingJobs.delete(projectId);
    });

    try {
      const project = await storage.getProject(projectId);
      
      if (!project) {
        sendEvent({ type: 'error', message: 'Project not found' });
        res.end();
        return;
      }

      const scrapedResults = (project.results || []).filter(r => r.scrapedData);
      if (scrapedResults.length === 0) {
        sendEvent({ type: 'error', message: 'No scraped content available. Run deep scraping first.' });
        res.end();
        return;
      }

      const settings: ProjectSettings = project.projectSettings || getDefaultSettings();

      const chunkingSettings = settings.chunking || {
        targetTokens: 350,
        overlapTokens: 55,
        minChunkTokens: 50,
        boundaryRules: ['paragraph', 'heading'],
        preserveHeadingHierarchy: true,
      };

      const allChunks: RagChunk[] = [];
      const total = scrapedResults.length;

      for (let i = 0; i < scrapedResults.length; i++) {
        // Check for cancellation
        if (jobState.cancelled) {
          sendEvent({ type: 'cancelled', chunksGenerated: allChunks.length, pagesProcessed: i });
          res.end();
          activeChunkingJobs.delete(projectId);
          return;
        }

        const entry = scrapedResults[i];
        
        // Send progress update
        sendEvent({
          type: 'progress',
          current: i + 1,
          total,
          chunksGenerated: allChunks.length,
          currentUrl: entry.loc,
        });

        if (!entry.scrapedData?.orderedElements) continue;

        const docId = `doc_${sha256(entry.loc).slice(0, 12)}`;
        const sections = extractTextFromElements(entry.scrapedData.orderedElements);
        
        const chunkedSections = chunkText(
          sections,
          chunkingSettings.targetTokens,
          chunkingSettings.overlapTokens,
          chunkingSettings.minChunkTokens
        );

        chunkedSections.forEach((chunk, index) => {
          const chunkId = `${docId}::c${String(allChunks.length).padStart(4, '0')}`;
          const tokens = estimateTokens(chunk.text);
          
          let pathname = '/';
          try {
            pathname = new URL(entry.loc).pathname || '/';
          } catch {}

          const ragChunk: RagChunk = {
            chunk_id: chunkId,
            doc_id: docId,
            chunk_index: index,
            text: chunk.text,
            location: {
              url: entry.loc,
              heading_path: chunkingSettings.preserveHeadingHierarchy ? chunk.headingPath.filter(Boolean) : undefined,
            },
            structure: {
              section_path: chunk.headingPath.filter(Boolean).join(' > ') || null,
              heading: chunk.heading,
            },
            language: 'de',
            source: {
              source_url: `https://${project.domain}`,
            },
            hashes: {
              text_sha256: sha256(chunk.text),
            },
            tokens_estimate: tokens,
            citation: `${entry.scrapedData?.title || pathname}, ${chunk.heading || 'Inhalt'}`,
          };

          allChunks.push(ragChunk);
        });

        // Small delay to not overwhelm the client
        await new Promise(resolve => setTimeout(resolve, 10));
      }

      // Save chunks to database
      await storage.updateProject(projectId, { chunks: allChunks });

      // Send completion event
      sendEvent({
        type: 'complete',
        chunksGenerated: allChunks.length,
        pagesProcessed: scrapedResults.length,
        total: scrapedResults.length,
      });

      res.end();
      activeChunkingJobs.delete(projectId);

    } catch (err) {
      console.error('Chunk generation error:', err);
      sendEvent({ type: 'error', message: (err as Error).message });
      res.end();
      activeChunkingJobs.delete(projectId);
    }
  });

  // Cancel chunking endpoint
  app.post('/api/projects/:id/chunks/cancel', (req, res) => {
    const projectId = parseInt(req.params.id);
    const job = activeChunkingJobs.get(projectId);
    
    if (job) {
      job.cancelled = true;
      res.json({ success: true, message: 'Cancellation requested' });
    } else {
      res.json({ success: false, message: 'No active job found' });
    }
  });

  // Export RAG Pack as ZIP
  app.get('/api/projects/:id/rag-pack', async (req, res) => {
    try {
      const projectId = parseInt(req.params.id);
      const project = await storage.getProject(projectId);
      
      if (!project) {
        return res.status(404).json({ message: 'Project not found' });
      }

      const chunks = project.chunks || [];
      if (chunks.length === 0) {
        return res.status(400).json({ message: 'No chunks available. Generate chunks first.' });
      }

      const scrapedResults = (project.results || []).filter(r => r.scrapedData);
      const zip = new JSZip();
      const now = new Date().toISOString();

      // Create documents.jsonl
      const documentsJsonl = scrapedResults.map(entry => {
        const docId = `doc_${sha256(entry.loc).slice(0, 12)}`;
        return JSON.stringify({
          doc_id: docId,
          title: entry.scrapedData?.title || '',
          url: entry.loc,
          language: 'de',
          source: {
            source_type: 'website',
            source_url: `https://${project.domain}`,
          },
          dates: {
            scraped: entry.scrapedData?.timestamp || now,
            ingested: now,
          },
          hashes: {
            content_sha256: sha256(JSON.stringify(entry.scrapedData?.orderedElements || [])),
          },
        });
      }).join('\n');

      // Create chunks.jsonl
      const chunksJsonl = chunks.map(chunk => JSON.stringify(chunk)).join('\n');

      // Create manifest.json
      const chunkingSettings = project.projectSettings?.chunking || {
        targetTokens: 350,
        overlapTokens: 55,
        boundaryRules: ['paragraph', 'heading'],
      };

      const manifest = {
        rag_pack_version: '1.0',
        created_at: now,
        generator: {
          name: 'MapScraper Pro',
          version: '1.0',
        },
        source: {
          domain: project.domain,
          project_name: project.displayName || project.domain,
        },
        chunking: {
          target_tokens: chunkingSettings.targetTokens,
          overlap_tokens: chunkingSettings.overlapTokens,
          boundary_rules: chunkingSettings.boundaryRules,
        },
        counts: {
          documents: scrapedResults.length,
          chunks: chunks.length,
        },
        checksums: {
          'documents.jsonl': `sha256:${sha256(documentsJsonl)}`,
          'chunks.jsonl': `sha256:${sha256(chunksJsonl)}`,
        },
      };

      // Schema files
      const documentsSchema = {
        "$schema": "https://json-schema.org/draft/2020-12/schema",
        "title": "documents.jsonl schema",
        "type": "object",
        "required": ["doc_id", "title", "url", "language", "source", "dates", "hashes"],
        "properties": {
          "doc_id": { "type": "string" },
          "title": { "type": "string" },
          "url": { "type": "string" },
          "language": { "type": "string" },
          "source": { "type": "object" },
          "dates": { "type": "object" },
          "hashes": { "type": "object" },
        },
      };

      const chunksSchema = {
        "$schema": "https://json-schema.org/draft/2020-12/schema",
        "title": "chunks.jsonl schema",
        "type": "object",
        "required": ["chunk_id", "doc_id", "chunk_index", "text", "location", "structure", "language", "source", "hashes"],
        "properties": {
          "chunk_id": { "type": "string" },
          "doc_id": { "type": "string" },
          "chunk_index": { "type": "integer", "minimum": 0 },
          "text": { "type": "string", "minLength": 1 },
          "location": { "type": "object" },
          "structure": { "type": "object" },
          "language": { "type": "string" },
          "source": { "type": "object" },
          "hashes": { "type": "object" },
          "tokens_estimate": { "type": "integer" },
          "citation": { "type": "string" },
        },
      };

      const manifestSchema = {
        "$schema": "https://json-schema.org/draft/2020-12/schema",
        "title": "manifest.json schema",
        "type": "object",
        "required": ["rag_pack_version", "created_at", "generator", "source", "chunking", "counts", "checksums"],
      };

      // Add files to ZIP
      zip.file('documents.jsonl', documentsJsonl);
      zip.file('chunks.jsonl', chunksJsonl);
      zip.file('manifest.json', JSON.stringify(manifest, null, 2));
      zip.folder('schema')?.file('documents.schema.json', JSON.stringify(documentsSchema, null, 2));
      zip.folder('schema')?.file('chunks.schema.json', JSON.stringify(chunksSchema, null, 2));
      zip.folder('schema')?.file('manifest.schema.json', JSON.stringify(manifestSchema, null, 2));

      // Generate ZIP buffer
      const zipBuffer = await zip.generateAsync({ type: 'nodebuffer' });

      // Set headers and send
      const fileName = `rag_pack_${project.domain.replace(/[^a-z0-9]/gi, '_')}_${Date.now()}.zip`;
      res.setHeader('Content-Type', 'application/zip');
      res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
      res.setHeader('Content-Length', zipBuffer.length);
      res.send(zipBuffer);

    } catch (err) {
      console.error('RAG Pack export error:', err);
      res.status(500).json({ message: (err as Error).message });
    }
  });

  return httpServer;
}
