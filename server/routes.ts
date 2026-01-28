import type { Express } from "express";
import type { Server } from "http";
import { storage } from "./storage";
import { api } from "@shared/routes";
import { z } from "zod";
import { JSDOM } from "jsdom";

const CONCURRENCY = 10;

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
        const matches = content.matchAll(/Sitemap:\s*(.*)/gi);
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
    const setting = await storage.getSetting(req.params.key);
    if (!setting) {
      return res.status(404).json({ message: 'Setting not found' });
    }
    res.json(setting);
  });

  app.put(api.settings.set.path, async (req, res) => {
    const input = api.settings.set.input.parse(req.body);
    const setting = await storage.setSetting(req.params.key, input.value);
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

  return httpServer;
}
