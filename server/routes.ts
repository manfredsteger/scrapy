import type { Express } from "express";
import type { Server } from "http";
import { storage } from "./storage";
import { db } from "./db";
import { sql } from "drizzle-orm";
import { api } from "@shared/routes";
import { z } from "zod";
import { JSDOM } from "jsdom";
import { encode } from "gpt-tokenizer";
import crypto from "crypto";
import path from "path";
import fsPromises from "fs/promises";
import JSZip from "jszip";
import { ProxyAgent, fetch as undiciFetch } from "undici";
import type { RagChunk, ProjectSettings, ScrapedElement, SitemapUrlEntry, StructuredData, ChunkQuality, TableChunk, CodeBlock, RateLimitState, ProxyConfig, ChunkStats } from "@shared/schema";
import { MoodleScraper } from "./scrapers/moodle-scraper";
import * as fileStorage from './fileStorage';
import { orderedElementsToMarkdown } from './markdownConverter';
import multer from 'multer';

const CONCURRENCY = 10;

async function loadResultsWithFilesystem(
  results: any[],
  projectId: number,
  domain: string
): Promise<any[]> {
  const enriched: any[] = [];
  for (const r of results) {
    if (r.scrapedData) {
      enriched.push(r);
    } else if (r.hasScrapedData && r.loc) {
      try {
        const pageDir = fileStorage.getProjectPageDir(projectId, domain, r.loc);
        const meta = await fileStorage.readPageMeta(pageDir);
        if (meta) {
          enriched.push({
            ...r,
            scrapedData: {
              title: meta.title,
              timestamp: meta.timestamp,
              wordCount: meta.wordCount,
              structuredData: meta.structuredData,
              linkedPdfs: meta.linkedPdfs,
              orderedElements: meta.orderedElements || [],
            },
          });
        }
      } catch {}
    }
  }
  return enriched;
}

async function loadProjectChunks(project: any): Promise<any[]> {
  const fsChunks = await fileStorage.readProjectChunks(project.id, project.domain);
  if (fsChunks && fsChunks.length > 0) return fsChunks;
  return project.chunks || [];
}

async function loadSinglePageChunks(singlePage: any): Promise<any[]> {
  const fsChunks = await fileStorage.readSinglePageChunks(singlePage.id, singlePage.domain);
  if (fsChunks && fsChunks.length > 0) return fsChunks;
  return singlePage.chunks || [];
}

// Rate Limiter class for managing request delays with auto-adjustment
class RateLimiter {
  private currentDelay: number;
  private baseDelay: number;
  private maxDelay: number;
  private backoffMultiplier: number;
  private consecutiveErrors: number = 0;
  private consecutiveSuccesses: number = 0;
  private lastRequestTime: number = 0;
  private enabled: boolean;

  constructor(settings: ProjectSettings['scraping']['rateLimiting']) {
    this.enabled = settings.enabled;
    this.baseDelay = settings.baseDelayMs;
    this.maxDelay = settings.maxDelayMs;
    this.backoffMultiplier = settings.backoffMultiplier;
    this.currentDelay = settings.baseDelayMs;
  }

  async waitBeforeRequest(): Promise<void> {
    if (!this.enabled) return;
    
    const now = Date.now();
    const timeSinceLastRequest = now - this.lastRequestTime;
    const waitTime = Math.max(0, this.currentDelay - timeSinceLastRequest);
    
    if (waitTime > 0) {
      await new Promise(resolve => setTimeout(resolve, waitTime));
    }
    
    this.lastRequestTime = Date.now();
  }

  onSuccess(): void {
    if (!this.enabled) return;
    
    this.consecutiveErrors = 0;
    this.consecutiveSuccesses++;
    
    // Gradually decrease delay after 3 consecutive successes
    if (this.consecutiveSuccesses >= 3 && this.currentDelay > this.baseDelay) {
      const newDelay = Math.max(this.baseDelay, this.currentDelay / this.backoffMultiplier);
      if (newDelay !== this.currentDelay) {
        console.log(`[RateLimiter] Decreasing delay: ${this.currentDelay}ms -> ${newDelay}ms (${this.consecutiveSuccesses} consecutive successes)`);
        this.currentDelay = newDelay;
        this.consecutiveSuccesses = 0;
      }
    }
  }

  onRateLimit(): void {
    if (!this.enabled) return;
    
    this.consecutiveSuccesses = 0;
    this.consecutiveErrors++;
    
    const newDelay = Math.min(this.maxDelay, this.currentDelay * this.backoffMultiplier);
    console.log(`[RateLimiter] Rate limit hit (429). Increasing delay: ${this.currentDelay}ms -> ${newDelay}ms`);
    this.currentDelay = newDelay;
  }

  onError(): void {
    if (!this.enabled) return;
    
    this.consecutiveSuccesses = 0;
    this.consecutiveErrors++;
    
    // Only increase delay if we get multiple consecutive errors
    if (this.consecutiveErrors >= 2) {
      const newDelay = Math.min(this.maxDelay, this.currentDelay * 1.5);
      console.log(`[RateLimiter] Multiple errors (${this.consecutiveErrors}). Adjusting delay: ${this.currentDelay}ms -> ${newDelay}ms`);
      this.currentDelay = newDelay;
    }
  }

  getState(): RateLimitState {
    return {
      currentDelay: this.currentDelay,
      baseDelay: this.baseDelay,
      maxDelay: this.maxDelay,
      backoffMultiplier: this.backoffMultiplier,
      consecutiveErrors: this.consecutiveErrors,
      lastRequestTime: this.lastRequestTime,
    };
  }

  getCurrentDelay(): number {
    return this.currentDelay;
  }
}

// Proxy Rotator class for cycling through proxies
class ProxyRotator {
  private proxies: ProxyConfig[];
  private currentIndex: number = 0;
  private failedProxies: Map<string, { failCount: number; lastFailTime: number }> = new Map();
  private readonly maxFailCount: number = 3;
  private readonly failCooldownMs: number = 60000; // 1 minute cooldown
  private enabled: boolean;

  constructor(proxies: ProxyConfig[], rotateEnabled: boolean) {
    this.proxies = proxies;
    this.enabled = rotateEnabled && proxies.length > 0;
  }

  private getProxyUrl(proxy: ProxyConfig): string {
    let auth = '';
    if (proxy.username && proxy.password) {
      auth = `${encodeURIComponent(proxy.username)}:${encodeURIComponent(proxy.password)}@`;
    }
    
    // Normalize protocol - undici uses socks5 directly
    const protocol = proxy.protocol || 'http';
    
    // Parse the URL to extract host and port
    let url = proxy.url;
    if (!url.includes('://')) {
      url = `${protocol}://${auth}${url}`;
    } else {
      // Replace protocol if it exists
      url = url.replace(/^[a-z0-9]+:\/\//, `${protocol}://${auth}`);
    }
    
    return url;
  }

  private isProxyAvailable(proxyUrl: string): boolean {
    const failInfo = this.failedProxies.get(proxyUrl);
    if (!failInfo) return true;
    
    // Check if cooldown has passed
    if (Date.now() - failInfo.lastFailTime > this.failCooldownMs) {
      this.failedProxies.delete(proxyUrl);
      return true;
    }
    
    return failInfo.failCount < this.maxFailCount;
  }

  getNextProxy(): { proxyUrl: string; proxyConfig: ProxyConfig } | null {
    if (!this.enabled || this.proxies.length === 0) {
      return null;
    }

    const startIndex = this.currentIndex;
    let attempts = 0;
    
    while (attempts < this.proxies.length) {
      const proxy = this.proxies[this.currentIndex];
      const proxyUrl = this.getProxyUrl(proxy);
      
      this.currentIndex = (this.currentIndex + 1) % this.proxies.length;
      attempts++;
      
      if (this.isProxyAvailable(proxyUrl)) {
        console.log(`[ProxyRotator] Using proxy: ${proxy.url} (protocol: ${proxy.protocol})`);
        return { proxyUrl, proxyConfig: proxy };
      }
    }
    
    // All proxies are failed, reset and try the first one
    console.log(`[ProxyRotator] All proxies failed, resetting fail counts`);
    this.failedProxies.clear();
    const proxy = this.proxies[0];
    this.currentIndex = 1 % this.proxies.length;
    return { proxyUrl: this.getProxyUrl(proxy), proxyConfig: proxy };
  }

  markProxyFailed(proxyUrl: string): void {
    const existing = this.failedProxies.get(proxyUrl);
    if (existing) {
      existing.failCount++;
      existing.lastFailTime = Date.now();
      console.log(`[ProxyRotator] Proxy failed (${existing.failCount}/${this.maxFailCount}): ${proxyUrl}`);
    } else {
      this.failedProxies.set(proxyUrl, { failCount: 1, lastFailTime: Date.now() });
      console.log(`[ProxyRotator] Proxy failed (1/${this.maxFailCount}): ${proxyUrl}`);
    }
  }

  markProxySuccess(proxyUrl: string): void {
    // Reset fail count on success
    if (this.failedProxies.has(proxyUrl)) {
      this.failedProxies.delete(proxyUrl);
      console.log(`[ProxyRotator] Proxy recovered: ${proxyUrl}`);
    }
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  getProxyCount(): number {
    return this.proxies.length;
  }

  getAvailableProxyCount(): number {
    return this.proxies.filter(p => this.isProxyAvailable(this.getProxyUrl(p))).length;
  }
}

// Enhanced fetch function with proxy and rate limiting support
interface FetchOptions {
  rateLimiter?: RateLimiter;
  proxyRotator?: ProxyRotator;
  timeout?: number;
  retries?: number;
}

async function fetchWithRateLimitAndProxy(
  url: string,
  options: FetchOptions = {}
): Promise<{ text: string; statusCode: number; usedProxy?: string }> {
  const { rateLimiter, proxyRotator, timeout = 15000, retries = 2 } = options;
  
  // Wait for rate limit before making request
  if (rateLimiter) {
    await rateLimiter.waitBeforeRequest();
  }
  
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeout);
  
  let lastError: Error | null = null;
  let attemptCount = 0;
  
  // Try with proxies first if enabled, then fallback to direct
  const proxyInfo = proxyRotator?.isEnabled() ? proxyRotator.getNextProxy() : null;
  const attemptsToMake = proxyInfo ? retries + 1 : 1;
  
  while (attemptCount < attemptsToMake) {
    attemptCount++;
    const currentProxyInfo = attemptCount === 1 ? proxyInfo : 
      (proxyRotator?.isEnabled() ? proxyRotator.getNextProxy() : null);
    
    try {
      let response: Response;
      
      if (currentProxyInfo) {
        // Use undici fetch with ProxyAgent
        const agent = new ProxyAgent(currentProxyInfo.proxyUrl);
        response = await undiciFetch(url, {
          signal: controller.signal,
          headers: {
            'User-Agent': 'Mozilla/5.0 (compatible; SitemapScraper/1.0)',
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          },
          dispatcher: agent,
        }) as unknown as Response;
      } else {
        // Direct fetch without proxy
        response = await fetch(url, {
          signal: controller.signal,
          headers: {
            'User-Agent': 'Mozilla/5.0 (compatible; SitemapScraper/1.0)',
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          },
        });
      }
      
      // Handle rate limiting (429)
      if (response.status === 429) {
        rateLimiter?.onRateLimit();
        
        // Check for Retry-After header
        const retryAfter = response.headers.get('Retry-After');
        if (retryAfter) {
          const waitMs = parseInt(retryAfter) * 1000 || 5000;
          console.log(`[Fetch] Rate limited, waiting ${waitMs}ms (Retry-After header)`);
          await new Promise(resolve => setTimeout(resolve, waitMs));
        }
        
        if (currentProxyInfo && proxyRotator) {
          proxyRotator.markProxyFailed(currentProxyInfo.proxyUrl);
        }
        
        if (attemptCount < attemptsToMake) continue;
        throw new Error(`HTTP 429 - Rate Limited`);
      }
      
      if (!response.ok) {
        rateLimiter?.onError();
        if (currentProxyInfo && proxyRotator) {
          proxyRotator.markProxyFailed(currentProxyInfo.proxyUrl);
        }
        throw new Error(`HTTP ${response.status}`);
      }
      
      const text = await response.text();
      
      // Success - update rate limiter and proxy rotator
      rateLimiter?.onSuccess();
      if (currentProxyInfo && proxyRotator) {
        proxyRotator.markProxySuccess(currentProxyInfo.proxyUrl);
      }
      
      return { 
        text, 
        statusCode: response.status, 
        usedProxy: currentProxyInfo?.proxyConfig.url 
      };
      
    } catch (err) {
      lastError = err as Error;
      
      if (currentProxyInfo && proxyRotator) {
        proxyRotator.markProxyFailed(currentProxyInfo.proxyUrl);
      }
      rateLimiter?.onError();
      
      // If we have more attempts, continue
      if (attemptCount < attemptsToMake) {
        console.log(`[Fetch] Attempt ${attemptCount} failed for ${url}: ${lastError.message}. Retrying...`);
        continue;
      }
    }
  }
  
  clearTimeout(timeoutId);
  throw lastError || new Error('Fetch failed');
}

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
      targetTokens: 512,
      overlapTokens: 100,
      boundaryRules: ['paragraph', 'heading'],
      preserveHeadingHierarchy: true,
      minChunkTokens: 80,
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
        similarityThreshold: 0.90,
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
      includeAssets: true,
      incrementalUpdates: true,
    },
  };
}

// CJK character detection regex (Chinese, Japanese, Korean)
const CJK_REGEX = /[\u3000-\u303f\u3040-\u309f\u30a0-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\ufe30-\ufe4f\u20000-\u2a6df\u2a700-\u2b73f\u2b740-\u2b81f\u2b820-\u2ceaf\u2ceb0-\u2ebef\u30000-\u3134f\uac00-\ud7af\u1100-\u11ff\u3130-\u318f\ua960-\ua97f\ud7b0-\ud7ff]/g;

// Chunking utility functions
function estimateTokensFast(text: string): number {
  if (!text) return 0;
  return Math.ceil(text.length / 4);
}

async function extractPdfText(buffer: Buffer): Promise<{ text: string; metadata: any; numPages: number } | null> {
  try {
    const { PDFParse } = await import('pdf-parse');
    const uint8 = new Uint8Array(buffer);
    const parser = new PDFParse(uint8);
    await parser.load();
    const textResult = await parser.getText();
    const info = await parser.getInfo();
    const numPages = parser.doc?.numPages || 0;

    let fullText = '';
    if (textResult && textResult.pages && Array.isArray(textResult.pages)) {
      fullText = textResult.pages.map((p: any) => p.text || '').join('\n\n');
    }

    return {
      text: fullText,
      metadata: info || {},
      numPages,
    };
  } catch (err) {
    console.warn('[PDF] Parse error:', (err as Error).message);
    return null;
  }
}

function isValidPdfText(text: string): { valid: boolean; reason: string } {
  if (!text || text.trim().length < 50) {
    return { valid: false, reason: 'too_short' };
  }
  if (text.trim().startsWith('%PDF-')) {
    return { valid: false, reason: 'pdf_binary_signature' };
  }
  const sampleSize = Math.min(text.length, 5000);
  const sample = text.slice(0, sampleSize);
  let nonPrintable = 0;
  let replacementChars = 0;
  for (let i = 0; i < sample.length; i++) {
    const code = sample.charCodeAt(i);
    if (code < 32 && code !== 10 && code !== 13 && code !== 9) nonPrintable++;
    if (code === 0xFFFD) replacementChars++;
  }
  const garbageRatio = (nonPrintable + replacementChars) / Math.max(sample.length, 1);
  if (garbageRatio > 0.15) {
    return { valid: false, reason: 'high_garbage_ratio' };
  }

  const chunks = [
    text.slice(0, 2000),
    text.slice(Math.floor(text.length * 0.25), Math.floor(text.length * 0.25) + 2000),
    text.slice(Math.floor(text.length * 0.5), Math.floor(text.length * 0.5) + 2000),
  ];
  let totalWords = 0;
  for (const chunk of chunks) {
    const words = chunk.match(/[a-zA-ZäöüÄÖÜßàáâãèéêëìíîïòóôõùúûüñçÀÁÂÃÈÉÊËÌÍÎÏÒÓÔÕÙÚÛÜÑÇ]{3,}/g) || [];
    totalWords += words.length;
  }
  if (totalWords < 5) {
    return { valid: false, reason: 'no_real_words' };
  }
  return { valid: true, reason: 'ok' };
}

function cleanPdfTitle(rawTitle: string, url: string): string {
  if (!rawTitle || rawTitle.includes('://') || rawTitle.endsWith('.pdf') || rawTitle.includes('/')) {
    const urlPath = url.split('/').pop()?.split('?')[0] || '';
    const baseName = urlPath.replace(/\.pdf$/i, '');
    if (baseName) {
      return baseName
        .replace(/[_-]/g, ' ')
        .replace(/\b\w/g, c => c.toUpperCase())
        .trim();
    }
    return 'Untitled PDF';
  }
  return rawTitle
    .replace(/\s*\|\s*(IFP\s+)?Familienhandbuch.*$/i, '')
    .replace(/\s*[-–]\s*(IFP\s+)?Familienhandbuch.*$/i, '')
    .trim() || 'Untitled';
}

function cleanHtmlTitle(rawTitle: string, url: string): string {
  if (!rawTitle) {
    try {
      const pathname = new URL(url).pathname;
      const lastSegment = pathname.split('/').filter(Boolean).pop() || '';
      const baseName = lastSegment.replace(/\.(php|html|htm|asp|aspx)$/i, '');
      if (baseName) {
        return baseName
          .replace(/[_-]/g, ' ')
          .replace(/\b\w/g, c => c.toUpperCase())
          .trim();
      }
    } catch {}
    return 'Untitled';
  }
  return rawTitle
    .replace(/\s*\|\s*(IFP\s+)?Familienhandbuch.*$/i, '')
    .replace(/\s*[-–]\s*(IFP\s+)?Familienhandbuch.*$/i, '')
    .replace(/\s*\|\s*Startseite.*$/i, '')
    .trim() || rawTitle;
}

function generateDescription(text: string, maxLength: number = 200): string {
  if (!text) return '';
  const lines = text.split(/\n+/).filter(l => l.trim().length > 30);
  const firstParagraph = lines[0] || text.slice(0, maxLength);
  const truncated = firstParagraph.slice(0, maxLength);
  const lastSentenceEnd = truncated.lastIndexOf('. ');
  if (lastSentenceEnd > maxLength * 0.5) {
    return truncated.slice(0, lastSentenceEnd + 1).trim();
  }
  return truncated.trim() + (firstParagraph.length > maxLength ? '...' : '');
}

function getCategoryFromUrl(url: string): string {
  try {
    const pathname = new URL(url).pathname;
    const segments = pathname.split('/').filter(Boolean);
    if (segments.length >= 2) {
      const category = segments[0]
        .replace(/[_-]/g, ' ')
        .replace(/\b\w/g, c => c.toUpperCase());
      return category;
    }
  } catch {}
  return 'Allgemein';
}

function slugifyFilename(title: string, extension: string = '.html'): string {
  return title
    .toLowerCase()
    .replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue').replace(/ß/g, 'ss')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 120) + extension;
}

function estimateTokens(text: string, useMultiLanguage: boolean = true): number {
  try {
    // Use gpt-tokenizer for accurate token counting
    const baseTokens = encode(text).length;
    
    // For multi-language support, adjust for CJK characters
    // CJK characters typically need 2-3 tokens per character in most tokenizers
    if (useMultiLanguage) {
      const cjkMatches = text.match(CJK_REGEX);
      if (cjkMatches && cjkMatches.length > 0) {
        // CJK adjustment: each CJK char is roughly 2.5 tokens on average
        // gpt-tokenizer may undercount, so add correction factor
        const cjkCount = cjkMatches.length;
        const estimatedCjkTokens = Math.ceil(cjkCount * 2.5);
        // gpt-tokenizer typically counts CJK as 1-2 tokens, so add difference
        const correction = Math.max(0, estimatedCjkTokens - Math.ceil(cjkCount * 1.5));
        return baseTokens + correction;
      }
    }
    
    return baseTokens;
  } catch {
    // Fallback estimation with multi-language support
    const cjkMatches = text.match(CJK_REGEX);
    const cjkCount = cjkMatches?.length || 0;
    const nonCjkText = text.replace(CJK_REGEX, '');
    
    // ~4 chars per token for Latin text, ~2.5 tokens per CJK char
    const latinTokens = Math.ceil(nonCjkText.length / 4);
    const cjkTokens = Math.ceil(cjkCount * 2.5);
    
    return latinTokens + cjkTokens;
  }
}

// Calculate chunk quality metrics
function calculateChunkQuality(
  text: string,
  settings: {
    minWordCount: number;
    targetTokens: number;
    warnOnShortChunks: boolean;
    warnOnNoContent: boolean;
  }
): ChunkQuality {
  const tokenCount = estimateTokensFast(text);
  const words = text.trim().split(/\s+/).filter(w => w.length > 0);
  const wordCount = words.length;
  
  // Count sentences (basic heuristic)
  const sentences = text.split(/[.!?]+/).filter(s => s.trim().length > 0);
  const sentenceCount = sentences.length;
  
  // Check for meaningful content (not just whitespace/punctuation)
  const alphanumericContent = text.replace(/[\s.,!?;:'"()\[\]{}<>\/\\@#$%^&*_+=|~`-]/g, '');
  const hasContent = alphanumericContent.length > 0;
  
  const warnings: string[] = [];
  let quality: 'good' | 'warning' | 'poor' = 'good';
  
  // Check for short chunks
  if (settings.warnOnShortChunks && wordCount < settings.minWordCount) {
    warnings.push('Chunk is too short');
    quality = quality === 'good' ? 'warning' : quality;
  }
  
  // Check for no meaningful content
  if (settings.warnOnNoContent && !hasContent) {
    warnings.push('Chunk has no meaningful content');
    quality = 'poor';
  }
  
  // Check for oversized chunks (>150% of target)
  if (tokenCount > settings.targetTokens * 1.5) {
    warnings.push('Chunk exceeds target size');
    quality = quality === 'poor' ? 'poor' : 'warning';
  }
  
  // Downgrade to poor if multiple warnings
  if (warnings.length >= 2 && quality === 'warning') {
    quality = 'poor';
  }
  
  return {
    tokenCount,
    wordCount,
    sentenceCount,
    hasContent,
    quality,
    warnings: warnings.length > 0 ? warnings : undefined,
  };
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

function sha256(text: string): string {
  return crypto.createHash('sha256').update(text).digest('hex');
}

// Deduplication statistics
interface DeduplicationStats {
  totalChunks: number;
  exactDuplicates: number;
  nearDuplicates: number;
  uniqueChunks: number;
}

// Get word set from text for Jaccard similarity
function getWordSet(text: string): Set<string> {
  const words = text.toLowerCase()
    .replace(/[^a-zA-Z0-9\u00C0-\u024F\u3000-\u9FFF\s]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length > 1);
  return new Set(words);
}

// Calculate Jaccard similarity between two sets
function jaccardSimilarity(setA: Set<string>, setB: Set<string>): number {
  if (setA.size === 0 && setB.size === 0) return 1;
  if (setA.size === 0 || setB.size === 0) return 0;
  
  let intersectionSize = 0;
  const smallerArr = setA.size < setB.size ? Array.from(setA) : Array.from(setB);
  const larger = setA.size < setB.size ? setB : setA;
  
  for (let i = 0; i < smallerArr.length; i++) {
    if (larger.has(smallerArr[i])) {
      intersectionSize++;
    }
  }
  
  const unionSize = setA.size + setB.size - intersectionSize;
  return intersectionSize / unionSize;
}

// Deduplicate chunks by exact hash and near-duplicate similarity
function deduplicateChunks(
  chunks: RagChunk[],
  threshold: number = 0.90
): { chunks: RagChunk[]; stats: DeduplicationStats } {
  const stats: DeduplicationStats = {
    totalChunks: chunks.length,
    exactDuplicates: 0,
    nearDuplicates: 0,
    uniqueChunks: 0,
  };

  if (chunks.length === 0) {
    return { chunks: [], stats };
  }

  // First pass: Global exact duplicate detection by content hash
  const hashToOriginal = new Map<string, string>();
  const processedChunks: RagChunk[] = [];

  for (const chunk of chunks) {
    const hash = chunk.content_hash || sha256(chunk.text);

    if (hashToOriginal.has(hash)) {
      stats.exactDuplicates++;
      processedChunks.push({
        ...chunk,
        content_hash: hash,
        is_duplicate: true,
        duplicate_of: hashToOriginal.get(hash)!,
      });
    } else {
      hashToOriginal.set(hash, chunk.chunk_id);
      processedChunks.push({
        ...chunk,
        content_hash: hash,
        is_duplicate: false,
      });
    }
  }

  // Second pass: Near-duplicate detection per document (not global O(n²))
  // Group non-duplicate chunks by doc_id for efficient comparison
  const nonDuplicates = processedChunks.filter(c => !c.is_duplicate);
  const docGroups = new Map<string, RagChunk[]>();
  for (const chunk of nonDuplicates) {
    const docId = chunk.doc_id || 'unknown';
    if (!docGroups.has(docId)) {
      docGroups.set(docId, []);
    }
    docGroups.get(docId)!.push(chunk);
  }

  const nearDuplicateIds = new Set<string>();
  const nearDuplicateOf = new Map<string, string>();

  // Compare chunks only within the same document — O(k²) per doc, much faster
  const docGroupKeys = Array.from(docGroups.keys());
  for (const docKey of docGroupKeys) {
    const docChunks = docGroups.get(docKey)!;
    if (docChunks.length < 2) continue;

    const wordSets = new Map<string, Set<string>>();
    for (const chunk of docChunks) {
      wordSets.set(chunk.chunk_id, getWordSet(chunk.text));
    }

    for (let i = 1; i < docChunks.length; i++) {
      const chunkB = docChunks[i];
      if (nearDuplicateIds.has(chunkB.chunk_id)) continue;
      const setB = wordSets.get(chunkB.chunk_id)!;

      for (let j = 0; j < i; j++) {
        const chunkA = docChunks[j];
        if (nearDuplicateIds.has(chunkA.chunk_id)) continue;
        const setA = wordSets.get(chunkA.chunk_id)!;

        const sizeDiff = Math.abs(setA.size - setB.size);
        const maxSize = Math.max(setA.size, setB.size);
        if (maxSize > 0 && sizeDiff / maxSize > (1 - threshold)) {
          continue;
        }

        const similarity = jaccardSimilarity(setA, setB);
        if (similarity >= threshold) {
          nearDuplicateIds.add(chunkB.chunk_id);
          nearDuplicateOf.set(chunkB.chunk_id, chunkA.chunk_id);
          stats.nearDuplicates++;
          break;
        }
      }
    }
  }

  // Also do a lightweight cross-document exact-text dedup for common boilerplate
  // Use a hash of normalized text (lowercased, trimmed) to catch boilerplate across pages
  const normalizedHashToId = new Map<string, string>();
  for (const chunk of nonDuplicates) {
    if (nearDuplicateIds.has(chunk.chunk_id)) continue;
    const normalizedHash = sha256(chunk.text.toLowerCase().trim().replace(/\s+/g, ' '));
    if (normalizedHashToId.has(normalizedHash)) {
      nearDuplicateIds.add(chunk.chunk_id);
      nearDuplicateOf.set(chunk.chunk_id, normalizedHashToId.get(normalizedHash)!);
      stats.nearDuplicates++;
    } else {
      normalizedHashToId.set(normalizedHash, chunk.chunk_id);
    }
  }

  const finalChunks = processedChunks.map(chunk => {
    if (nearDuplicateIds.has(chunk.chunk_id)) {
      return {
        ...chunk,
        is_duplicate: true,
        duplicate_of: nearDuplicateOf.get(chunk.chunk_id),
      };
    }
    return chunk;
  });

  stats.uniqueChunks = stats.totalChunks - stats.exactDuplicates - stats.nearDuplicates;

  return { chunks: finalChunks, stats };
}

// OpenAI Embeddings Generation
interface EmbeddingResult {
  success: boolean;
  embedding?: number[];
  error?: string;
}

interface EmbeddingsStats {
  totalChunks: number;
  successful: number;
  failed: number;
  skipped: number;
  failedChunkIds: string[];
}

// AI Metadata Enrichment Types
interface EnrichmentResult {
  success: boolean;
  keywords?: string[];
  summary?: string;
  category?: string;
  entities?: Array<{ text: string; type: string }>;
  error?: string;
}

interface EnrichmentStats {
  totalChunks: number;
  successful: number;
  failed: number;
  skipped: number;
  keywordsExtracted: number;
  summariesGenerated: number;
  categoriesDetected: number;
  entitiesExtracted: number;
  failedChunkIds: string[];
}

interface EnrichmentSettings {
  extractKeywords: boolean;
  generateSummary: boolean;
  detectCategory: boolean;
  extractEntities: boolean;
}

// Call OpenAI Chat API for enrichment
async function callOpenAIChat(
  prompt: string,
  model: string,
  apiKey: string,
  retries: number = 3
): Promise<{ success: boolean; content?: string; error?: string }> {
  const baseDelay = 1000;
  
  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      const response = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model,
          messages: [
            { role: 'user', content: prompt }
          ],
          max_tokens: 500,
          temperature: 0.3,
        }),
      });
      
      if (response.status === 429) {
        const retryAfter = response.headers.get('Retry-After');
        const waitMs = retryAfter ? parseInt(retryAfter) * 1000 : baseDelay * Math.pow(2, attempt);
        console.log(`[Enrichment] Rate limited, waiting ${waitMs}ms before retry ${attempt + 1}/${retries}`);
        await new Promise(resolve => setTimeout(resolve, waitMs));
        continue;
      }
      
      if (!response.ok) {
        const errorBody = await response.text();
        throw new Error(`HTTP ${response.status}: ${errorBody}`);
      }
      
      const data = await response.json() as { choices: Array<{ message: { content: string } }> };
      
      if (data.choices && data.choices[0] && data.choices[0].message?.content) {
        return { success: true, content: data.choices[0].message.content.trim() };
      }
      
      throw new Error('Invalid response format from OpenAI');
    } catch (err) {
      const error = err as Error;
      
      if (error.message.includes('401') || error.message.includes('invalid_api_key')) {
        return { success: false, error: 'Invalid API key' };
      }
      
      if (attempt < retries - 1) {
        const waitMs = baseDelay * Math.pow(2, attempt);
        console.log(`[Enrichment] Error on attempt ${attempt + 1}/${retries}: ${error.message}. Retrying in ${waitMs}ms...`);
        await new Promise(resolve => setTimeout(resolve, waitMs));
        continue;
      }
      
      return { success: false, error: error.message };
    }
  }
  
  return { success: false, error: 'Max retries exceeded' };
}

// Extract keywords from text using GPT
async function extractKeywords(text: string, model: string, apiKey: string): Promise<string[] | null> {
  const prompt = `Extract 5-10 keywords from this text. Return only a JSON array of strings.\n\nText:\n${text.slice(0, 2000)}`;
  const result = await callOpenAIChat(prompt, model, apiKey);
  
  if (!result.success || !result.content) return null;
  
  try {
    // Try to parse as JSON
    const content = result.content.trim();
    // Handle cases where response might have markdown code blocks
    const jsonStr = content.replace(/^```json?\s*|\s*```$/g, '').trim();
    const parsed = JSON.parse(jsonStr);
    if (Array.isArray(parsed) && parsed.every(item => typeof item === 'string')) {
      return parsed;
    }
    return null;
  } catch {
    // Try to extract array from text
    const match = result.content.match(/\[[\s\S]*\]/);
    if (match) {
      try {
        const parsed = JSON.parse(match[0]);
        if (Array.isArray(parsed) && parsed.every(item => typeof item === 'string')) {
          return parsed;
        }
      } catch {}
    }
    return null;
  }
}

// Generate summary using GPT
async function generateSummary(text: string, model: string, apiKey: string): Promise<string | null> {
  const prompt = `Summarize this text in 1-2 sentences. Return only the summary text.\n\nText:\n${text.slice(0, 2000)}`;
  const result = await callOpenAIChat(prompt, model, apiKey);
  
  if (!result.success || !result.content) return null;
  return result.content.trim();
}

// Detect category using GPT
async function detectCategory(text: string, model: string, apiKey: string): Promise<string | null> {
  const validCategories = ['technical', 'tutorial', 'news', 'product', 'documentation', 'blog', 'other'];
  const prompt = `Classify this text into one category: technical, tutorial, news, product, documentation, blog, other. Return only the category.\n\nText:\n${text.slice(0, 2000)}`;
  const result = await callOpenAIChat(prompt, model, apiKey);
  
  if (!result.success || !result.content) return null;
  
  const category = result.content.trim().toLowerCase();
  if (validCategories.includes(category)) {
    return category;
  }
  
  // Try to find a valid category in the response
  for (const cat of validCategories) {
    if (result.content.toLowerCase().includes(cat)) {
      return cat;
    }
  }
  
  return 'other';
}

// Extract entities using GPT
async function extractEntities(text: string, model: string, apiKey: string): Promise<Array<{ text: string; type: string }> | null> {
  const prompt = `Extract named entities from this text. Return JSON: [{text: string, type: 'person'|'organization'|'location'|'product'}]\n\nText:\n${text.slice(0, 2000)}`;
  const result = await callOpenAIChat(prompt, model, apiKey);
  
  if (!result.success || !result.content) return null;
  
  try {
    const content = result.content.trim();
    const jsonStr = content.replace(/^```json?\s*|\s*```$/g, '').trim();
    const parsed = JSON.parse(jsonStr);
    
    if (Array.isArray(parsed)) {
      const validTypes = ['person', 'organization', 'location', 'product'];
      return parsed
        .filter((item: any) => 
          item && 
          typeof item.text === 'string' && 
          typeof item.type === 'string' &&
          validTypes.includes(item.type.toLowerCase())
        )
        .map((item: any) => ({
          text: item.text,
          type: item.type.toLowerCase(),
        }));
    }
    return null;
  } catch {
    // Try to extract array from text
    const match = result.content.match(/\[[\s\S]*\]/);
    if (match) {
      try {
        const parsed = JSON.parse(match[0]);
        if (Array.isArray(parsed)) {
          const validTypes = ['person', 'organization', 'location', 'product'];
          return parsed
            .filter((item: any) => 
              item && 
              typeof item.text === 'string' && 
              typeof item.type === 'string' &&
              validTypes.includes(item.type.toLowerCase())
            )
            .map((item: any) => ({
              text: item.text,
              type: item.type.toLowerCase(),
            }));
        }
      } catch {}
    }
    return null;
  }
}

// Enrich single chunk with AI metadata
async function enrichSingleChunk(
  chunk: RagChunk,
  enrichmentSettings: EnrichmentSettings,
  model: string,
  apiKey: string
): Promise<EnrichmentResult> {
  const result: EnrichmentResult = { success: true };
  
  try {
    // Run enabled enrichment tasks in parallel
    const tasks: Promise<void>[] = [];
    
    if (enrichmentSettings.extractKeywords) {
      tasks.push(
        extractKeywords(chunk.text, model, apiKey).then(keywords => {
          if (keywords) result.keywords = keywords;
        })
      );
    }
    
    if (enrichmentSettings.generateSummary) {
      tasks.push(
        generateSummary(chunk.text, model, apiKey).then(summary => {
          if (summary) result.summary = summary;
        })
      );
    }
    
    if (enrichmentSettings.detectCategory) {
      tasks.push(
        detectCategory(chunk.text, model, apiKey).then(category => {
          if (category) result.category = category;
        })
      );
    }
    
    if (enrichmentSettings.extractEntities) {
      tasks.push(
        extractEntities(chunk.text, model, apiKey).then(entities => {
          if (entities) result.entities = entities;
        })
      );
    }
    
    await Promise.all(tasks);
    
    return result;
  } catch (err) {
    return { success: false, error: (err as Error).message };
  }
}

// Main function to enrich chunks with AI metadata
async function enrichChunkMetadata(
  chunks: RagChunk[],
  enrichmentSettings: EnrichmentSettings,
  model: string,
  apiKey: string,
  onProgress?: (processed: number, total: number, stats: Partial<EnrichmentStats>) => void,
  checkCancelled?: () => boolean
): Promise<{ chunks: RagChunk[]; stats: EnrichmentStats }> {
  const BATCH_SIZE = 5;
  const BATCH_DELAY = 200; // Delay between batches to avoid rate limits
  
  const stats: EnrichmentStats = {
    totalChunks: chunks.length,
    successful: 0,
    failed: 0,
    skipped: 0,
    keywordsExtracted: 0,
    summariesGenerated: 0,
    categoriesDetected: 0,
    entitiesExtracted: 0,
    failedChunkIds: [],
  };
  
  if (chunks.length === 0) {
    return { chunks: [], stats };
  }
  
  const updatedChunks: RagChunk[] = [];
  
  // Process in batches
  for (let i = 0; i < chunks.length; i += BATCH_SIZE) {
    // Check for cancellation
    if (checkCancelled && checkCancelled()) {
      // Mark remaining chunks as skipped
      stats.skipped += chunks.length - i;
      for (let j = i; j < chunks.length; j++) {
        updatedChunks.push(chunks[j]);
      }
      break;
    }
    
    const batch = chunks.slice(i, Math.min(i + BATCH_SIZE, chunks.length));
    
    // Process batch in parallel
    const batchResults = await Promise.all(
      batch.map(async (chunk) => {
        // Skip duplicate chunks
        if (chunk.is_duplicate) {
          stats.skipped++;
          return chunk;
        }
        
        // Skip chunks that already have ai_metadata (updated_at set)
        if (chunk.updated_at && chunk.ai_metadata) {
          stats.skipped++;
          return chunk;
        }
        
        const result = await enrichSingleChunk(chunk, enrichmentSettings, model, apiKey);
        
        if (result.success) {
          stats.successful++;
          
          const aiMetadata: RagChunk['ai_metadata'] = {};
          
          if (result.keywords && result.keywords.length > 0) {
            aiMetadata.keywords = result.keywords;
            stats.keywordsExtracted++;
          }
          
          if (result.summary) {
            aiMetadata.summary = result.summary;
            stats.summariesGenerated++;
          }
          
          if (result.category) {
            aiMetadata.category = result.category;
            stats.categoriesDetected++;
          }
          
          if (result.entities && result.entities.length > 0) {
            aiMetadata.entities = result.entities;
            stats.entitiesExtracted++;
          }
          
          return {
            ...chunk,
            ai_metadata: aiMetadata,
            updated_at: new Date().toISOString(),
          };
        } else {
          stats.failed++;
          stats.failedChunkIds.push(chunk.chunk_id);
          console.log(`[Enrichment] Failed for chunk ${chunk.chunk_id}: ${result.error}`);
          return chunk;
        }
      })
    );
    
    updatedChunks.push(...batchResults);
    
    // Report progress
    if (onProgress) {
      onProgress(
        Math.min(i + BATCH_SIZE, chunks.length),
        chunks.length,
        {
          successful: stats.successful,
          failed: stats.failed,
          skipped: stats.skipped,
          keywordsExtracted: stats.keywordsExtracted,
          summariesGenerated: stats.summariesGenerated,
          categoriesDetected: stats.categoriesDetected,
          entitiesExtracted: stats.entitiesExtracted,
        }
      );
    }
    
    // Small delay between batches to avoid rate limits
    if (i + BATCH_SIZE < chunks.length) {
      await new Promise(resolve => setTimeout(resolve, BATCH_DELAY));
    }
  }
  
  return { chunks: updatedChunks, stats };
}

async function generateEmbedding(
  text: string,
  model: string = 'text-embedding-3-small',
  dimensions: number = 1536,
  apiKey: string,
  retries: number = 3
): Promise<EmbeddingResult> {
  const baseDelay = 1000;
  
  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      const response = await fetch('https://api.openai.com/v1/embeddings', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          input: text,
          model,
          dimensions,
        }),
      });
      
      if (response.status === 429) {
        // Rate limited - exponential backoff
        const retryAfter = response.headers.get('Retry-After');
        const waitMs = retryAfter ? parseInt(retryAfter) * 1000 : baseDelay * Math.pow(2, attempt);
        console.log(`[Embeddings] Rate limited, waiting ${waitMs}ms before retry ${attempt + 1}/${retries}`);
        await new Promise(resolve => setTimeout(resolve, waitMs));
        continue;
      }
      
      if (!response.ok) {
        const errorBody = await response.text();
        throw new Error(`HTTP ${response.status}: ${errorBody}`);
      }
      
      const data = await response.json() as { data: Array<{ embedding: number[] }> };
      
      if (data.data && data.data[0] && data.data[0].embedding) {
        return { success: true, embedding: data.data[0].embedding };
      }
      
      throw new Error('Invalid response format from OpenAI');
    } catch (err) {
      const error = err as Error;
      
      // Don't retry on non-retryable errors
      if (error.message.includes('401') || error.message.includes('invalid_api_key')) {
        return { success: false, error: 'Invalid API key' };
      }
      
      if (attempt < retries - 1) {
        const waitMs = baseDelay * Math.pow(2, attempt);
        console.log(`[Embeddings] Error on attempt ${attempt + 1}/${retries}: ${error.message}. Retrying in ${waitMs}ms...`);
        await new Promise(resolve => setTimeout(resolve, waitMs));
        continue;
      }
      
      return { success: false, error: error.message };
    }
  }
  
  return { success: false, error: 'Max retries exceeded' };
}

async function generateEmbeddingsForChunks(
  chunks: RagChunk[],
  settings: { model: string; dimensions: number },
  apiKey: string,
  onProgress?: (processed: number, total: number, successful: number, failed: number) => void,
  checkCancelled?: () => boolean
): Promise<{ chunks: RagChunk[]; stats: EmbeddingsStats }> {
  const BATCH_SIZE = 20;
  const BATCH_DELAY = 100; // Small delay between batches to avoid rate limits
  
  const stats: EmbeddingsStats = {
    totalChunks: chunks.length,
    successful: 0,
    failed: 0,
    skipped: 0,
    failedChunkIds: [],
  };
  
  if (chunks.length === 0) {
    return { chunks: [], stats };
  }
  
  const updatedChunks: RagChunk[] = [];
  
  // Process in batches
  for (let i = 0; i < chunks.length; i += BATCH_SIZE) {
    // Check for cancellation
    if (checkCancelled && checkCancelled()) {
      // Mark remaining chunks as skipped
      stats.skipped += chunks.length - i;
      for (let j = i; j < chunks.length; j++) {
        updatedChunks.push(chunks[j]);
      }
      break;
    }
    
    const batch = chunks.slice(i, Math.min(i + BATCH_SIZE, chunks.length));
    
    // Process batch in parallel
    const batchResults = await Promise.all(
      batch.map(async (chunk) => {
        // Skip duplicate chunks - they don't need embeddings
        if (chunk.is_duplicate) {
          stats.skipped++;
          return chunk;
        }
        
        // Skip chunks that already have embeddings
        if (chunk.embedding && chunk.embedding.length > 0) {
          stats.skipped++;
          return chunk;
        }
        
        const result = await generateEmbedding(
          chunk.text,
          settings.model,
          settings.dimensions,
          apiKey
        );
        
        if (result.success && result.embedding) {
          stats.successful++;
          return {
            ...chunk,
            embedding: result.embedding,
            updated_at: new Date().toISOString(),
          };
        } else {
          stats.failed++;
          stats.failedChunkIds.push(chunk.chunk_id);
          console.log(`[Embeddings] Failed for chunk ${chunk.chunk_id}: ${result.error}`);
          return chunk;
        }
      })
    );
    
    updatedChunks.push(...batchResults);
    
    // Report progress
    if (onProgress) {
      onProgress(
        Math.min(i + BATCH_SIZE, chunks.length),
        chunks.length,
        stats.successful,
        stats.failed
      );
    }
    
    // Small delay between batches to avoid rate limits
    if (i + BATCH_SIZE < chunks.length) {
      await new Promise(resolve => setTimeout(resolve, BATCH_DELAY));
    }
  }
  
  return { chunks: updatedChunks, stats };
}

// Extended section type to include tables and code blocks
interface ExtractedSection {
  text: string;
  heading: string | null;
  headingPath: string[];
  type: 'text' | 'table' | 'code';
  tableData?: TableChunk;
  codeBlock?: CodeBlock;
}

function extractSectionsFromPlainText(text: string): ExtractedSection[] {
  const sections: ExtractedSection[] = [];
  const lines = text.split('\n');
  let currentText = '';
  let currentHeading: string | null = null;
  let currentHeadingPath: string[] = [];

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) {
      if (currentText) currentText += '\n';
      continue;
    }
    const isHeadingLike = trimmed.length < 100 && trimmed.length > 2 &&
      !trimmed.endsWith('.') && !trimmed.endsWith(',') && !trimmed.endsWith(';') &&
      /^[A-ZÄÖÜ\d]/.test(trimmed) &&
      (trimmed === trimmed.toUpperCase() || /^[\d.]+\s/.test(trimmed) || trimmed.split(' ').length <= 8);

    if (isHeadingLike && currentText.trim().length > 50) {
      sections.push({
        text: currentText.trim(),
        heading: currentHeading,
        headingPath: [...currentHeadingPath],
        type: 'text',
      });
      currentText = trimmed + '\n\n';
      currentHeading = trimmed;
      currentHeadingPath = [trimmed];
    } else {
      currentText += trimmed + '\n';
    }
  }

  if (currentText.trim()) {
    sections.push({
      text: currentText.trim(),
      heading: currentHeading,
      headingPath: [...currentHeadingPath],
      type: 'text',
    });
  }

  if (sections.length === 0 && text.trim()) {
    sections.push({
      text: text.trim(),
      heading: null,
      headingPath: [],
      type: 'text',
    });
  }

  return sections;
}

function extractTextFromElements(
  elements: ScrapedElement[],
  options: { preserveTables?: boolean; preserveCodeBlocks?: boolean } = {}
): ExtractedSection[] {
  const { preserveTables = true, preserveCodeBlocks = true } = options;
  const sections: ExtractedSection[] = [];
  let currentHeading: string | null = null;
  let currentHeadingPath: string[] = [];
  let currentText = '';

  function savePendingText() {
    if (currentText.trim()) {
      sections.push({ 
        text: currentText.trim(), 
        heading: currentHeading,
        headingPath: [...currentHeadingPath],
        type: 'text',
      });
      currentText = '';
    }
  }

  for (const el of elements) {
    if (el.type === 'heading' && el.content) {
      // Save previous section if has content
      savePendingText();
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
    } else if (el.type === 'table' && preserveTables) {
      // Save any pending text first
      savePendingText();
      
      // Extract table data
      const headers: string[] = (el as any).headers || [];
      const rows: string[][] = (el as any).rows || el.children || [];
      const caption: string | undefined = (el as any).caption;
      
      // Create text representation for the chunk
      let tableText = '';
      if (caption) {
        tableText += `Table: ${caption}\n\n`;
      }
      if (headers.length > 0) {
        tableText += headers.join(' | ') + '\n';
        tableText += headers.map(() => '---').join(' | ') + '\n';
      }
      rows.forEach((row: string[]) => {
        tableText += row.join(' | ') + '\n';
      });
      
      const tableData: TableChunk = {
        headers,
        rows,
        caption,
      };
      
      sections.push({
        text: tableText.trim(),
        heading: currentHeading,
        headingPath: [...currentHeadingPath],
        type: 'table',
        tableData,
      });
    } else if (el.type === 'code' && preserveCodeBlocks && el.content) {
      // Save any pending text first
      savePendingText();
      
      const language = (el as any).language;
      const lineCount = (el as any).lineCount || el.content.split('\n').length;
      
      // Create text representation for the chunk
      let codeText = '';
      if (language) {
        codeText += `Code (${language}):\n`;
      }
      codeText += el.content;
      
      const codeBlock: CodeBlock = {
        language,
        code: el.content,
        lineCount,
      };
      
      sections.push({
        text: codeText.trim(),
        heading: currentHeading,
        headingPath: [...currentHeadingPath],
        type: 'code',
        codeBlock,
      });
    } else if (el.type === 'table' && !preserveTables) {
      // Convert table to text if not preserving
      const rows = el.children || [];
      const tableText = rows.map((row: string[]) => row.join(' | ')).join('\n');
      currentText += tableText + '\n\n';
    } else if (el.type === 'code' && !preserveCodeBlocks && el.content) {
      // Add code as regular text if not preserving
      currentText += '```\n' + el.content + '\n```\n\n';
    }
  }

  // Don't forget the last section
  savePendingText();

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
    const sentenceTokens = estimateTokensFast(sentences[i]);
    if (currentTokens + sentenceTokens <= overlapTokens * 1.5) {
      overlap = sentences[i] + (overlap ? ' ' + overlap : '');
      currentTokens += sentenceTokens;
    } else {
      break;
    }
  }
  
  return overlap;
}

// Chunked section with type information preserved
interface ChunkedSection extends ExtractedSection {
  // All properties inherited from ExtractedSection
}

function chunkText(
  sections: ExtractedSection[],
  targetTokens: number,
  overlapTokens: number,
  minChunkTokens: number
): ChunkedSection[] {
  const chunks: ChunkedSection[] = [];
  let currentChunk = '';
  let currentHeading: string | null = null;
  let currentHeadingPath: string[] = [];

  function saveTextChunk(): boolean {
    if (!currentChunk || !currentChunk.trim()) return false;
    const tokens = estimateTokensFast(currentChunk);
    if (tokens >= minChunkTokens) {
      chunks.push({ 
        text: currentChunk.trim(), 
        heading: currentHeading,
        headingPath: [...currentHeadingPath],
        type: 'text',
      });
      return true;
    }
    // Short chunk: merge with previous text chunk if possible (merge_if_possible_else_drop)
    if (chunks.length > 0 && chunks[chunks.length - 1].type === 'text') {
      chunks[chunks.length - 1].text += '\n\n' + currentChunk.trim();
      return true;
    }
    // No previous text chunk to merge with: drop the short chunk
    return false;
  }

  for (const section of sections) {
    // Tables and code blocks are preserved as-is (never split)
    if (section.type === 'table' || section.type === 'code') {
      // Save any pending text chunk first
      if (currentChunk.trim()) {
        saveTextChunk();
        currentChunk = '';
      }
      
      // Add the table/code as its own chunk (don't split it)
      chunks.push({
        text: section.text,
        heading: section.heading,
        headingPath: [...section.headingPath],
        type: section.type,
        tableData: section.tableData,
        codeBlock: section.codeBlock,
      });
      continue;
    }

    // Handle text sections with normal chunking logic
    const sectionTokens = estimateTokensFast(section.text);
    const currentTokens = estimateTokensFast(currentChunk);

    // If section fits in current chunk
    if (currentTokens + sectionTokens <= targetTokens) {
      if (!currentChunk) {
        currentHeading = section.heading;
        currentHeadingPath = section.headingPath;
      }
      currentChunk += (currentChunk ? '\n\n' : '') + section.text;
    } else if (sectionTokens > targetTokens) {
      // Section is too large - need to split it by paragraphs
      if (saveTextChunk()) {
        const overlap = getOverlapText(currentChunk, overlapTokens);
        currentChunk = overlap;
      }
      
      currentHeading = section.heading;
      currentHeadingPath = section.headingPath;
      
      const paragraphs = section.text.split(/\n\n+/);
      for (const para of paragraphs) {
        const paraTokens = estimateTokensFast(para);
        const chunkTokens = estimateTokensFast(currentChunk);
        
        if (chunkTokens + paraTokens > targetTokens) {
          if (saveTextChunk()) {
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
      if (saveTextChunk()) {
        const overlap = getOverlapText(currentChunk, overlapTokens);
        currentChunk = overlap + (overlap ? '\n\n' : '') + section.text;
      } else {
        currentChunk += (currentChunk ? '\n\n' : '') + section.text;
      }
      
      currentHeading = section.heading;
      currentHeadingPath = section.headingPath;
    }
  }

  // Don't forget the last text chunk
  if (currentChunk) {
    const tokens = estimateTokensFast(currentChunk);
    if (tokens >= minChunkTokens) {
      chunks.push({ 
        text: currentChunk.trim(), 
        heading: currentHeading,
        headingPath: currentHeadingPath,
        type: 'text',
      });
    } else if (chunks.length > 0 && chunks[chunks.length - 1].type === 'text') {
      // Merge with previous text chunk if too small
      chunks[chunks.length - 1].text += '\n\n' + currentChunk.trim();
    } else {
      // Even if small, we need at least one chunk
      chunks.push({ 
        text: currentChunk.trim(), 
        heading: currentHeading,
        headingPath: currentHeadingPath,
        type: 'text',
      });
    }
  }

  return chunks;
}

function generateChunksForProject(
  results: SitemapUrlEntry[],
  domain: string,
  settings: ProjectSettings
): { chunks: RagChunk[]; deduplicationStats?: DeduplicationStats } {
  const allChunks: RagChunk[] = [];
  const chunkingSettings = settings.chunking || {
    targetTokens: 512,
    overlapTokens: 100,
    minChunkTokens: 80,
    boundaryRules: ['paragraph', 'heading'],
    preserveHeadingHierarchy: true,
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
      similarityThreshold: 0.90,
    },
  };

  const useMultiLang = chunkingSettings.multiLanguageTokenization ?? true;
  const qualityChecksEnabled = chunkingSettings.qualityChecks?.enabled ?? true;

  for (const entry of results) {
    if (!entry.scrapedData?.orderedElements) continue;

    const docId = `doc_${sha256(entry.loc).slice(0, 12)}`;
    const sections = extractTextFromElements(entry.scrapedData.orderedElements, {
      preserveTables: chunkingSettings.preserveTables ?? true,
      preserveCodeBlocks: chunkingSettings.preserveCodeBlocks ?? true,
    });
    
    const chunkedSections = chunkText(
      sections,
      chunkingSettings.targetTokens,
      chunkingSettings.overlapTokens,
      chunkingSettings.minChunkTokens
    );

    chunkedSections.forEach((chunk, index) => {
      const chunkId = `${docId}::c${String(index).padStart(4, '0')}`;
      const tokens = estimateTokensFast(chunk.text);
      
      let pathname = '/';
      try {
        pathname = new URL(entry.loc).pathname || '/';
      } catch {}

      // Calculate quality metrics if enabled
      let quality: ChunkQuality | undefined;
      if (qualityChecksEnabled) {
        quality = calculateChunkQuality(chunk.text, {
          minWordCount: chunkingSettings.qualityChecks?.minWordCount ?? 10,
          targetTokens: chunkingSettings.targetTokens,
          warnOnShortChunks: chunkingSettings.qualityChecks?.warnOnShortChunks ?? true,
          warnOnNoContent: chunkingSettings.qualityChecks?.warnOnNoContent ?? true,
        });
      }

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
        chunk_type: chunk.type,
        table_data: chunk.tableData,
        code_block: chunk.codeBlock,
        quality,
        content_hash: sha256(chunk.text),
        created_at: new Date().toISOString(),
      };

      allChunks.push(ragChunk);
    });
  }

  // Apply deduplication if enabled
  const deduplicationEnabled = chunkingSettings.deduplication?.enabled ?? true;
  if (deduplicationEnabled) {
    const threshold = chunkingSettings.deduplication?.similarityThreshold ?? 0.95;
    const { chunks: deduplicatedChunks, stats } = deduplicateChunks(allChunks, threshold);
    return { chunks: deduplicatedChunks, deduplicationStats: stats };
  }

  return { chunks: allChunks };
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

async function discoverWikiJsPages(baseUrl: string): Promise<string[]> {
  const urls: string[] = [];
  try {
    const response = await fetch(`${baseUrl}/graphql`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        query: '{ pages { list { id path title } } }'
      })
    });
    
    if (response.ok) {
      const data = await response.json();
      if (data?.data?.pages?.list) {
        for (const page of data.data.pages.list) {
          if (page.path && page.path !== 'home') {
            urls.push(`${baseUrl}/${page.path}`);
          }
        }
        // Add home page
        urls.unshift(baseUrl);
        console.log(`[Wiki.js] Discovered ${urls.length} pages via GraphQL API`);
      }
    }
  } catch (err) {
    // Not a Wiki.js site or GraphQL not available
  }
  return urls;
}

async function isWikiJsSite(baseUrl: string): Promise<boolean> {
  try {
    const html = await fetchWithTimeout(baseUrl);
    // Wiki.js has characteristic markers
    return html.includes('siteConfig') && 
           (html.includes('wiki.js') || html.includes('WikiJS') || 
            html.includes('.is-asset-link') || html.includes('toc-header'));
  } catch {
    return false;
  }
}

// Discover sections within a Moodle course
async function discoverMoodleCourseSections(courseUrl: string): Promise<string[]> {
  const sections: string[] = [];
  const foundSections = new Set<number>();
  
  try {
    const html = await fetchWithTimeout(courseUrl);
    const dom = new JSDOM(html, { url: courseUrl });
    const doc = dom.window.document;
    
    // Clean URL to base course URL (remove any existing hash)
    const urlObj = new URL(courseUrl);
    urlObj.hash = '';
    const baseCourseUrl = urlObj.href;
    
    // Method 1: Check course-toc navigation for section links
    const tocNav = doc.querySelector('#course-toc, nav.course-toc, .drawer-course-content, .course-index');
    if (tocNav) {
      tocNav.querySelectorAll('a[href*="#section-"]').forEach(a => {
        const href = a.getAttribute('href');
        if (href) {
          const match = href.match(/#section-(\d+)/);
          if (match) {
            foundSections.add(parseInt(match[1]));
          }
        }
      });
    }
    
    // Method 2: Check for section elements directly in the page (various Moodle DOM variants)
    const sectionSelectors = [
      '[id^="section-"]',
      'li[id^="section-"]', 
      'section[id^="section-"]',
      'li.section[data-sectionid]',
      '.section[data-sectionid]',
      '.course-section[data-sectionnum]',
    ];
    
    sectionSelectors.forEach(selector => {
      doc.querySelectorAll(selector).forEach(el => {
        // Check for id="section-X"
        const id = el.getAttribute('id');
        if (id) {
          const match = id.match(/section-(\d+)/);
          if (match) {
            foundSections.add(parseInt(match[1]));
          }
        }
        // Check for data-sectionid or data-sectionnum
        const sectionId = el.getAttribute('data-sectionid') || el.getAttribute('data-sectionnum');
        if (sectionId) {
          const num = parseInt(sectionId);
          if (!isNaN(num)) foundSections.add(num);
        }
      });
    });
    
    // Method 3: Check for data-section attributes
    doc.querySelectorAll('[data-section]').forEach(el => {
      const sectionAttr = el.getAttribute('data-section');
      if (sectionAttr) {
        const sectionNum = parseInt(sectionAttr);
        if (!isNaN(sectionNum)) foundSections.add(sectionNum);
      }
    });
    
    // Method 4: Check .section list items in course-content
    doc.querySelectorAll('.course-content li.section, ul.topics > li, ul.weeks > li').forEach((el, index) => {
      // These are typically sequential sections
      const sectionId = el.getAttribute('data-sectionid');
      if (sectionId) {
        foundSections.add(parseInt(sectionId));
      } else {
        // Use index as section number
        foundSections.add(index);
      }
    });
    
    // If we found actual sections, use them; otherwise just return the base course URL
    if (foundSections.size > 0) {
      // Sort and generate section URLs
      const sortedSections = Array.from(foundSections).sort((a, b) => a - b);
      for (const sectionNum of sortedSections) {
        sections.push(`${baseCourseUrl}#section-${sectionNum}`);
      }
      console.log(`[Moodle] Discovered ${sections.length} sections for course: ${baseCourseUrl}`);
    } else {
      // No sections found - just scrape the course page as a whole
      sections.push(baseCourseUrl);
      console.log(`[Moodle] No sections detected, using course URL: ${baseCourseUrl}`);
    }
  } catch (error) {
    console.error('[Moodle] Error discovering course sections:', error);
    // Return at least the base course URL
    sections.push(courseUrl);
  }
  return sections;
}

// Check if URL is a direct Moodle course URL
function isMoodleCourseUrl(url: string): boolean {
  return /\/course\/view\.php\?id=\d+/.test(url);
}

async function discoverMoodleCourses(baseUrl: string): Promise<string[]> {
  const courses: string[] = [];
  try {
    // If this is a direct course URL, discover its sections instead
    if (isMoodleCourseUrl(baseUrl)) {
      console.log(`[Moodle] Direct course URL detected, discovering sections...`);
      return await discoverMoodleCourseSections(baseUrl);
    }
    
    const html = await fetchWithTimeout(baseUrl);
    const dom = new JSDOM(html, { url: baseUrl });
    const doc = dom.window.document;
    const origin = new URL(baseUrl).origin;
    
    // Extract course links from homepage
    const coursePattern = /\/course\/view\.php\?id=\d+/;
    doc.querySelectorAll('a[href]').forEach(a => {
      const href = a.getAttribute('href');
      if (!href) return;
      
      try {
        const resolvedUrl = new URL(href, baseUrl).href;
        if (coursePattern.test(resolvedUrl) && resolvedUrl.startsWith(origin)) {
          // Clean URL: keep only id parameter
          const urlObj = new URL(resolvedUrl);
          const id = urlObj.searchParams.get('id');
          if (id) {
            const cleanUrl = `${urlObj.origin}${urlObj.pathname}?id=${id}`;
            if (!courses.includes(cleanUrl)) {
              courses.push(cleanUrl);
            }
          }
        }
      } catch {}
    });
    
    // Also add the homepage itself
    if (!courses.includes(baseUrl)) {
      courses.unshift(baseUrl);
    }
    
    console.log(`[Moodle] Discovered ${courses.length} course URLs from ${baseUrl}`);
  } catch (error) {
    console.error('[Moodle] Error discovering courses:', error);
  }
  return courses;
}

async function isMoodleSite(baseUrl: string): Promise<boolean> {
  try {
    const html = await fetchWithTimeout(baseUrl);
    const htmlLower = html.toLowerCase();
    
    // Check for Moodle indicators
    const indicators = [
      html.includes('M.cfg') || html.includes('M.util'),
      htmlLower.includes('moodle'),
      html.includes('/course/view.php') || html.includes('/mod/'),
      html.includes('theme/') && html.includes('/pix/'),
      html.includes('/login/index.php'),
    ];
    
    const matchCount = indicators.filter(Boolean).length;
    return matchCount >= 2;
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

// Skip URLs that point to non-HTML content (PDFs, images, etc.)
const SKIP_EXTENSIONS = new Set(['.pdf', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx', '.zip', '.rar', '.tar', '.gz', '.7z', '.exe', '.dmg', '.iso', '.mp3', '.mp4', '.avi', '.mov', '.wmv', '.flv', '.webm', '.ogg', '.wav', '.jpg', '.jpeg', '.png', '.gif', '.bmp', '.svg', '.webp', '.ico', '.tiff']);

function shouldSkipUrl(url: string): boolean {
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

function scrapePageContent(html: string, url: string, extractStructuredDataFlag: boolean = true): any {
  const dom = new JSDOM(html, { url });
  const doc = dom.window.document;
  
  // Check for <base> tag to get the correct base URL for resolving relative URLs
  const baseTag = doc.querySelector('base');
  const effectiveBaseUrl = baseTag?.getAttribute('href') || url;
  
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
    };
    
    if (moodlePdfs.length > 0) {
      moodleResult.linkedPdfs = moodlePdfs;
    }
    
    return moodleResult;
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
      // Recurse into child nodes
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
  
  // Extract PDF links from the page
  const linkedPdfs: Array<{ url: string; title?: string; linkText?: string }> = [];
  const seenPdfUrls = new Set<string>();
  
  doc.querySelectorAll('a[href]').forEach(anchor => {
    const href = anchor.getAttribute('href');
    if (!href) return;
    
    try {
      const absoluteUrl = new URL(href, effectiveBaseUrl).href;
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

export async function registerRoutes(
  httpServer: Server,
  app: Express
): Promise<Server> {
  
  const EXPORT_RETENTION_DAYS = 30;

  async function saveRagPackExport(
    projectId: number,
    domain: string,
    downloadId: string,
    buffer: Buffer,
    filename: string,
    stats: { documents: number; chunks: number; pdfValid: number; pdfInvalid: number; assets: number }
  ): Promise<boolean> {
    try {
      const projectDir = fileStorage.getProjectDir(projectId, domain);
      const exportsDir = path.join(projectDir, 'exports');
      await fileStorage.ensureDir(exportsDir);
      const filePath = path.join(exportsDir, filename);
      await fsPromises.writeFile(filePath, buffer);
      const expiresAt = new Date();
      expiresAt.setDate(expiresAt.getDate() + EXPORT_RETENTION_DAYS);
      await storage.createRagPackExport({
        projectId,
        downloadId,
        filename,
        filePath,
        fileSize: buffer.length,
        documents: stats.documents,
        chunks: stats.chunks,
        pdfValid: stats.pdfValid,
        pdfInvalid: stats.pdfInvalid,
        assets: stats.assets,
        expiresAt,
      });
      return true;
    } catch (err) {
      console.error('[RAG Pack] Failed to save export:', err);
      return false;
    }
  }

  async function cleanupExpiredExports() {
    try {
      const expired = await storage.deleteExpiredRagPackExports();
      for (const entry of expired) {
        try {
          await fsPromises.unlink(entry.filePath);
        } catch {}
      }
      if (expired.length > 0) {
        console.log(`[RAG Pack] Cleaned up ${expired.length} expired exports`);
      }
    } catch (err) {
      console.error('[RAG Pack] Cleanup error:', err);
    }
  }

  cleanupExpiredExports();
  setInterval(cleanupExpiredExports, 24 * 60 * 60 * 1000);

  const converterUpload = multer({
    dest: './data/converter-uploads/',
    limits: { fileSize: 100 * 1024 * 1024 },
  });

  const converterDownloads = new Map<string, { path: string; filename: string; documents: number; chunks: number; assets: number }>();

  const TEXT_EXTENSIONS = new Set([
    '.txt', '.md', '.markdown', '.csv', '.tsv', '.json', '.xml',
    '.yaml', '.yml', '.log', '.ini', '.conf', '.cfg', '.properties',
    '.env', '.toml',
  ]);
  const HTML_EXTENSIONS = new Set(['.html', '.htm', '.xhtml']);
  const SKIP_EXTENSIONS = new Set(['.docx']);

  async function cleanupOldConverterSessions() {
    try {
      const converterDir = path.resolve('./data/converter');
      const entries = await fsPromises.readdir(converterDir, { withFileTypes: true }).catch(() => []);
      const now = Date.now();
      const maxAge = 24 * 60 * 60 * 1000;
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        try {
          const stat = await fsPromises.stat(path.join(converterDir, entry.name));
          if (now - stat.mtimeMs > maxAge) {
            await fsPromises.rm(path.join(converterDir, entry.name), { recursive: true, force: true });
            console.log(`[Converter] Cleaned up old session: ${entry.name}`);
          }
        } catch {}
      }
    } catch {}
  }

  cleanupOldConverterSessions();
  setInterval(cleanupOldConverterSessions, 60 * 60 * 1000);

  app.post('/api/converter/upload', converterUpload.array('files'), async (req, res) => {
    try {
      const files = req.files as Express.Multer.File[];
      if (!files || files.length === 0) {
        return res.status(400).json({ error: 'No files uploaded' });
      }

      const existingSessionId = req.body?.sessionId;
      const sessionId = existingSessionId || crypto.randomBytes(8).toString('hex');
      const uploadsDir = path.resolve(`./data/converter/${sessionId}/uploads`);
      await fileStorage.ensureDir(uploadsDir);

      const fileInfos: { name: string; size: number; type: string }[] = [];

      for (const file of files) {
        const safeName = path.basename(file.originalname).replace(/[^a-zA-Z0-9._\-äöüÄÖÜß ]/g, '_');
        const destPath = path.join(uploadsDir, safeName);
        await fsPromises.rename(file.path, destPath);
        fileInfos.push({
          name: safeName,
          size: file.size,
          type: file.mimetype || 'application/octet-stream',
        });
      }

      res.json({ sessionId, files: fileInfos });
    } catch (err) {
      console.error('[Converter] Upload error:', err);
      res.status(500).json({ error: 'Upload failed' });
    }
  });

  app.post('/api/converter/:sessionId/generate', async (req, res) => {
    const { sessionId } = req.params;
    const uploadsDir = path.resolve(`./data/converter/${sessionId}/uploads`);

    try {
      await fsPromises.access(uploadsDir);
    } catch {
      return res.status(404).json({ error: 'Session not found' });
    }

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    });

    let clientDisconnected = false;
    req.on('close', () => { clientDisconnected = true; });

    const sendEvent = (type: string, data: any) => {
      if (clientDisconnected || res.writableEnded) return;
      res.write(`data: ${JSON.stringify({ type, ...data })}\n\n`);
    };

    try {
      const fileNames = await fsPromises.readdir(uploadsDir);
      sendEvent('init', { totalFiles: fileNames.length });

      const documents: any[] = [];
      let allChunks: any[] = [];
      const assets: any[] = [];
      const assetFiles: { name: string; buffer: Buffer }[] = [];
      let docIndex = 0;

      for (let i = 0; i < fileNames.length; i++) {
        if (clientDisconnected) break;

        const fileName = fileNames[i];
        const filePath = path.join(uploadsDir, fileName);
        const ext = path.extname(fileName).toLowerCase();
        const baseName = path.basename(fileName, ext);

        sendEvent('progress', {
          current: i + 1,
          total: fileNames.length,
          message: `Verarbeite: ${fileName}`,
          currentFile: fileName,
        });

        let extractedText: string | null = null;
        let sections: ExtractedSection[] = [];
        let fileType = 'unknown';

        if (ext === '.pdf') {
          fileType = 'pdf';
          try {
            const buffer = await fsPromises.readFile(filePath);
            const pdfResult = await extractPdfText(buffer);
            if (pdfResult && pdfResult.text) {
              const validation = isValidPdfText(pdfResult.text);
              if (validation.valid) {
                extractedText = pdfResult.text;
                sections = extractSectionsFromPlainText(extractedText);
              } else {
                sendEvent('progress', {
                  current: i + 1,
                  total: fileNames.length,
                  message: `PDF text invalid: ${validation.reason}`,
                  currentFile: fileName,
                });
                const assetBuffer = await fsPromises.readFile(filePath);
                assetFiles.push({ name: fileName, buffer: assetBuffer });
                assets.push({
                  asset_id: `asset_${sha256(fileName).slice(0, 12)}`,
                  file_name: fileName,
                  file_size: assetBuffer.length,
                  mime_type: 'application/pdf',
                  reason: `PDF text extraction failed: ${validation.reason}`,
                });
                continue;
              }
            } else {
              sendEvent('progress', {
                current: i + 1,
                total: fileNames.length,
                message: 'PDF could not be parsed',
                currentFile: fileName,
              });
              const assetBuffer = await fsPromises.readFile(filePath);
              assetFiles.push({ name: fileName, buffer: assetBuffer });
              assets.push({
                asset_id: `asset_${sha256(fileName).slice(0, 12)}`,
                file_name: fileName,
                file_size: assetBuffer.length,
                mime_type: 'application/pdf',
                reason: 'PDF parsing failed',
              });
              continue;
            }
          } catch (err) {
            sendEvent('progress', {
              current: i + 1,
              total: fileNames.length,
              message: `PDF error: ${(err as Error).message}`,
              currentFile: fileName,
            });
            const assetBuffer = await fsPromises.readFile(filePath);
            assetFiles.push({ name: fileName, buffer: assetBuffer });
            assets.push({
              asset_id: `asset_${sha256(fileName).slice(0, 12)}`,
              file_name: fileName,
              file_size: assetBuffer.length,
              mime_type: 'application/pdf',
              reason: 'PDF processing error',
            });
            continue;
          }
        } else if (TEXT_EXTENSIONS.has(ext)) {
          fileType = 'text';
          try {
            extractedText = await fsPromises.readFile(filePath, 'utf-8');
            sections = extractSectionsFromPlainText(extractedText);
          } catch (err) {
            sendEvent('progress', {
              current: i + 1,
              total: fileNames.length,
              message: `Could not read text file: ${(err as Error).message}`,
              currentFile: fileName,
            });
            continue;
          }
        } else if (HTML_EXTENSIONS.has(ext)) {
          fileType = 'html';
          try {
            const htmlContent = await fsPromises.readFile(filePath, 'utf-8');
            const dom = new JSDOM(htmlContent);
            const doc = dom.window.document;
            const body = doc.body;

            const elements: ScrapedElement[] = [];
            const walker = doc.createTreeWalker(body, 1);
            let node: Node | null = walker.currentNode;
            while (node) {
              const el = node as any;
              const tag = el.tagName?.toLowerCase();
              if (['h1','h2','h3','h4','h5','h6'].includes(tag)) {
                const level = parseInt(tag[1]);
                const text = el.textContent?.trim();
                if (text) {
                  elements.push({ type: 'heading', tag, content: text, level });
                }
              } else if (tag === 'p') {
                const text = el.textContent?.trim();
                if (text) {
                  elements.push({ type: 'paragraph', tag: 'p', content: text });
                }
              } else if (tag === 'ul' || tag === 'ol') {
                const items: string[] = [];
                const lis = el.querySelectorAll('li');
                lis.forEach((li: any) => {
                  const t = li.textContent?.trim();
                  if (t) items.push(t);
                });
                if (items.length > 0) {
                  elements.push({
                    type: 'list',
                    tag,
                    listType: tag === 'ol' ? 'ordered' : 'unordered',
                    children: items,
                  });
                }
              } else if (tag === 'blockquote') {
                const text = el.textContent?.trim();
                if (text) {
                  elements.push({ type: 'blockquote', tag: 'blockquote', content: text });
                }
              } else if (tag === 'pre' || tag === 'code') {
                const text = el.textContent?.trim();
                if (text) {
                  elements.push({ type: 'code', tag, content: text });
                }
              } else if (tag === 'table') {
                const headers: string[] = [];
                const rows: string[][] = [];
                el.querySelectorAll('th').forEach((th: any) => {
                  headers.push(th.textContent?.trim() || '');
                });
                el.querySelectorAll('tr').forEach((tr: any) => {
                  const cells: string[] = [];
                  tr.querySelectorAll('td').forEach((td: any) => {
                    cells.push(td.textContent?.trim() || '');
                  });
                  if (cells.length > 0) rows.push(cells);
                });
                if (headers.length > 0 || rows.length > 0) {
                  elements.push({ type: 'table', tag: 'table', headers, rows } as any);
                }
              }
              node = walker.nextNode();
            }

            if (elements.length > 0) {
              sections = extractTextFromElements(elements);
              extractedText = sections.map(s => s.text).join('\n\n');
            } else {
              extractedText = body.textContent?.trim() || '';
              if (extractedText) {
                sections = extractSectionsFromPlainText(extractedText);
              }
            }
          } catch (err) {
            sendEvent('progress', {
              current: i + 1,
              total: fileNames.length,
              message: `HTML parse error: ${(err as Error).message}`,
              currentFile: fileName,
            });
            continue;
          }
        } else if (SKIP_EXTENSIONS.has(ext)) {
          sendEvent('progress', {
            current: i + 1,
            total: fileNames.length,
            message: `${ext} files are not supported for text extraction. Included as asset.`,
            currentFile: fileName,
          });
          const assetBuffer = await fsPromises.readFile(filePath);
          assetFiles.push({ name: fileName, buffer: assetBuffer });
          assets.push({
            asset_id: `asset_${sha256(fileName).slice(0, 12)}`,
            file_name: fileName,
            file_size: assetBuffer.length,
            mime_type: 'application/octet-stream',
            reason: `${ext} not supported for text extraction`,
          });
          continue;
        } else {
          sendEvent('progress', {
            current: i + 1,
            total: fileNames.length,
            message: `Unsupported file type (${ext}). Included as asset.`,
            currentFile: fileName,
          });
          const assetBuffer = await fsPromises.readFile(filePath);
          assetFiles.push({ name: fileName, buffer: assetBuffer });
          assets.push({
            asset_id: `asset_${sha256(fileName).slice(0, 12)}`,
            file_name: fileName,
            file_size: assetBuffer.length,
            mime_type: 'application/octet-stream',
            reason: 'Unsupported file type',
          });
          continue;
        }

        if (!extractedText || !extractedText.trim() || sections.length === 0) {
          sendEvent('progress', {
            current: i + 1,
            total: fileNames.length,
            message: 'Kein Textinhalt extrahiert - als Asset hinzugefügt',
            currentFile: fileName,
          });
          const assetBuffer = await fsPromises.readFile(filePath);
          assetFiles.push({ name: fileName, buffer: assetBuffer });
          assets.push({
            asset_id: `asset_${sha256(fileName).slice(0, 12)}`,
            file_name: fileName,
            file_size: assetBuffer.length,
            mime_type: 'application/octet-stream',
            reason: 'No text content extracted',
          });
          continue;
        }

        const docId = `doc_${sha256(fileName).slice(0, 12)}`;
        const title = baseName.replace(/[_-]/g, ' ').replace(/\b\w/g, c => c.toUpperCase());

        documents.push({
          doc_id: docId,
          title,
          file_type: fileType,
          file_name: fileName,
          description: generateDescription(extractedText),
          word_count: extractedText.split(/\s+/).filter(w => w.length > 0).length,
          char_count: extractedText.length,
          token_estimate: estimateTokensFast(extractedText),
        });

        const chunked = chunkText(sections, 512, 100, 80);

        for (let ci = 0; ci < chunked.length; ci++) {
          const chunk = chunked[ci];
          const chunkId = `${docId}_chunk_${ci}`;
          const textHash = sha256(chunk.text);

          const quality = calculateChunkQuality(chunk.text, {
            minWordCount: 10,
            targetTokens: 512,
            warnOnShortChunks: true,
            warnOnNoContent: true,
          });

          allChunks.push({
            chunk_id: chunkId,
            doc_id: docId,
            chunk_index: ci,
            text: chunk.text,
            location: {
              url: `file://${fileName}`,
              heading_path: chunk.headingPath || [],
            },
            structure: {
              section_path: chunk.heading || null,
              heading: chunk.heading || null,
            },
            language: 'auto',
            source: {
              source_url: `file://${fileName}`,
            },
            hashes: {
              text_sha256: textHash,
            },
            tokens_estimate: estimateTokensFast(chunk.text),
            citation: `${title} - ${chunk.heading || 'Content'}`,
            chunk_type: chunk.type || 'text',
            quality,
          });
        }

        const sourceBuffer = await fsPromises.readFile(filePath);
        assetFiles.push({ name: fileName, buffer: sourceBuffer });
        const mimeMap: Record<string, string> = {
          '.pdf': 'application/pdf',
          '.txt': 'text/plain',
          '.md': 'text/markdown',
          '.html': 'text/html',
          '.htm': 'text/html',
          '.csv': 'text/csv',
          '.json': 'application/json',
          '.xml': 'application/xml',
          '.yaml': 'application/x-yaml',
          '.yml': 'application/x-yaml',
        };
        assets.push({
          asset_id: `asset_${sha256(fileName).slice(0, 12)}`,
          file_name: fileName,
          file_size: sourceBuffer.length,
          mime_type: mimeMap[ext] || 'application/octet-stream',
          doc_id: docId,
          role: 'source_document',
        });

        sendEvent('progress', {
          current: i + 1,
          total: fileNames.length,
          message: `${fileName}: ${chunked.length} Chunks erstellt`,
          currentFile: fileName,
        });

        docIndex++;
      }

      if (clientDisconnected) {
        res.end();
        return;
      }

      sendEvent('progress', { current: 0, total: 1, message: 'Deduplizierung läuft...' });

      let deduplicationStats = { totalChunks: allChunks.length, exactDuplicates: 0, nearDuplicates: 0, uniqueChunks: allChunks.length };
      if (allChunks.length > 0) {
        const dedupResult = deduplicateChunks(allChunks, 0.90);
        allChunks = dedupResult.chunks;
        deduplicationStats = dedupResult.stats;
        sendEvent('progress', {
          current: 0, total: 1,
          message: `Deduplizierung: ${deduplicationStats.exactDuplicates} exakte, ${deduplicationStats.nearDuplicates} ähnliche Duplikate entfernt`,
        });
      }

      const textChunks = allChunks.filter(c => c.chunk_type === 'text' || !c.chunk_type).length;
      const tableChunks = allChunks.filter(c => c.chunk_type === 'table').length;
      const codeChunks = allChunks.filter(c => c.chunk_type === 'code').length;
      const totalTokens = allChunks.reduce((sum: number, c: any) => sum + (c.tokens_estimate || 0), 0);
      const tokenValues = allChunks.map((c: any) => c.tokens_estimate || 0);
      const minTokens = tokenValues.length > 0 ? Math.min(...tokenValues) : 0;
      const maxTokens = tokenValues.length > 0 ? Math.max(...tokenValues) : 0;
      const avgTokens = allChunks.length > 0 ? Math.round(totalTokens / allChunks.length) : 0;

      let embeddingsStats: EmbeddingsStats | undefined;
      let enrichmentStatsResult: EnrichmentStats | undefined;
      const openaiApiKey = process.env.OPENAI_API_KEY;

      if (openaiApiKey && allChunks.length > 0 && !clientDisconnected) {
        sendEvent('progress', { current: 0, total: 1, message: 'Generiere Embeddings...', phase: 'embeddings' });
        try {
          const nonDuplicateChunks = allChunks.filter(c => !c.is_duplicate);
          const embResult = await generateEmbeddingsForChunks(
            nonDuplicateChunks,
            { model: 'text-embedding-3-small', dimensions: 1536 },
            openaiApiKey,
            (processed, total, successful, failed) => {
              sendEvent('progress', {
                current: processed, total,
                message: `Embeddings: ${processed}/${total} (${successful} erfolgreich, ${failed} fehlgeschlagen)`,
                phase: 'embeddings',
              });
            },
            () => clientDisconnected
          );
          embeddingsStats = embResult.stats;
          const embeddedMap = new Map(embResult.chunks.map(c => [c.chunk_id, c]));
          allChunks = allChunks.map(c => embeddedMap.get(c.chunk_id) || c);
          sendEvent('progress', {
            current: 0, total: 1,
            message: `Embeddings: ${embeddingsStats.successful} generiert, ${embeddingsStats.failed} fehlgeschlagen`,
          });
        } catch (err) {
          console.error('[Converter] Embeddings error:', (err as Error).message);
          sendEvent('progress', { current: 0, total: 1, message: `Embeddings-Fehler: ${(err as Error).message}` });
        }

        if (!clientDisconnected) {
          sendEvent('progress', { current: 0, total: 1, message: 'AI-Anreicherung läuft...', phase: 'enrichment' });
          try {
            const nonDuplicateChunks = allChunks.filter(c => !c.is_duplicate);
            const enrichSettings: EnrichmentSettings = {
              extractKeywords: true,
              generateSummary: true,
              detectCategory: true,
              extractEntities: true,
            };
            const enrichResult = await enrichChunkMetadata(
              nonDuplicateChunks,
              enrichSettings,
              'gpt-4o-mini',
              openaiApiKey,
              (processed, total, partialStats) => {
                sendEvent('progress', {
                  current: processed, total,
                  message: `AI-Anreicherung: ${processed}/${total} Chunks verarbeitet`,
                  phase: 'enrichment',
                });
              },
              () => clientDisconnected
            );
            enrichmentStatsResult = enrichResult.stats;
            const enrichedMap = new Map(enrichResult.chunks.map(c => [c.chunk_id, c]));
            allChunks = allChunks.map(c => enrichedMap.get(c.chunk_id) || c);
            sendEvent('progress', {
              current: 0, total: 1,
              message: `AI-Anreicherung: ${enrichmentStatsResult.keywordsExtracted} Keywords, ${enrichmentStatsResult.summariesGenerated} Zusammenfassungen`,
            });
          } catch (err) {
            console.error('[Converter] Enrichment error:', (err as Error).message);
            sendEvent('progress', { current: 0, total: 1, message: `Anreicherungs-Fehler: ${(err as Error).message}` });
          }
        }
      } else if (!openaiApiKey) {
        sendEvent('progress', { current: 0, total: 1, message: 'Kein OPENAI_API_KEY gefunden - Embeddings und AI-Anreicherung übersprungen' });
      }

      sendEvent('progress', { current: 0, total: 1, message: 'Erstelle RAG Pack...' });

      const zip = new JSZip();
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');

      const qualityReport = {
        token_statistics: { min: minTokens, max: maxTokens, avg: avgTokens, total: totalTokens },
        chunk_types: { text: textChunks, table: tableChunks, code: codeChunks },
        deduplication: {
          total_chunks: deduplicationStats.totalChunks,
          exact_duplicates: deduplicationStats.exactDuplicates,
          near_duplicates: deduplicationStats.nearDuplicates,
          unique_chunks: deduplicationStats.uniqueChunks,
        },
        ...(embeddingsStats ? {
          embeddings: {
            total: embeddingsStats.totalChunks,
            successful: embeddingsStats.successful,
            failed: embeddingsStats.failed,
            skipped: embeddingsStats.skipped,
          },
        } : {}),
        ...(enrichmentStatsResult ? {
          enrichment: {
            total: enrichmentStatsResult.totalChunks,
            successful: enrichmentStatsResult.successful,
            failed: enrichmentStatsResult.failed,
            keywords_extracted: enrichmentStatsResult.keywordsExtracted,
            summaries_generated: enrichmentStatsResult.summariesGenerated,
            categories_detected: enrichmentStatsResult.categoriesDetected,
            entities_extracted: enrichmentStatsResult.entitiesExtracted,
          },
        } : {}),
      };

      const manifest = {
        version: '2.0',
        source_type: 'converter',
        created_at: new Date().toISOString(),
        generator: 'rag-pack-converter',
        stats: {
          documents: documents.length,
          chunks: allChunks.length,
          assets: assets.length,
          total_tokens: totalTokens,
          unique_chunks: deduplicationStats.uniqueChunks,
        },
        quality_report: qualityReport,
      };

      zip.file('manifest.json', JSON.stringify(manifest, null, 2));

      const documentsJsonl = documents.map(d => JSON.stringify(d)).join('\n');
      zip.file('documents.jsonl', documentsJsonl);

      const exportChunks = allChunks.map(c => {
        const exported = { ...c };
        if (!embeddingsStats) {
          delete exported.embedding;
        }
        return exported;
      });
      const chunksJsonl = exportChunks.map(c => JSON.stringify(c)).join('\n');
      zip.file('chunks.jsonl', chunksJsonl);

      if (assets.length > 0) {
        const assetsJsonl = assets.map(a => JSON.stringify(a)).join('\n');
        zip.file('assets.jsonl', assetsJsonl);

        for (const asset of assetFiles) {
          zip.file(`assets/${asset.name}`, asset.buffer);
        }
      }

      const documentSchema = {
        type: 'object',
        properties: {
          doc_id: { type: 'string' },
          title: { type: 'string' },
          file_type: { type: 'string' },
          file_name: { type: 'string' },
          description: { type: 'string' },
          word_count: { type: 'integer' },
          char_count: { type: 'integer' },
          token_estimate: { type: 'integer' },
        },
      };
      zip.file('schemas/document.schema.json', JSON.stringify(documentSchema, null, 2));

      const chunkSchema = {
        type: 'object',
        properties: {
          chunk_id: { type: 'string' },
          doc_id: { type: 'string' },
          chunk_index: { type: 'integer' },
          text: { type: 'string' },
          location: { type: 'object' },
          structure: { type: 'object' },
          language: { type: 'string' },
          source: { type: 'object' },
          hashes: { type: 'object' },
          tokens_estimate: { type: 'integer' },
          citation: { type: 'string' },
          chunk_type: { type: 'string' },
          quality: { type: 'object' },
          embedding: { type: 'array', items: { type: 'number' } },
          ai_metadata: { type: 'object' },
          is_duplicate: { type: 'boolean' },
          duplicate_of: { type: 'string' },
        },
      };
      zip.file('schemas/chunk.schema.json', JSON.stringify(chunkSchema, null, 2));

      sendEvent('progress', { current: 0, total: 1, message: 'Erstelle ZIP-Archiv...' });

      const zipBuffer = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });

      const zipFilename = `rag_pack_converter_${timestamp}.zip`;
      const sessionDir = path.resolve(`./data/converter/${sessionId}`);
      await fileStorage.ensureDir(sessionDir);
      const zipPath = path.join(sessionDir, zipFilename);
      await fsPromises.writeFile(zipPath, zipBuffer);

      const downloadId = crypto.randomBytes(16).toString('hex');
      converterDownloads.set(downloadId, { path: zipPath, filename: zipFilename, documents: documents.length, chunks: allChunks.length, assets: assets.length });

      sendEvent('complete', {
        downloadId,
        filename: zipFilename,
        fileSize: zipBuffer.length,
        documents: documents.length,
        chunks: allChunks.length,
        assets: assets.length,
        deduplication: deduplicationStats,
        ...(embeddingsStats ? { embeddings: { successful: embeddingsStats.successful, failed: embeddingsStats.failed } } : {}),
        ...(enrichmentStatsResult ? {
          enrichment: {
            keywords: enrichmentStatsResult.keywordsExtracted,
            summaries: enrichmentStatsResult.summariesGenerated,
            categories: enrichmentStatsResult.categoriesDetected,
            entities: enrichmentStatsResult.entitiesExtracted,
          },
        } : {}),
      });

      res.end();
    } catch (err) {
      console.error('[Converter] Generate error:', err);
      sendEvent('error', { message: (err as Error).message });
      res.end();
    }
  });

  app.get('/api/converter/download/:downloadId', async (req, res) => {
    const { downloadId } = req.params;
    let filePath: string | null = null;
    let filename: string | null = null;

    const memEntry = converterDownloads.get(downloadId);
    if (memEntry) {
      filePath = memEntry.path;
      filename = memEntry.filename;
    } else {
      const dbEntry = await storage.getConverterExportByDownloadId(downloadId);
      if (dbEntry) {
        filePath = dbEntry.filePath;
        filename = dbEntry.filename;
      }
    }

    if (!filePath || !filename) {
      return res.status(404).json({ error: 'Download not found or expired' });
    }

    try {
      await fsPromises.access(filePath);
      res.setHeader('Content-Type', 'application/zip');
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
      const { createReadStream } = await import('fs');
      const stream = createReadStream(filePath);
      stream.pipe(res);
    } catch {
      converterDownloads.delete(downloadId);
      res.status(404).json({ error: 'File no longer available' });
    }
  });

  app.post('/api/converter/exports/save', async (req, res) => {
    try {
      const { sessionId, downloadId, name } = req.body;
      if (!sessionId || !downloadId) {
        return res.status(400).json({ error: 'Missing sessionId or downloadId' });
      }

      const entry = converterDownloads.get(downloadId);
      if (!entry) {
        return res.status(404).json({ error: 'Download not found' });
      }

      const stat = await fsPromises.stat(entry.path);

      let sourceFiles: string[] = [];
      const uploadsDir = path.resolve(`./data/converter/${sessionId}/uploads`);
      try {
        sourceFiles = await fsPromises.readdir(uploadsDir);
      } catch {}

      const saved = await storage.createConverterExport({
        sessionId,
        name: name || entry.filename,
        downloadId,
        filename: entry.filename,
        filePath: entry.path,
        fileSize: stat.size,
        documents: entry.documents || 0,
        chunks: entry.chunks || 0,
        assets: entry.assets || 0,
        sourceFiles,
      });

      res.json(saved);
    } catch (err) {
      console.error('[Converter] Save error:', err);
      res.status(500).json({ error: 'Failed to save export' });
    }
  });

  app.get('/api/converter/exports', async (_req, res) => {
    try {
      const exports = await storage.getConverterExports();
      res.json(exports);
    } catch (err) {
      console.error('[Converter] List exports error:', err);
      res.status(500).json({ error: 'Failed to list exports' });
    }
  });

  app.get('/api/converter/exports/:id/files', async (req, res) => {
    try {
      const id = parseInt(req.params.id);
      if (isNaN(id)) return res.status(400).json({ error: 'Invalid id' });

      const exports = await storage.getConverterExports();
      const exp = exports.find(e => e.id === id);
      if (!exp) return res.status(404).json({ error: 'Export not found' });

      const uploadsDir = path.resolve(`./data/converter/${exp.sessionId}/uploads`);
      let files: { name: string; size: number; type: string }[] = [];
      try {
        const fileNames = await fsPromises.readdir(uploadsDir);
        for (const name of fileNames) {
          const stat = await fsPromises.stat(path.join(uploadsDir, name));
          const ext = path.extname(name).toLowerCase();
          const mimeTypes: Record<string, string> = {
            '.pdf': 'application/pdf', '.txt': 'text/plain', '.md': 'text/markdown',
            '.html': 'text/html', '.csv': 'text/csv', '.json': 'application/json',
            '.xml': 'application/xml',
          };
          files.push({ name, size: stat.size, type: mimeTypes[ext] || 'application/octet-stream' });
        }
      } catch {}

      res.json({
        sessionId: exp.sessionId,
        downloadId: exp.downloadId,
        files,
      });
    } catch (err) {
      res.status(500).json({ error: 'Failed to get files' });
    }
  });

  app.delete('/api/converter/exports/:id', async (req, res) => {
    try {
      const id = parseInt(req.params.id);
      if (isNaN(id)) return res.status(400).json({ error: 'Invalid id' });

      const exports = await storage.getConverterExports();
      const exp = exports.find(e => e.id === id);
      if (exp) {
        try {
          await fsPromises.unlink(exp.filePath);
        } catch {}
        converterDownloads.delete(exp.downloadId);
      }

      await storage.deleteConverterExport(id);
      res.json({ success: true });
    } catch (err) {
      console.error('[Converter] Delete export error:', err);
      res.status(500).json({ error: 'Failed to delete export' });
    }
  });

  app.delete('/api/converter/:sessionId', async (req, res) => {
    const { sessionId } = req.params;
    const sessionDir = path.resolve(`./data/converter/${sessionId}`);

    try {
      await fsPromises.rm(sessionDir, { recursive: true, force: true });
      res.json({ success: true });
    } catch (err) {
      res.status(500).json({ error: 'Cleanup failed' });
    }
  });

  app.get(api.projects.list.path, async (req, res) => {
    try {
      // Use optimized query that computes counts in SQL without transferring large data
      const liteProjects = await storage.getProjectsLite();
      
      // Return projects with direct counts instead of fake results array
      const projectsForList = liteProjects.map(p => ({
        id: p.id,
        domain: p.domain,
        displayName: p.displayName,
        status: p.status,
        queue: p.queue,
        errors: p.errors,
        stats: p.stats,
        projectSettings: p.projectSettings,
        lastScraped: p.lastScraped,
        createdAt: p.createdAt,
        // Direct counts for efficient rendering - no fake arrays
        urlCount: p.urlCount,
        scrapedCount: p.scrapedCount,
        failedCount: p.failedCount,
        // Empty results array for compatibility
        results: [],
      }));
      
      res.json(projectsForList);
    } catch (error) {
      console.error('Error fetching projects:', error);
      res.status(500).json({ message: 'Failed to fetch projects' });
    }
  });

  app.get(api.projects.get.path, async (req, res) => {
    try {
      const project = await storage.getProjectLite(Number(req.params.id));
      if (!project) {
        return res.status(404).json({ message: 'Project not found' });
      }
      if (!project.chunkCount || project.chunkCount === 0) {
        const fsChunks = await fileStorage.readProjectChunks(project.id, project.domain);
        if (fsChunks) {
          project.chunkCount = fsChunks.length;
        }
      }
      const pdfCounts = await fileStorage.getPagePdfCounts(project.id, project.domain);
      if (pdfCounts.size > 0 && project.results) {
        for (const r of project.results) {
          const loc = r.loc;
          if (loc && pdfCounts.has(loc)) {
            r.pdfCount = pdfCounts.get(loc);
          }
        }
      }
      res.json(project);
    } catch (error) {
      console.error('Error fetching project:', error);
      res.status(500).json({ message: 'Failed to fetch project' });
    }
  });

  // Lazy load scraped data for a single URL (for content preview)
  app.get('/api/projects/:id/url-content', async (req, res) => {
    try {
      const projectId = Number(req.params.id);
      const urlLoc = req.query.loc as string;
      
      if (!urlLoc) {
        return res.status(400).json({ message: 'Missing loc query parameter' });
      }

      // Try filesystem first
      try {
        const project = await storage.getProject(projectId);
        if (project) {
          const pageDir = fileStorage.getProjectPageDir(projectId, project.domain, urlLoc);
          const [markdownContent, meta] = await Promise.all([
            fileStorage.readPageContent(pageDir),
            fileStorage.readPageMeta(pageDir),
          ]);
          if (markdownContent && meta) {
            const pdfs = await fileStorage.listPdfs(pageDir);
            const media = await fileStorage.listMedia(pageDir);
            return res.json({
              loc: urlLoc,
              scrapedData: {
                title: meta.title,
                timestamp: meta.timestamp,
                wordCount: meta.wordCount,
                structuredData: meta.structuredData,
                linkedPdfs: meta.linkedPdfs,
                orderedElements: meta.orderedElements || [],
              },
              markdownContent,
              filePdfs: pdfs,
              fileMedia: media,
              source: 'filesystem',
            });
          }
        }
      } catch (fsErr) {
        // Filesystem read failed, fall back to DB
      }
      
      const urlEntry = await storage.getProjectUrlScrapedData(projectId, urlLoc);
      if (!urlEntry) {
        return res.status(404).json({ message: 'URL not found in project' });
      }
      
      res.json({ ...urlEntry, source: 'database' });
    } catch (error) {
      console.error('Error fetching URL content:', error);
      res.status(500).json({ message: 'Failed to fetch URL content' });
    }
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

  // Start content extraction - calculates URLs server-side for reliability
  app.post('/api/projects/:id/start-extraction', async (req, res) => {
    try {
      const id = Number(req.params.id);
      if (isNaN(id)) {
        return res.status(400).json({ message: 'Invalid project ID' });
      }

      const project = await storage.getProject(id);
      if (!project) {
        return res.status(404).json({ message: 'Project not found' });
      }

      try {
        const projDir = fileStorage.getProjectDir(id, project.domain);
        await fileStorage.saveProjectMeta(projDir, {
          id: project.id,
          domain: project.domain,
          displayName: project.displayName,
          createdAt: project.createdAt,
          projectSettings: project.projectSettings,
        });
      } catch (fsErr) {
        console.error('[FileStorage] Error saving project meta:', (fsErr as Error).message);
      }

      // Reset errorStatus for all results and calculate URLs that need extraction
      const results = project.results || [];
      const resetResults = results.map((r: any) => ({
        ...r,
        errorStatus: null, // Clear previous error status
      }));
      
      const contentUrls = resetResults
        .filter((r: any) => !r.scrapedData && !r.hasScrapedData)
        .map((r: any) => r.loc);

      if (contentUrls.length === 0) {
        return res.status(400).json({ message: 'No content pages to extract' });
      }

      // Update project: reset errors, reset results errorStatus, set queue and status
      const updated = await storage.updateProject(id, {
        status: 'content_scraping',
        queue: contentUrls,
        errors: [], // Clear errors array for fresh start
        results: resetResults, // Save results with cleared errorStatus
      });

      console.log(`[StartExtraction] Started extraction for project ${id} with ${contentUrls.length} URLs (errors reset)`);
      res.json(updated);
    } catch (err) {
      console.error('[StartExtraction] Error:', err);
      res.status(500).json({ message: 'Failed to start extraction' });
    }
  });

  // Sync errors array to results - marks URLs with errorStatus based on errors array
  app.post('/api/projects/:id/sync-errors', async (req, res) => {
    try {
      const id = Number(req.params.id);
      if (isNaN(id)) {
        return res.status(400).json({ message: 'Invalid project ID' });
      }

      const project = await storage.getProject(id);
      if (!project) {
        return res.status(404).json({ message: 'Project not found' });
      }

      const errors = project.errors || [];
      const results = project.results || [];
      
      if (errors.length === 0) {
        return res.json({ message: 'No errors to sync', synced: 0 });
      }

      // Build a set of error URLs for fast lookup
      const errorUrlSet = new Set<string>();
      const errorMessageMap = new Map<string, string>();
      for (const err of errors) {
        if (err.url) {
          errorUrlSet.add(err.url);
          errorMessageMap.set(err.url, err.message || 'Unknown error');
        }
      }

      // Update results with errorStatus for matching URLs
      let synced = 0;
      const updatedResults = results.map((r: any) => {
        // Skip if already has scraped data or errorStatus
        if (r.scrapedData || r.hasScrapedData || r.errorStatus) {
          return r;
        }
        
        if (errorUrlSet.has(r.loc)) {
          synced++;
          return {
            ...r,
            errorStatus: 'failed' as const,
            errorMessage: errorMessageMap.get(r.loc) || 'Error during scraping'
          };
        }
        return r;
      });

      if (synced > 0) {
        await storage.updateProject(id, { results: updatedResults });
      }

      console.log(`[SyncErrors] Synced ${synced} error URLs for project ${id}`);
      res.json({ message: `Synced ${synced} error URLs`, synced });
    } catch (err) {
      console.error('[SyncErrors] Error:', err);
      res.status(500).json({ message: 'Failed to sync errors' });
    }
  });

  app.get('/api/projects/:id/sync-attachments', async (req, res) => {
    const id = Number(req.params.id);
    if (isNaN(id)) {
      return res.status(400).json({ message: 'Invalid project ID' });
    }

    const project = await storage.getProject(id);
    if (!project) {
      return res.status(404).json({ message: 'Project not found' });
    }

    const allResults = project.results || [];
    if (allResults.length === 0) {
      return res.status(400).json({ message: 'No pages in project' });
    }

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    });

    let clientDisconnected = false;
    req.on('close', () => { clientDisconnected = true; });

    const sendEvent = (event: string, data: any) => {
      if (clientDisconnected) return;
      try {
        res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      } catch {}
    };

    try {
      const directPdfUrls = new Set<string>();
      const htmlResults: any[] = [];

      for (const r of allResults) {
        const loc = r.loc || '';
        const lowerLoc = loc.toLowerCase();
        if (lowerLoc.endsWith('.pdf') || lowerLoc.includes('.pdf?')) {
          directPdfUrls.add(loc);
        } else if (r.scrapedData || r.hasScrapedData) {
          htmlResults.push(r);
        }
      }

      sendEvent('init', {
        totalHtmlPages: htmlResults.length,
        directPdfUrls: directPdfUrls.size,
      });

      if (htmlResults.length === 0 && directPdfUrls.size === 0) {
        sendEvent('complete', { synced: 0, directPdfs: 0, pdfsFound: 0, errors: 0, skipped: 0 });
        res.end();
        return;
      }

      let rateLimiter: RateLimiter | undefined;
      let proxyRotator: ProxyRotator | undefined;
      if (project.projectSettings?.scraping) {
        const settings = project.projectSettings.scraping;
        rateLimiter = new RateLimiter(settings.rateLimiting);
        proxyRotator = new ProxyRotator(settings.proxies, settings.rotateProxies);
      }

      const BATCH_SIZE = 10;
      let totalSynced = 0;
      let totalPdfsFound = 0;
      let totalErrors = 0;
      let totalSkipped = 0;
      const allPdfUpdates = new Map<string, any[]>();

      for (let i = 0; i < htmlResults.length; i += BATCH_SIZE) {
        if (clientDisconnected) break;

        const batch = htmlResults.slice(i, i + BATCH_SIZE);

        await Promise.all(batch.map(async (entry: any) => {
          if (clientDisconnected) return;
          const url = entry.loc;
          try {
            if (shouldSkipUrl(url)) {
              totalSkipped++;
              allPdfUpdates.set(url, []);
              return;
            }

            const { text: html } = await fetchWithRateLimitAndProxy(url, {
              rateLimiter,
              proxyRotator,
              timeout: 10000,
              retries: 1,
            });

            const { JSDOM } = await import('jsdom');
            const dom = new JSDOM(html, { url });
            const doc = dom.window.document;

            const linkedPdfs: Array<{ url: string; title?: string; linkText?: string }> = [];
            const seenPdfUrls = new Set<string>();

            doc.querySelectorAll('a[href]').forEach((anchor: any) => {
              const href = anchor.getAttribute('href');
              if (!href) return;
              try {
                const absoluteUrl = new URL(href, url).href;
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

            allPdfUpdates.set(url, linkedPdfs);
            totalPdfsFound += linkedPdfs.length;
            totalSynced++;
          } catch (err) {
            totalErrors++;
            allPdfUpdates.set(url, []);
          }
        }));

        sendEvent('progress', {
          processed: Math.min(i + BATCH_SIZE, htmlResults.length),
          total: htmlResults.length,
          pdfsFound: totalPdfsFound,
          errors: totalErrors,
        });
      }

      if (!clientDisconnected) {
        const currentProject = await storage.getProject(id);
        if (currentProject) {
          const updatedResults = (currentProject.results || []).map((existing: any) => {
            const loc = existing.loc || '';
            const lowerLoc = loc.toLowerCase();

            if (lowerLoc.endsWith('.pdf') || lowerLoc.includes('.pdf?')) {
              const filename = loc.split('/').pop()?.replace(/\.pdf.*$/i, '') || 'PDF';
              return {
                ...existing,
                scrapedData: {
                  title: existing.scrapedData?.title || filename,
                  orderedElements: existing.scrapedData?.orderedElements || [],
                  timestamp: new Date().toISOString(),
                  wordCount: existing.scrapedData?.wordCount || 0,
                  isPdfEntry: true,
                  linkedPdfs: [{
                    url: loc,
                    title: filename,
                    linkText: filename,
                  }],
                },
                hasScrapedData: true,
                status: 'scraped',
              };
            }

            const pdfs = allPdfUpdates.get(loc);
            if (pdfs !== undefined && existing.scrapedData) {
              return {
                ...existing,
                scrapedData: {
                  ...existing.scrapedData,
                  linkedPdfs: pdfs.length > 0 ? pdfs : undefined,
                },
              };
            }
            return existing;
          });
          await storage.updateProject(id, { results: updatedResults });
        }
      }

      const directPdfCount = directPdfUrls.size;
      totalPdfsFound += directPdfCount;

      console.log(`[SyncAttachments] Completed for project ${id}: ${totalSynced} HTML pages, ${directPdfCount} direct PDFs, ${totalPdfsFound} total PDFs, ${totalErrors} errors`);

      sendEvent('complete', {
        synced: totalSynced,
        directPdfs: directPdfCount,
        pdfsFound: totalPdfsFound,
        errors: totalErrors,
        skipped: totalSkipped,
      });

      res.end();
    } catch (err) {
      console.error('[SyncAttachments] Error:', err);
      sendEvent('sync-error', { message: 'Sync failed: ' + (err as Error).message });
      res.end();
    }
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

  // Single Page Scraping endpoints
  app.get("/api/single-pages", async (req, res) => {
    const singlePages = await storage.getSinglePages();
    res.json(singlePages);
  });

  app.get("/api/single-pages/:id", async (req, res) => {
    const id = Number(req.params.id);
    if (isNaN(id)) {
      return res.status(400).json({ message: 'Invalid ID' });
    }

    const singlePage = await storage.getSinglePage(id);
    if (!singlePage) {
      return res.status(404).json({ message: 'Single page not found' });
    }

    const fsChunks = await fileStorage.readSinglePageChunks(id, singlePage.domain);
    const enrichedChunks = (fsChunks && fsChunks.length > 0) ? fsChunks : (singlePage.chunks || []);

    if (!singlePage.scrapedData) {
      try {
        const pageDir = fileStorage.getSinglePageDir(id, singlePage.domain);
        const [markdownContent, meta] = await Promise.all([
          fileStorage.readPageContent(pageDir),
          fileStorage.readPageMeta(pageDir),
        ]);
        if (markdownContent && meta) {
          return res.json({
            ...singlePage,
            chunks: enrichedChunks,
            scrapedData: {
              title: meta.title,
              timestamp: meta.timestamp,
              wordCount: meta.wordCount,
              structuredData: meta.structuredData,
              linkedPdfs: meta.linkedPdfs,
              orderedElements: meta.orderedElements || [],
            },
            markdownContent,
            source: 'filesystem',
          });
        }
      } catch {
      }
    }

    res.json({ ...singlePage, chunks: enrichedChunks });
  });

  app.post("/api/single-pages", async (req, res) => {
    try {
      const { url } = req.body;
      if (!url || typeof url !== 'string') {
        return res.status(400).json({ message: 'URL is required' });
      }

      // Parse URL to get domain
      let parsedUrl: URL;
      try {
        parsedUrl = new URL(url.startsWith('http') ? url : `https://${url}`);
      } catch {
        return res.status(400).json({ message: 'Invalid URL format' });
      }

      const domain = parsedUrl.hostname;

      // Skip non-HTML URLs (PDFs, images, etc.)
      if (shouldSkipUrl(parsedUrl.href)) {
        return res.status(400).json({ message: 'Cannot scrape non-HTML content (PDF, image, etc.)' });
      }

      // Create the single page record with status "scraping"
      const singlePage = await storage.createSinglePage({
        url: parsedUrl.href,
        domain,
        status: 'scraping',
      });

      // Scrape the page content
      try {
        const response = await fetch(parsedUrl.href, {
          headers: {
            'User-Agent': 'Mozilla/5.0 (compatible; SitemapScraper/1.0)',
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          },
        });

        if (!response.ok) {
          throw new Error(`HTTP ${response.status}`);
        }

        const html = await response.text();
        const scrapedResult = scrapePageContent(html, parsedUrl.href, true);

        // Save to filesystem
        try {
          const spDir = fileStorage.getSinglePageDir(singlePage.id, domain);
          const markdown = orderedElementsToMarkdown(scrapedResult.orderedElements || []);
          await fileStorage.savePageContent(spDir, markdown);
          await fileStorage.savePageMeta(spDir, {
            url: parsedUrl.href,
            title: scrapedResult.title,
            timestamp: scrapedResult.timestamp,
            wordCount: scrapedResult.wordCount,
            structuredData: scrapedResult.structuredData,
            linkedPdfs: scrapedResult.linkedPdfs,
            orderedElements: scrapedResult.orderedElements,
          });
          
          // Download linked PDFs
          if (scrapedResult.linkedPdfs && scrapedResult.linkedPdfs.length > 0) {
            for (const pdf of scrapedResult.linkedPdfs) {
              try {
                const pdfResponse = await fetch(pdf.url, {
                  headers: { 'User-Agent': 'Mozilla/5.0 (compatible; SitemapScraper/1.0)' },
                  signal: AbortSignal.timeout(30000),
                });
                if (pdfResponse.ok) {
                  const pdfBuffer = Buffer.from(await pdfResponse.arrayBuffer());
                  const pdfFilename = pdf.url.split('/').pop()?.split('?')[0] || 'document.pdf';
                  await fileStorage.savePdf(spDir, pdfFilename, pdfBuffer);
                }
              } catch (pdfErr) {
                console.log(`[FileStorage] Failed to download PDF ${pdf.url}: ${(pdfErr as Error).message}`);
              }
            }
          }
        } catch (fsErr) {
          console.error(`[FileStorage] Error saving single page:`, (fsErr as Error).message);
        }

        // Count images and videos from scraped data
        const imageCount = scrapedResult.orderedElements?.filter((el: any) => el.type === 'media' && el.tag === 'img').length || 0;
        const videoCount = scrapedResult.orderedElements?.filter((el: any) => el.type === 'media' && el.tag === 'video').length || 0;

        await storage.updateSinglePage(singlePage.id, {
          title: scrapedResult.title,
          structuredData: scrapedResult.structuredData,
          wordCount: scrapedResult.wordCount,
          imageCount,
          videoCount,
          status: 'chunking',
        });

        // Run RAG processing
        const settings = getDefaultSettings();
        const chunkingSettings = settings.chunking;

        // Extract sections from scraped elements
        const sections = extractTextFromElements(scrapedResult.orderedElements || [], {
          preserveTables: chunkingSettings.preserveTables,
          preserveCodeBlocks: chunkingSettings.preserveCodeBlocks,
        });

        // Run chunking
        const chunkedSections = chunkText(
          sections,
          chunkingSettings.targetTokens,
          chunkingSettings.overlapTokens,
          chunkingSettings.minChunkTokens
        );

        // Create RAG chunks
        const docId = `doc_${sha256(parsedUrl.href).slice(0, 12)}`;
        const useMultiLang = chunkingSettings.multiLanguageTokenization ?? true;
        const qualityChecksEnabled = chunkingSettings.qualityChecks?.enabled ?? true;

        let allChunks: RagChunk[] = chunkedSections.map((chunk, index) => {
          const chunkId = `${docId}::c${String(index).padStart(4, '0')}`;
          const tokens = estimateTokensFast(chunk.text);

          let pathname = '/';
          try {
            pathname = new URL(parsedUrl.href).pathname || '/';
          } catch {}

          let quality: ChunkQuality | undefined;
          if (qualityChecksEnabled) {
            quality = calculateChunkQuality(chunk.text, {
              minWordCount: chunkingSettings.qualityChecks?.minWordCount ?? 10,
              targetTokens: chunkingSettings.targetTokens,
              warnOnShortChunks: chunkingSettings.qualityChecks?.warnOnShortChunks ?? true,
              warnOnNoContent: chunkingSettings.qualityChecks?.warnOnNoContent ?? true,
            });
          }

          return {
            chunk_id: chunkId,
            doc_id: docId,
            chunk_index: index,
            text: chunk.text,
            location: {
              url: parsedUrl.href,
              heading_path: chunkingSettings.preserveHeadingHierarchy ? chunk.headingPath.filter(Boolean) : undefined,
            },
            structure: {
              section_path: chunk.headingPath.filter(Boolean).join(' > ') || null,
              heading: chunk.heading,
            },
            language: 'de',
            source: {
              source_url: `https://${domain}`,
            },
            hashes: {
              text_sha256: sha256(chunk.text),
            },
            tokens_estimate: tokens,
            citation: `${scrapedResult.title || pathname}, ${chunk.heading || 'Inhalt'}`,
            chunk_type: chunk.type,
            table_data: chunk.tableData,
            code_block: chunk.codeBlock,
            quality,
            content_hash: sha256(chunk.text),
            created_at: new Date().toISOString(),
          };
        });

        // Run deduplication
        let deduplicationStats = { totalChunks: allChunks.length, exactDuplicates: 0, nearDuplicates: 0, uniqueChunks: allChunks.length };
        if (chunkingSettings.deduplication?.enabled) {
          const threshold = chunkingSettings.deduplication?.similarityThreshold ?? 0.95;
          const result = deduplicateChunks(allChunks, threshold);
          allChunks = result.chunks;
          deduplicationStats = result.stats;
        }

        // Calculate chunk statistics
        const textChunks = allChunks.filter(c => c.chunk_type === 'text' || !c.chunk_type).length;
        const tableChunks = allChunks.filter(c => c.chunk_type === 'table').length;
        const codeChunks = allChunks.filter(c => c.chunk_type === 'code').length;
        const totalTokens = allChunks.reduce((sum, c) => sum + c.tokens_estimate, 0);

        let chunkStats: ChunkStats = {
          totalChunks: allChunks.length,
          textChunks,
          tableChunks,
          codeChunks,
          exactDuplicates: deduplicationStats.exactDuplicates,
          nearDuplicates: deduplicationStats.nearDuplicates,
          uniqueChunks: deduplicationStats.uniqueChunks,
          totalTokens,
          avgTokensPerChunk: allChunks.length > 0 ? Math.round(totalTokens / allChunks.length) : 0,
        };

        // Check for OPENAI_API_KEY and run AI features if available
        const openaiApiKey = process.env.OPENAI_API_KEY;
        if (openaiApiKey) {
          // Generate embeddings
          try {
            const embeddingSettings = settings.ai.embeddings;
            const embeddingResult = await generateEmbeddingsForChunks(
              allChunks.filter(c => !c.is_duplicate),
              { model: embeddingSettings.model, dimensions: embeddingSettings.dimensions },
              openaiApiKey
            );
            
            // Merge embeddings back into all chunks
            const embeddedMap = new Map(embeddingResult.chunks.map(c => [c.chunk_id, c]));
            allChunks = allChunks.map(c => embeddedMap.get(c.chunk_id) || c);
            chunkStats.embeddingsGenerated = embeddingResult.stats.successful;
          } catch (err) {
            console.log(`[SinglePage] Embeddings failed: ${(err as Error).message}`);
          }

          // Run AI enrichment (keywords, summaries)
          try {
            const enrichmentSettings = {
              extractKeywords: settings.ai.metadataEnrichment.extractKeywords,
              generateSummary: settings.ai.metadataEnrichment.generateSummary,
              detectCategory: false,
              extractEntities: false,
            };
            
            const enrichmentResult = await enrichChunkMetadata(
              allChunks.filter(c => !c.is_duplicate),
              enrichmentSettings,
              settings.ai.model,
              openaiApiKey
            );
            
            // Merge enriched data back
            const enrichedMap = new Map(enrichmentResult.chunks.map(c => [c.chunk_id, c]));
            allChunks = allChunks.map(c => enrichedMap.get(c.chunk_id) || c);
            
            chunkStats.enrichmentStats = {
              keywordsExtracted: enrichmentResult.stats.keywordsExtracted,
              summariesGenerated: enrichmentResult.stats.summariesGenerated,
            };
          } catch (err) {
            console.log(`[SinglePage] Enrichment failed: ${(err as Error).message}`);
          }
        }

        await fileStorage.saveSinglePageChunks(singlePage.id, domain, allChunks);
        const updatedPage = await storage.updateSinglePage(singlePage.id, {
          chunks: [],
          chunkStats,
          status: 'completed',
        });

        res.status(201).json(updatedPage);
      } catch (scrapeError) {
        // Update with error status
        const updatedPage = await storage.updateSinglePage(singlePage.id, {
          status: 'error',
          error: (scrapeError as Error).message,
        });

        res.status(201).json(updatedPage);
      }
    } catch (err) {
      res.status(500).json({ message: (err as Error).message });
    }
  });

  // Update single page (e.g., rename title)
  app.put("/api/single-pages/:id", async (req, res) => {
    try {
      const id = Number(req.params.id);
      if (isNaN(id)) {
        return res.status(400).json({ message: 'Invalid ID' });
      }

      const { title } = req.body;
      if (title === undefined) {
        return res.status(400).json({ message: 'Title is required' });
      }

      const updated = await storage.updateSinglePage(id, { title });
      if (!updated) {
        return res.status(404).json({ message: 'Single page not found' });
      }

      res.json(updated);
    } catch (err) {
      res.status(500).json({ message: (err as Error).message });
    }
  });

  app.post("/api/projects/from-single-pages", async (req, res) => {
    try {
      const { name, singlePageIds, deleteSinglePages } = req.body;
      if (!name || typeof name !== 'string' || name.trim().length === 0) {
        return res.status(400).json({ message: 'Project name is required' });
      }
      if (!Array.isArray(singlePageIds) || singlePageIds.length === 0) {
        return res.status(400).json({ message: 'At least one single page must be selected' });
      }

      const pages: any[] = [];
      for (const id of singlePageIds) {
        const page = await storage.getSinglePage(Number(id));
        if (page && page.scrapedData) {
          pages.push(page);
        }
      }

      if (pages.length === 0) {
        return res.status(400).json({ message: 'No scraped single pages found for the given IDs' });
      }

      const domains = new Set(pages.map(p => p.domain));
      const primaryDomain = [...domains][0];

      const results = pages.map(page => ({
        loc: page.url,
        lastmod: page.createdAt ? new Date(page.createdAt).toISOString() : undefined,
        images: (page.scrapedData?.orderedElements || [])
          .filter((e: any) => e.type === 'media' && e.mediaType === 'image')
          .map((e: any) => ({ src: e.src, alt: e.alt || '' })),
        videos: (page.scrapedData?.orderedElements || [])
          .filter((e: any) => e.type === 'media' && e.mediaType === 'video')
          .map((e: any) => ({ src: e.src, title: e.alt || '' })),
        scrapedData: page.scrapedData,
        hasScrapedData: true,
      }));

      const project = await storage.createProject({
        domain: primaryDomain,
        displayName: name.trim(),
        status: 'idle',
        queue: [],
        processed: results.map(r => r.loc),
        results,
        errors: [],
        stats: {
          totalSitemaps: 0,
          processedSitemaps: 0,
          totalUrls: results.length,
          totalImages: results.reduce((sum, r) => sum + r.images.length, 0),
          totalVideos: results.reduce((sum, r) => sum + r.videos.length, 0),
          startTime: Date.now(),
          endTime: Date.now(),
          scrapedPages: results.length,
        },
        chunks: [],
        exportedChunkHashes: {},
      });

      if (deleteSinglePages) {
        for (const page of pages) {
          await storage.deleteSinglePage(page.id);
        }
        console.log(`[FromSinglePages] Deleted ${pages.length} single pages after conversion`);
      }

      console.log(`[FromSinglePages] Created project "${name}" (id=${project.id}) from ${pages.length} single pages`);
      res.status(201).json(project);
    } catch (error) {
      console.error('Error creating project from single pages:', error);
      res.status(500).json({ message: 'Failed to create project from single pages' });
    }
  });

  app.delete("/api/single-pages/:id", async (req, res) => {
    const id = Number(req.params.id);
    if (isNaN(id)) {
      return res.status(400).json({ message: 'Invalid ID' });
    }

    const deleted = await storage.deleteSinglePage(id);
    res.status(204).send();
  });

  app.post("/api/single-pages/:id/rag-pack/stream", async (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');

    const sendEvent = (type: string, data: any) => {
      if (!res.writableEnded) {
        res.write(`data: ${JSON.stringify({ type, ...data })}\n\n`);
      }
    };

    let clientDisconnected = false;
    req.on('close', () => { clientDisconnected = true; });

    try {
      const id = Number(req.params.id);
      if (isNaN(id)) {
        sendEvent('error', { message: 'Invalid ID' });
        res.end();
        return;
      }

      const singlePage = await storage.getSinglePage(id);
      if (!singlePage) {
        sendEvent('error', { message: 'Single page not found' });
        res.end();
        return;
      }

      const chunks = await loadSinglePageChunks(singlePage);
      if (chunks.length === 0) {
        sendEvent('error', { message: 'No chunks available.' });
        res.end();
        return;
      }

      let scrapedDataObj = singlePage.scrapedData as any;
      if (!scrapedDataObj) {
        try {
          const spPageDir = fileStorage.getSinglePageDir(id, singlePage.domain);
          const meta = await fileStorage.readPageMeta(spPageDir);
          if (meta) {
            scrapedDataObj = {
              title: meta.title,
              orderedElements: meta.orderedElements || [],
              linkedPdfs: meta.linkedPdfs,
              structuredData: meta.structuredData,
            };
          }
        } catch {}
      }

      const zip = new JSZip();
      const now = new Date().toISOString();
      const docId = `doc_${sha256(singlePage.url).slice(0, 12)}`;
      const rawTitle = singlePage.title || '';
      const cleanedTitle = cleanHtmlTitle(rawTitle, singlePage.url);
      const textContent = (scrapedDataObj?.orderedElements || [])
        .filter((el: any) => el.type === 'text' || el.type === 'heading' || el.type === 'paragraph')
        .map((el: any) => el.content || '')
        .join(' ');

      const documentObj: any = {
        doc_id: docId,
        title: cleanedTitle,
        url: singlePage.url,
        domain: singlePage.domain,
        language: 'de',
        file_type: 'html',
        file_name: slugifyFilename(cleanedTitle, '.html'),
        source: {
          source_type: 'single_page',
          source_url: singlePage.url,
        },
        description: generateDescription(textContent),
        category: getCategoryFromUrl(singlePage.url),
        dates: {
          scraped: singlePage.createdAt || now,
          ingested: now,
        },
        statistics: {
          word_count: singlePage.wordCount || 0,
          image_count: singlePage.imageCount || 0,
          video_count: singlePage.videoCount || 0,
          chunk_count: chunks.length,
        },
        hashes: {
          content_sha256: sha256(JSON.stringify(scrapedDataObj?.orderedElements || [])),
          source_fingerprint: sha256(singlePage.url + '|' + cleanedTitle),
        },
      };

      const spLinkedPdfs = scrapedDataObj?.linkedPdfs;
      const spAssetEntries: Array<{ asset_id: string; doc_id: string; url: string; title?: string; link_text?: string; filename: string; path: string; size_bytes: number; mime_type: string; downloaded: boolean; error?: string }> = [];
      const spAssetPathMap = new Map<string, string>();
      const spPdfDocuments: any[] = [];
      const spPdfChunks: any[] = [];
      const spSkippedBinaryPdfs: string[] = [];
      let spPdfValidCount = 0;
      let spPdfInvalidCount = 0;

      sendEvent('init', {
        totalDocuments: 1,
        totalPdfs: spLinkedPdfs?.length || 0,
        includeAssets: !!(spLinkedPdfs && spLinkedPdfs.length > 0),
      });

      if (spLinkedPdfs && spLinkedPdfs.length > 0) {
        const assetsFolder = zip.folder('assets');
        const seenUrls = new Set<string>();
        let idx = 0;

        for (const pdf of spLinkedPdfs) {
          if (!pdf.url || seenUrls.has(pdf.url)) continue;
          seenUrls.add(pdf.url);

          const urlPath = pdf.url.split('/').pop()?.split('?')[0] || `document_${idx}`;
          const safeName = urlPath.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 100);
          const urlHash = sha256(pdf.url).slice(0, 8);
          const baseName = safeName.endsWith('.pdf') ? safeName.slice(0, -4) : safeName;
          const fname = `${baseName}_${urlHash}.pdf`;
          const assetPath = `assets/${fname}`;

          try {
            let buffer: Buffer | null = null;
            const spDir = fileStorage.getSinglePageDir(singlePage.id, singlePage.domain);

            buffer = await fileStorage.findPdfByUrl(spDir, pdf.url);

            if (buffer) {
              idx++;
              sendEvent('progress', { phase: 'downloading', current: idx, total: seenUrls.size, currentUrl: pdf.url.slice(0, 80), message: `PDF ${idx}/${seenUrls.size} aus Cache geladen` });
            } else {
              const response = await fetch(pdf.url, {
                headers: { 'User-Agent': 'MapScraperPro/1.0' },
                signal: AbortSignal.timeout(30000),
              });
              if (response.ok) {
                buffer = Buffer.from(await response.arrayBuffer());
                try {
                  const urlFilename = pdf.url.split('/').pop()?.split('?')[0] || 'document.pdf';
                  await fileStorage.savePdf(spDir, urlFilename, buffer);
                } catch {}
              } else {
                spAssetEntries.push({
                  asset_id: `asset_${sha256(pdf.url).slice(0, 12)}`,
                  doc_id: docId, url: pdf.url, title: pdf.title, link_text: pdf.linkText,
                  filename: '', path: '', size_bytes: 0, mime_type: 'application/pdf',
                  downloaded: false, error: `HTTP ${response.status}`,
                });
                idx++;
                sendEvent('progress', { phase: 'downloading', current: idx, total: seenUrls.size, currentUrl: pdf.url.slice(0, 80), message: `Lade PDF ${idx}/${seenUrls.size} herunter...` });
                if (clientDisconnected) break;
                continue;
              }
            }

            assetsFolder?.file(fname, buffer);
            spAssetPathMap.set(pdf.url, assetPath);
            spAssetEntries.push({
              asset_id: `asset_${sha256(pdf.url).slice(0, 12)}`,
              doc_id: docId, url: pdf.url, title: pdf.title, link_text: pdf.linkText,
              filename: fname, path: assetPath, size_bytes: buffer.length,
              mime_type: 'application/pdf', downloaded: true,
            });
          } catch (err) {
            spAssetEntries.push({
              asset_id: `asset_${sha256(pdf.url).slice(0, 12)}`,
              doc_id: docId, url: pdf.url, title: pdf.title, link_text: pdf.linkText,
              filename: '', path: '', size_bytes: 0, mime_type: 'application/pdf',
              downloaded: false, error: (err as Error).message,
            });
          }
          idx++;
          sendEvent('progress', {
            phase: 'downloading',
            current: idx,
            total: seenUrls.size,
            currentUrl: pdf.url.slice(0, 80),
            message: `Lade PDF ${idx}/${seenUrls.size} herunter...`,
          });
          if (clientDisconnected) break;
        }

        documentObj.linked_pdfs = spLinkedPdfs.map((pdf: any) => {
          const pdfEntry: any = {
            url: pdf.url,
            title: pdf.title || pdf.linkText || undefined,
            link_text: pdf.linkText || undefined,
          };
          const localPath = spAssetPathMap.get(pdf.url);
          if (localPath) pdfEntry.local_path = localPath;
          return pdfEntry;
        });
      }

      const uniqueDownloadedSpAssets = spAssetEntries.filter(a => a.downloaded && a.path);
      const seenSpAssetPaths = new Set<string>();

      sendEvent('progress', {
        phase: 'extracting',
        current: 0,
        total: uniqueDownloadedSpAssets.length,
        message: 'Extrahiere Text aus PDFs...',
      });

      for (const asset of uniqueDownloadedSpAssets) {
        if (seenSpAssetPaths.has(asset.path)) continue;
        seenSpAssetPaths.add(asset.path);
        if (clientDisconnected) break;

        try {
          const pdfFile = zip.file(asset.path);
          if (!pdfFile) continue;

          const buffer = Buffer.from(await pdfFile.async('nodebuffer'));

          if (buffer.length < 5 || buffer.toString('ascii', 0, 5) !== '%PDF-') {
            spPdfInvalidCount++;
            spSkippedBinaryPdfs.push(asset.filename);
            continue;
          }

          const pdfResult = await extractPdfText(buffer);
          if (!pdfResult) {
            spPdfInvalidCount++;
            spSkippedBinaryPdfs.push(asset.filename);
            continue;
          }

          const validation = isValidPdfText(pdfResult.text);
          if (!validation.valid) {
            spPdfInvalidCount++;
            spSkippedBinaryPdfs.push(asset.filename);
            console.log(`[RAG Pack SP] Skipping PDF ${asset.filename}: ${validation.reason}`);
            continue;
          }

          spPdfValidCount++;

          const pdfDocId = `doc_${sha256(asset.url).slice(0, 12)}`;
          const pdfTitle = cleanPdfTitle(
            pdfResult.metadata?.Title || asset.title || asset.link_text || '',
            asset.url
          );

          const pdfDoc: any = {
            doc_id: pdfDocId,
            title: pdfTitle,
            url: asset.url,
            language: 'de',
            file_type: 'pdf',
            file_name: slugifyFilename(pdfTitle, '.pdf'),
            pdf_has_text_layer: true,
            source: {
              source_type: 'pdf',
              source_url: asset.url,
              asset_path: asset.path,
            },
            description: generateDescription(pdfResult.text),
            category: getCategoryFromUrl(singlePage.url),
            total_pages: pdfResult.numPages,
            dates: {
              scraped: now,
              ingested: now,
            },
            hashes: {
              content_sha256: sha256(pdfResult.text),
              source_fingerprint: sha256(asset.url + '|' + pdfTitle),
            },
          };
          spPdfDocuments.push(pdfDoc);

          const pdfSections = extractSectionsFromPlainText(pdfResult.text);
          const pdfChunkedSections = chunkText(pdfSections, 512, 100, 80);

          pdfChunkedSections.forEach((chunk, index) => {
            const chunkId = `${pdfDocId}::c${String(index).padStart(4, '0')}`;
            const tokens = estimateTokensFast(chunk.text);

            const ragChunk: any = {
              chunk_id: chunkId,
              doc_id: pdfDocId,
              chunk_index: index,
              text: chunk.text,
              tokens_estimate: tokens,
              language: 'de',
              location: {
                url: asset.url,
                heading_path: chunk.headingPath?.filter(Boolean) || [],
              },
              structure: {
                section_path: chunk.headingPath?.filter(Boolean).join(' > ') || null,
                heading: chunk.heading,
              },
              source: {
                source_url: asset.url,
              },
              hashes: {
                text_sha256: sha256(chunk.text),
              },
              citation: `${pdfTitle}${chunk.heading ? ', ' + chunk.heading : ''} (${asset.url})`,
              chunk_type: chunk.type || 'text',
            };
            spPdfChunks.push(ragChunk);
          });

          console.log(`[RAG Pack SP] PDF ${asset.filename}: ${pdfChunkedSections.length} chunks from ${pdfResult.numPages} pages`);
            sendEvent('progress', {
              phase: 'extracting',
              current: seenSpAssetPaths.size,
              total: uniqueDownloadedSpAssets.length,
              currentUrl: asset.filename,
              message: `PDF Text extrahiert: ${asset.filename}`,
            });
        } catch (err) {
          console.warn(`[RAG Pack SP] Error processing PDF ${asset.filename}:`, (err as Error).message);
          spPdfInvalidCount++;
          spSkippedBinaryPdfs.push(asset.filename);
        }
      }

      if (spPdfValidCount > 0 || spPdfInvalidCount > 0) {
        console.log(`[RAG Pack SP] PDF processing: ${spPdfValidCount} valid, ${spPdfInvalidCount} invalid/skipped`);
      }

      sendEvent('progress', {
        phase: 'building',
        current: 0,
        total: 1,
        message: 'Erstelle Dokumente und Chunks...',
      });

      const documentsJsonl = [
        JSON.stringify(documentObj),
        ...spPdfDocuments.map(doc => JSON.stringify(doc)),
      ].join('\n');

      const processedChunks = chunks.map((chunk: any) => {
        const processed = { ...chunk };
        delete processed.embedding;
        if (!processed.citation) {
          processed.citation = `${processed.doc_id}, Chunk ${processed.chunk_index}`;
        }
        return processed;
      });
      const allSpExportChunks = [...processedChunks, ...spPdfChunks];
      const chunksJsonl = allSpExportChunks.map(chunk => JSON.stringify(chunk)).join('\n');

      let spAssetsJsonl = '';
      if (spAssetEntries.length > 0) {
        spAssetsJsonl = spAssetEntries.map(a => JSON.stringify(a)).join('\n');
      }

      const manifest: any = {
        rag_pack_version: '2.0',
        created_at: now,
        generator: {
          name: 'MapScraper Pro',
          version: '2.0',
        },
        source: {
          url: singlePage.url,
          domain: singlePage.domain,
          type: 'single_page',
        },
        chunking: {
          profile: 'retrieval_v1',
          tokenizer: 'cl100k_base',
          chunk_size_tokens: 512,
          chunk_overlap_tokens: 100,
          min_chunk_tokens: 80,
          split_strategy: 'semantic_paragraph_then_token',
          short_chunk_policy: 'merge_if_possible_else_drop',
          dedup: {
            enabled: true,
            method: 'text_sha256_and_jaccard_per_doc',
            similarity_threshold: 0.90,
          },
        },
        counts: {
          documents: 1 + spPdfDocuments.length,
          chunks: allSpExportChunks.length,
          assets: spAssetEntries.filter(a => a.downloaded).length,
          pdf_valid: spPdfValidCount,
          pdf_invalid: spPdfInvalidCount,
        },
        quality_report: {
          documents_with_text_layer: spPdfValidCount,
          documents_without_text_layer: spPdfInvalidCount,
          skipped_binary_pdfs: spSkippedBinaryPdfs,
          avg_tokens_per_chunk: allSpExportChunks.length > 0
            ? Math.round(allSpExportChunks.reduce((sum: number, c: any) => sum + (c.tokens_estimate || 0), 0) / allSpExportChunks.length)
            : 0,
          min_tokens_in_chunk: allSpExportChunks.length > 0
            ? Math.min(...allSpExportChunks.map((c: any) => c.tokens_estimate || 0))
            : 0,
          max_tokens_in_chunk: allSpExportChunks.length > 0
            ? Math.max(...allSpExportChunks.map((c: any) => c.tokens_estimate || 0))
            : 0,
        },
        checksums: {
          documents_sha256: sha256(documentsJsonl),
          chunks_sha256: sha256(chunksJsonl),
        },
      };

      if (spAssetsJsonl) {
        manifest.checksums.assets_sha256 = sha256(spAssetsJsonl);
      }

      zip.file('manifest.json', JSON.stringify(manifest, null, 2));
      zip.file('documents.jsonl', documentsJsonl);
      zip.file('chunks.jsonl', chunksJsonl);
      if (spAssetsJsonl) {
        zip.file('assets.jsonl', spAssetsJsonl);
      }

      const schemaFolder = zip.folder('schema');
      schemaFolder?.file('manifest.schema.json', JSON.stringify({
        "$schema": "http://json-schema.org/draft-07/schema#",
        "type": "object",
        "properties": {
          "rag_pack_version": { "type": "string" },
          "created_at": { "type": "string", "format": "date-time" },
        }
      }, null, 2));

      sendEvent('progress', {
        phase: 'zipping',
        current: 0,
        total: 1,
        message: 'Erstelle ZIP-Archiv...',
      });

      const content = await zip.generateAsync({ type: 'nodebuffer' });
      const filename = `rag-pack-single-${singlePage.domain}-${singlePage.id}.zip`;

      const downloadId = sha256(`sp-${id}-${Date.now()}-${Math.random()}`).slice(0, 16);
      const spExportStats = {
        documents: 1 + spPdfDocuments.length,
        chunks: allSpExportChunks.length,
        pdfValid: spPdfValidCount,
        pdfInvalid: spPdfInvalidCount,
        assets: spAssetEntries.filter(a => a.downloaded).length,
      };
      const spExportsDir = path.join(fileStorage.getSinglePageDir(id, singlePage.domain), 'exports');
      await fileStorage.ensureDir(spExportsDir);
      const spFilePath = path.join(spExportsDir, filename);
      await fsPromises.writeFile(spFilePath, content);
      const spExpiresAt = new Date();
      spExpiresAt.setDate(spExpiresAt.getDate() + EXPORT_RETENTION_DAYS);
      try {
        await storage.createRagPackExport({
          projectId: id,
          downloadId,
          filename,
          filePath: spFilePath,
          fileSize: content.length,
          ...spExportStats,
          expiresAt: spExpiresAt,
        });
      } catch (err) {
        console.error('[RAG Pack] Failed to save single-page export metadata:', err);
      }

      sendEvent('complete', {
        downloadId,
        filename,
        fileSize: content.length,
        ...spExportStats,
      });
      res.end();
    } catch (err) {
      console.error('Error generating single page RAG pack:', err);
      try {
        sendEvent('error', { message: (err as Error).message });
        res.end();
      } catch {
        res.end();
      }
    }
  });

  app.get("/api/single-pages/:id/rag-pack", async (req, res) => {
    res.status(400).json({
      message: 'Use /api/single-pages/:id/rag-pack/stream for SSE progress, then download from /api/rag-pack/download/:id'
    });
  });

  // Website type detection endpoint
  app.post(api.scrape.detect.path, async (req, res) => {
    try {
      const input = api.scrape.detect.input.parse(req.body);
      let url = input.url.trim();
      if (!url.startsWith('http')) url = `https://${url}`;
      
      const { detectWebsiteType } = await import('./scrapers/index');
      const detection = await detectWebsiteType(url);
      
      res.json({
        url,
        type: detection.type,
        confidence: detection.confidence,
        indicators: detection.indicators,
      });
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

  app.post(api.scrape.discover.path, async (req, res) => {
    try {
      const input = api.scrape.discover.input.parse(req.body);
      let baseUrl = input.domain.trim();
      if (!baseUrl.startsWith('http')) baseUrl = `https://${baseUrl}`;
      baseUrl = baseUrl.replace(/\/$/, '');
      
      // First check if this is a Wiki.js site
      const isWiki = await isWikiJsSite(baseUrl);
      if (isWiki) {
        console.log(`[Wiki.js] Detected Wiki.js site: ${baseUrl}`);
        const wikiPages = await discoverWikiJsPages(baseUrl);
        if (wikiPages.length > 0) {
          res.json({ sitemaps: [], wikiJsPages: wikiPages, isWikiJs: true, isMoodle: false });
          return;
        }
      }
      
      // Check if this is a Moodle site
      const isMoodle = await isMoodleSite(baseUrl);
      if (isMoodle) {
        console.log(`[Moodle] Detected Moodle site: ${baseUrl}`);
        const moodleCourses = await discoverMoodleCourses(baseUrl);
        if (moodleCourses.length > 0) {
          res.json({ sitemaps: [], moodlePages: moodleCourses, isMoodle: true, isWikiJs: false });
          return;
        }
      }
      
      const sitemaps = await discoverSitemaps(input.domain);
      res.json({ sitemaps, isWikiJs: false, isMoodle: false });
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
      const projectId = input.projectId;
      
      // Validate projectId is required for content scraping (data persistence)
      if (!projectId) {
        return res.status(400).json({ message: 'projectId is required for content scraping' });
      }
      
      // Get project - validate it exists
      const project = await storage.getProject(projectId);
      if (!project) {
        return res.status(404).json({ message: `Project ${projectId} not found` });
      }
      
      // Get project settings for rate limiting/proxy support
      let rateLimiter: RateLimiter | undefined;
      let proxyRotator: ProxyRotator | undefined;
      let extractStructuredDataFlag = true; // Default to true
      
      if (project.projectSettings?.scraping) {
        const settings = project.projectSettings.scraping;
        rateLimiter = new RateLimiter(settings.rateLimiting);
        proxyRotator = new ProxyRotator(settings.proxies, settings.rotateProxies);
        extractStructuredDataFlag = settings.extractStructuredData ?? true;
      }
      
      // Collect all updates in memory first to avoid race conditions
      // Map: url -> { scrapedData?, errorStatus?, errorMessage? }
      const urlUpdates = new Map<string, { scrapedData?: any; errorStatus?: string; errorMessage?: string }>();
      
      const results = await Promise.all(urls.map(async (url) => {
        try {
          // Skip non-HTML URLs (PDFs, images, etc.)
          if (shouldSkipUrl(url)) {
            urlUpdates.set(url, { errorStatus: 'skipped', errorMessage: 'Non-HTML content (PDF, image, etc.)' });
            return { url, success: false, error: 'Skipped: non-HTML content (PDF, image, etc.)', skipped: true };
          }
          
          const { text: html, usedProxy } = await fetchWithRateLimitAndProxy(url, {
            rateLimiter,
            proxyRotator,
          });
          const data = scrapePageContent(html, url, extractStructuredDataFlag);
          
          // Store update in memory - will be applied in batch
          if (data) {
            urlUpdates.set(url, { hasScrapedData: true, status: 'scraped', errorStatus: undefined, errorMessage: undefined });
            
            // Save to filesystem
            try {
              const pageDir = fileStorage.getProjectPageDir(projectId, project.domain, url);
              const markdown = orderedElementsToMarkdown(data.orderedElements || []);
              await fileStorage.savePageContent(pageDir, markdown);
              await fileStorage.savePageMeta(pageDir, {
                url,
                title: data.title,
                timestamp: data.timestamp,
                wordCount: data.wordCount,
                structuredData: data.structuredData,
                linkedPdfs: data.linkedPdfs,
                orderedElements: data.orderedElements,
              });
              
              // Download linked PDFs (max 50MB each, max 10 per page)
              if (data.linkedPdfs && data.linkedPdfs.length > 0) {
                for (const pdf of data.linkedPdfs.slice(0, 10)) {
                  try {
                    const pdfResponse = await fetch(pdf.url, {
                      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; SitemapScraper/1.0)' },
                      signal: AbortSignal.timeout(30000),
                    });
                    if (pdfResponse.ok) {
                      const contentLength = parseInt(pdfResponse.headers.get('content-length') || '0');
                      if (contentLength > 50 * 1024 * 1024) {
                        console.log(`[FileStorage] Skipping large PDF (${(contentLength / 1024 / 1024).toFixed(1)}MB): ${pdf.url}`);
                        continue;
                      }
                      const pdfBuffer = Buffer.from(await pdfResponse.arrayBuffer());
                      if (pdfBuffer.length > 50 * 1024 * 1024) continue;
                      const pdfFilename = pdf.url.split('/').pop()?.split('?')[0] || 'document.pdf';
                      await fileStorage.savePdf(pageDir, pdfFilename, pdfBuffer);
                    }
                  } catch (pdfErr) {
                    console.log(`[FileStorage] Failed to download PDF ${pdf.url}: ${(pdfErr as Error).message}`);
                  }
                }
              }
              
              // Download media (images, max 10MB each, max 50 per page)
              const mediaElements = (data.orderedElements || []).filter((el: any) => el.type === 'media' && el.src);
              for (const media of mediaElements.slice(0, 50)) {
                try {
                  const mediaUrl = media.src;
                  if (!mediaUrl || mediaUrl.startsWith('data:')) continue;
                  const mediaResponse = await fetch(mediaUrl, {
                    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; SitemapScraper/1.0)' },
                    signal: AbortSignal.timeout(15000),
                  });
                  if (mediaResponse.ok) {
                    const mediaBuffer = Buffer.from(await mediaResponse.arrayBuffer());
                    if (mediaBuffer.length > 10 * 1024 * 1024) continue;
                    const mediaFilename = mediaUrl.split('/').pop()?.split('?')[0] || 'image.jpg';
                    await fileStorage.saveMedia(pageDir, mediaFilename, mediaBuffer);
                  }
                } catch {
                  // Silently skip failed media downloads
                }
              }
            } catch (fsErr) {
              console.error(`[FileStorage] Error saving page ${url}:`, (fsErr as Error).message);
            }
          }
          
          // Return lightweight response without full scrapedData
          return { url, success: true, error: null, usedProxy };
        } catch (err) {
          const errorMessage = (err as Error).message;
          
          // Store error in memory - will be applied in batch
          urlUpdates.set(url, { status: 'failed', errorStatus: 'failed', errorMessage: errorMessage });
          
          return { url, success: false, error: errorMessage };
        }
      }));
      
      // Apply all updates in a single batch to avoid race conditions
      if (urlUpdates.size > 0) {
        const currentProject = await storage.getProject(projectId);
        if (currentProject) {
          const updatedResults = (currentProject.results || []).map(existing => {
            const update = urlUpdates.get(existing.loc);
            if (update) {
              return { ...existing, ...update };
            }
            return existing;
          });
          await storage.updateProject(projectId, { results: updatedResults });
        }
      }
      
      try {
        await fileStorage.buildProjectPdfsJson(projectId, project.domain);
      } catch {}

      const rateLimitState = rateLimiter?.getState();
      
      res.json({ 
        results,
        rateLimitState,
        proxyInfo: proxyRotator ? {
          enabled: proxyRotator.isEnabled(),
          totalProxies: proxyRotator.getProxyCount(),
          availableProxies: proxyRotator.getAvailableProxyCount(),
        } : undefined,
      });
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

  // Crawl endpoint - fetches pages and extracts internal links
  app.post(api.scrape.crawl.path, async (req, res) => {
    try {
      const input = api.scrape.crawl.input.parse(req.body);
      const urls = input.urls.slice(0, CONCURRENCY);
      const domain = input.domain.replace(/^https?:\/\//, '').split('/')[0];
      
      const results = await Promise.all(urls.map(async (url) => {
        try {
          const html = await fetchWithTimeout(url);
          const dom = new JSDOM(html);
          const doc = dom.window.document;
          
          // Extract internal links - use both DOM and regex-based extraction
          const links: string[] = [];
          
          // URL patterns to skip (auth, admin, resources, etc.)
          const skipPatterns = [
            '/login/', '/auth/', '/admin/', '/user/profile',
            '/message/', '/calendar/', '/blocks/', '/theme/',
            '/lib/', '/pluginfile.php', 'sesskey=', 'download.moodle.org',
            '/wp-login', '/wp-admin', '?action=logout', '&action=logout',
          ];
          
          // Helper function to process href
          const processHref = (href: string) => {
            if (!href) return;
            // Skip anchors, javascript, mailto, tel
            if (href.startsWith('#') || href.startsWith('javascript:') || 
                href.startsWith('mailto:') || href.startsWith('tel:')) return;
            
            try {
              const resolvedUrl = new URL(href, url).href;
              const urlDomain = new URL(resolvedUrl).hostname;
              
              // Only include links from the same domain
              if (urlDomain === domain || urlDomain.endsWith('.' + domain)) {
                // Skip file extensions we don't want
                if (resolvedUrl.match(/\.(pdf|jpg|jpeg|png|gif|svg|css|js|zip|tar|gz|ico|woff|woff2|ttf|eot)$/i)) return;
                
                // Skip auth/admin/resource URLs
                if (skipPatterns.some(pattern => resolvedUrl.includes(pattern))) return;
                
                // Remove hash fragment only, keep query params (important for Moodle, PHP sites)
                let cleanUrl = resolvedUrl.split('#')[0];
                
                // For PHP files, validate required params exist
                if (cleanUrl.includes('.php')) {
                  const urlObj = new URL(cleanUrl);
                  const pathname = urlObj.pathname;
                  
                  // Skip PHP files that require params but don't have them
                  if (pathname.endsWith('/view.php') && !urlObj.searchParams.has('id')) return;
                  if (pathname.endsWith('/mod.php') && !urlObj.searchParams.has('id')) return;
                  
                  // Keep only essential params to avoid duplicates from tracking params
                  const essentialParams = ['id', 'section', 'chapterid', 'page', 'p', 'cat', 'tag'];
                  const newParams = new URLSearchParams();
                  essentialParams.forEach(param => {
                    const val = urlObj.searchParams.get(param);
                    if (val) newParams.set(param, val);
                  });
                  urlObj.search = newParams.toString();
                  cleanUrl = urlObj.href;
                } else {
                  // For non-PHP URLs, remove query params to avoid duplicates
                  cleanUrl = cleanUrl.split('?')[0];
                }
                
                if (cleanUrl && !cleanUrl.endsWith('/manifest.json')) {
                  links.push(cleanUrl);
                }
              }
            } catch {}
          };
          
          // Method 1: DOM-based extraction
          doc.querySelectorAll('a[href]').forEach(a => {
            const href = a.getAttribute('href');
            if (href) processHref(href);
          });
          
          // Method 2: Extract from template content (for Vue/React SSR apps)
          doc.querySelectorAll('template').forEach(template => {
            const templateHtml = template.innerHTML;
            const hrefRegex = /href=["']([^"']+)["']/gi;
            let match;
            while ((match = hrefRegex.exec(templateHtml)) !== null) {
              processHref(match[1]);
            }
          });
          
          // Method 3: Regex fallback on raw HTML for links in script tags or dynamically rendered content
          const rawHrefRegex = /href=["']([^"'#][^"']*)["']/gi;
          let rawMatch;
          while ((rawMatch = rawHrefRegex.exec(html)) !== null) {
            processHref(rawMatch[1]);
          }
          
          // Remove duplicates
          const uniqueLinks = Array.from(new Set(links));
          
          // Extract basic page data
          const title = doc.querySelector('title')?.textContent || '';
          const images: any[] = [];
          const videos: any[] = [];
          
          doc.querySelectorAll('img[src]').forEach(img => {
            const src = img.getAttribute('src');
            if (src) {
              try {
                const resolvedSrc = new URL(src, url).href;
                images.push({
                  loc: resolvedSrc,
                  title: img.getAttribute('alt') || img.getAttribute('title') || '',
                });
              } catch {}
            }
          });
          
          doc.querySelectorAll('video source[src], video[src]').forEach(video => {
            const src = video.getAttribute('src');
            if (src) {
              try {
                const resolvedSrc = new URL(src, url).href;
                videos.push({ loc: resolvedSrc, title: '' });
              } catch {}
            }
          });
          
          return { 
            url, 
            links: uniqueLinks,
            data: { title, images, videos }, 
            error: null 
          };
        } catch (err) {
          return { url, links: [], data: null, error: (err as Error).message };
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

      const allResults = (project.results || []).filter((r: any) => r.scrapedData || r.hasScrapedData);
      const scrapedResults = await loadResultsWithFilesystem(allResults, projectId, project.domain);
      if (scrapedResults.length === 0) {
        return res.status(400).json({ message: 'No scraped content available. Run deep scraping first.' });
      }

      const settings: ProjectSettings = project.projectSettings || getDefaultSettings();

      const { chunks, deduplicationStats } = generateChunksForProject(scrapedResults, project.domain, settings);

      await fileStorage.saveProjectChunks(projectId, project.domain, chunks);
      await storage.updateProject(projectId, { chunks: [] });

      res.json({ 
        success: true, 
        chunksGenerated: chunks.length,
        pagesProcessed: scrapedResults.length,
        deduplication: deduplicationStats,
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

      const allChunkResults = (project.results || []).filter((r: any) => r.scrapedData || r.hasScrapedData);
      const scrapedResults = await loadResultsWithFilesystem(allChunkResults, projectId, project.domain);
      if (scrapedResults.length === 0) {
        sendEvent({ type: 'error', message: 'No scraped content available. Run deep scraping first.' });
        res.end();
        return;
      }

      const settings: ProjectSettings = project.projectSettings || getDefaultSettings();

      const chunkingSettings = settings.chunking || {
        targetTokens: 512,
        overlapTokens: 100,
        minChunkTokens: 80,
        boundaryRules: ['paragraph', 'heading'],
        preserveHeadingHierarchy: true,
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
          similarityThreshold: 0.90,
        },
      };

      const useMultiLang = chunkingSettings.multiLanguageTokenization ?? true;
      const qualityChecksEnabled = chunkingSettings.qualityChecks?.enabled ?? true;

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
        const sections = extractTextFromElements(entry.scrapedData.orderedElements, {
          preserveTables: chunkingSettings.preserveTables ?? true,
          preserveCodeBlocks: chunkingSettings.preserveCodeBlocks ?? true,
        });
        
        const chunkedSections = chunkText(
          sections,
          chunkingSettings.targetTokens,
          chunkingSettings.overlapTokens,
          chunkingSettings.minChunkTokens
        );

        chunkedSections.forEach((chunk, index) => {
          const chunkId = `${docId}::c${String(allChunks.length).padStart(4, '0')}`;
          const tokens = estimateTokensFast(chunk.text);
          
          let pathname = '/';
          try {
            pathname = new URL(entry.loc).pathname || '/';
          } catch {}

          // Calculate quality metrics if enabled
          let quality: ChunkQuality | undefined;
          if (qualityChecksEnabled) {
            quality = calculateChunkQuality(chunk.text, {
              minWordCount: chunkingSettings.qualityChecks?.minWordCount ?? 10,
              targetTokens: chunkingSettings.targetTokens,
              warnOnShortChunks: chunkingSettings.qualityChecks?.warnOnShortChunks ?? true,
              warnOnNoContent: chunkingSettings.qualityChecks?.warnOnNoContent ?? true,
            });
          }

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
            chunk_type: chunk.type,
            table_data: chunk.tableData,
            code_block: chunk.codeBlock,
            quality,
            content_hash: sha256(chunk.text),
            created_at: new Date().toISOString(),
            citation: `${entry.scrapedData?.title || pathname}, ${chunk.heading || 'Inhalt'}`,
          };

          allChunks.push(ragChunk);
        });

        // Small delay to not overwhelm the client
        await new Promise(resolve => setTimeout(resolve, 10));
      }

      // Apply deduplication if enabled
      const deduplicationEnabled = chunkingSettings.deduplication?.enabled ?? true;
      let finalChunks = allChunks;
      let deduplicationStats: DeduplicationStats | undefined;

      if (deduplicationEnabled && allChunks.length > 0) {
        sendEvent({
          type: 'progress',
          current: total,
          total,
          chunksGenerated: allChunks.length,
          currentUrl: 'Deduplicating chunks...',
          phase: 'deduplication',
        });

        const threshold = chunkingSettings.deduplication?.similarityThreshold ?? 0.90;
        const result = deduplicateChunks(allChunks, threshold);
        finalChunks = result.chunks;
        deduplicationStats = result.stats;

        console.log(`[Deduplication] Stats: ${JSON.stringify(deduplicationStats)}`);
      }

      // Generate embeddings if enabled
      let embeddingsStats: EmbeddingsStats | undefined;
      const embeddingsEnabled = settings.ai?.embeddings?.enabled ?? false;
      const openaiApiKey = process.env.OPENAI_API_KEY;

      if (embeddingsEnabled && finalChunks.length > 0) {
        if (!openaiApiKey) {
          console.warn('[Embeddings] Embeddings enabled but OPENAI_API_KEY not found in environment. Skipping embeddings generation.');
          sendEvent({
            type: 'warning',
            message: 'Embeddings enabled but no OPENAI_API_KEY found. Skipping embeddings generation.',
            phase: 'embeddings',
          });
        } else {
          sendEvent({
            type: 'progress',
            current: total,
            total,
            chunksGenerated: finalChunks.length,
            currentUrl: 'Generating embeddings...',
            phase: 'embeddings',
          });

          const embeddingsModel = settings.ai?.embeddings?.model ?? 'text-embedding-3-small';
          const embeddingsDimensions = settings.ai?.embeddings?.dimensions ?? 1536;

          console.log(`[Embeddings] Starting embeddings generation for ${finalChunks.length} chunks using model ${embeddingsModel} (dimensions: ${embeddingsDimensions})`);

          const embeddingsResult = await generateEmbeddingsForChunks(
            finalChunks,
            { model: embeddingsModel, dimensions: embeddingsDimensions },
            openaiApiKey,
            (processed, embeddingsTotal, successful, failed) => {
              sendEvent({
                type: 'progress',
                current: total,
                total,
                chunksGenerated: finalChunks.length,
                currentUrl: `Generating embeddings (${processed}/${embeddingsTotal})...`,
                phase: 'embeddings',
                embeddingsProgress: {
                  processed,
                  total: embeddingsTotal,
                  successful,
                  failed,
                },
              });
            },
            () => jobState.cancelled
          );

          finalChunks = embeddingsResult.chunks;
          embeddingsStats = embeddingsResult.stats;

          console.log(`[Embeddings] Stats: ${JSON.stringify(embeddingsStats)}`);

          if (embeddingsStats.failed > 0) {
            console.warn(`[Embeddings] ${embeddingsStats.failed} chunks failed embedding generation. Failed chunk IDs: ${embeddingsStats.failedChunkIds.join(', ')}`);
          }
        }
      }

      // AI Metadata Enrichment if enabled
      let enrichmentStats: EnrichmentStats | undefined;
      const enrichmentEnabled = settings.ai?.metadataEnrichment?.enabled ?? false;

      if (enrichmentEnabled && finalChunks.length > 0 && !jobState.cancelled) {
        if (!openaiApiKey) {
          console.warn('[Enrichment] Metadata enrichment enabled but OPENAI_API_KEY not found in environment. Skipping enrichment.');
          sendEvent({
            type: 'warning',
            message: 'AI metadata enrichment enabled but no OPENAI_API_KEY found. Skipping enrichment.',
            phase: 'enrichment',
          });
        } else {
          sendEvent({
            type: 'progress',
            current: total,
            total,
            chunksGenerated: finalChunks.length,
            currentUrl: 'Enriching chunks with AI metadata...',
            phase: 'enrichment',
          });

          const aiModel = settings.ai?.model ?? 'gpt-4o-mini';
          const enrichmentSettings: EnrichmentSettings = {
            extractKeywords: settings.ai?.metadataEnrichment?.extractKeywords ?? true,
            generateSummary: settings.ai?.metadataEnrichment?.generateSummary ?? true,
            detectCategory: settings.ai?.metadataEnrichment?.detectCategory ?? false,
            extractEntities: settings.ai?.metadataEnrichment?.extractEntities ?? false,
          };

          console.log(`[Enrichment] Starting AI metadata enrichment for ${finalChunks.length} chunks using model ${aiModel}`);
          console.log(`[Enrichment] Settings: extractKeywords=${enrichmentSettings.extractKeywords}, generateSummary=${enrichmentSettings.generateSummary}, detectCategory=${enrichmentSettings.detectCategory}, extractEntities=${enrichmentSettings.extractEntities}`);

          const enrichmentResult = await enrichChunkMetadata(
            finalChunks,
            enrichmentSettings,
            aiModel,
            openaiApiKey,
            (processed, enrichmentTotal, partialStats) => {
              sendEvent({
                type: 'progress',
                current: total,
                total,
                chunksGenerated: finalChunks.length,
                currentUrl: `Enriching chunks (${processed}/${enrichmentTotal})...`,
                phase: 'enrichment',
                enrichmentProgress: {
                  processed,
                  total: enrichmentTotal,
                  ...partialStats,
                },
              });
            },
            () => jobState.cancelled
          );

          finalChunks = enrichmentResult.chunks;
          enrichmentStats = enrichmentResult.stats;

          console.log(`[Enrichment] Stats: ${JSON.stringify(enrichmentStats)}`);

          if (enrichmentStats.failed > 0) {
            console.warn(`[Enrichment] ${enrichmentStats.failed} chunks failed enrichment. Failed chunk IDs: ${enrichmentStats.failedChunkIds.join(', ')}`);
          }
        }
      }

      sendEvent({
        type: 'progress',
        current: total,
        total,
        chunksGenerated: finalChunks.length,
        currentUrl: 'Speichere Chunks...',
        phase: 'saving',
      });
      await fileStorage.saveProjectChunks(projectId, project.domain, finalChunks);
      await storage.updateProject(projectId, { chunks: [] });

      // Send completion event
      sendEvent({
        type: 'complete',
        chunksGenerated: finalChunks.length,
        pagesProcessed: scrapedResults.length,
        total: scrapedResults.length,
        deduplication: deduplicationStats,
        embeddings: embeddingsStats,
        enrichment: enrichmentStats,
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

  // CSV Export endpoint - streaming for large exports
  app.get('/api/projects/:id/export/csv', async (req, res) => {
    try {
      const projectId = parseInt(req.params.id);
      const project = await storage.getProject(projectId);
      
      if (!project) {
        return res.status(404).json({ message: 'Project not found' });
      }

      const chunks = await loadProjectChunks(project);
      if (chunks.length === 0) {
        return res.status(400).json({ message: 'No chunks available. Generate chunks first.' });
      }

      const fileName = `chunks_${project.domain.replace(/[^a-z0-9]/gi, '_')}_${Date.now()}.csv`;
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
      
      const escapeCSV = (value: string | null | undefined): string => {
        if (value === null || value === undefined) return '';
        const str = String(value);
        if (str.includes(',') || str.includes('"') || str.includes('\n') || str.includes('\r')) {
          return '"' + str.replace(/"/g, '""') + '"';
        }
        return str;
      };

      const headers = ['chunk_id', 'doc_id', 'text', 'url', 'heading', 'tokens', 'quality', 'keywords'];
      res.write(headers.join(',') + '\n');

      for (const chunk of chunks) {
        const keywords = chunk.ai_metadata?.keywords?.join('; ') || '';
        const row = [
          escapeCSV(chunk.chunk_id),
          escapeCSV(chunk.doc_id),
          escapeCSV(chunk.text),
          escapeCSV(chunk.location.url),
          escapeCSV(chunk.structure.heading),
          escapeCSV(String(chunk.tokens_estimate)),
          escapeCSV(chunk.quality?.quality || 'unknown'),
          escapeCSV(keywords),
        ];
        res.write(row.join(',') + '\n');
      }

      res.end();
    } catch (err) {
      console.error('CSV export error:', err);
      if (!res.headersSent) {
        res.status(500).json({ message: (err as Error).message });
      }
    }
  });

  // Parquet Export endpoint
  app.get('/api/projects/:id/export/parquet', async (req, res) => {
    try {
      const projectId = parseInt(req.params.id);
      const project = await storage.getProject(projectId);
      
      if (!project) {
        return res.status(404).json({ message: 'Project not found' });
      }

      const chunks = await loadProjectChunks(project);
      if (chunks.length === 0) {
        return res.status(400).json({ message: 'No chunks available. Generate chunks first.' });
      }

      const settings = project.projectSettings || getDefaultSettings();
      const includeEmbeddings = settings.export?.includeEmbeddings ?? false;

      const parquet = await import('parquetjs-lite');
      
      const schemaFields: Record<string, any> = {
        chunk_id: { type: 'UTF8' },
        doc_id: { type: 'UTF8' },
        chunk_index: { type: 'INT32' },
        text: { type: 'UTF8' },
        url: { type: 'UTF8' },
        heading_path: { type: 'UTF8' },
        section_path: { type: 'UTF8', optional: true },
        heading: { type: 'UTF8', optional: true },
        language: { type: 'UTF8' },
        source_url: { type: 'UTF8' },
        text_sha256: { type: 'UTF8' },
        tokens_estimate: { type: 'INT32' },
        citation: { type: 'UTF8' },
        chunk_type: { type: 'UTF8', optional: true },
        quality: { type: 'UTF8', optional: true },
        quality_warnings: { type: 'UTF8', optional: true },
        keywords: { type: 'UTF8', optional: true },
        summary: { type: 'UTF8', optional: true },
        content_hash: { type: 'UTF8', optional: true },
        created_at: { type: 'UTF8', optional: true },
        updated_at: { type: 'UTF8', optional: true },
      };

      if (includeEmbeddings) {
        schemaFields.embeddings_json = { type: 'UTF8', optional: true };
      }

      const schema = new parquet.ParquetSchema(schemaFields);

      const tmpPath = `/tmp/export_${projectId}_${Date.now()}.parquet`;
      const writer = await parquet.ParquetWriter.openFile(schema, tmpPath);

      for (const chunk of chunks) {
        const row: Record<string, any> = {
          chunk_id: chunk.chunk_id,
          doc_id: chunk.doc_id,
          chunk_index: chunk.chunk_index,
          text: chunk.text,
          url: chunk.location.url,
          heading_path: JSON.stringify(chunk.location.heading_path || []),
          section_path: chunk.structure.section_path || null,
          heading: chunk.structure.heading || null,
          language: chunk.language,
          source_url: chunk.source.source_url,
          text_sha256: chunk.hashes.text_sha256,
          tokens_estimate: chunk.tokens_estimate,
          citation: chunk.citation,
          chunk_type: chunk.chunk_type || null,
          quality: chunk.quality?.quality || null,
          quality_warnings: chunk.quality?.warnings ? JSON.stringify(chunk.quality.warnings) : null,
          keywords: chunk.ai_metadata?.keywords ? chunk.ai_metadata.keywords.join('; ') : null,
          summary: chunk.ai_metadata?.summary || null,
          content_hash: chunk.content_hash || null,
          created_at: chunk.created_at || null,
          updated_at: chunk.updated_at || null,
        };

        if (includeEmbeddings && chunk.embedding) {
          row.embeddings_json = JSON.stringify(chunk.embedding);
        }

        await writer.appendRow(row);
      }

      await writer.close();

      const fs = await import('fs');
      const fileBuffer = fs.readFileSync(tmpPath);
      fs.unlinkSync(tmpPath);

      const fileName = `chunks_${project.domain.replace(/[^a-z0-9]/gi, '_')}_${Date.now()}.parquet`;
      res.setHeader('Content-Type', 'application/octet-stream');
      res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
      res.setHeader('Content-Length', fileBuffer.length);
      res.send(fileBuffer);

    } catch (err) {
      console.error('Parquet export error:', err);
      res.status(500).json({ message: (err as Error).message });
    }
  });

  // Incremental Export endpoint
  app.get('/api/projects/:id/export/incremental', async (req, res) => {
    try {
      const projectId = parseInt(req.params.id);
      const project = await storage.getProject(projectId);
      
      if (!project) {
        return res.status(404).json({ message: 'Project not found' });
      }

      const chunks = await loadProjectChunks(project);
      if (chunks.length === 0) {
        return res.status(400).json({ message: 'No chunks available. Generate chunks first.' });
      }

      const lastExportedAt = project.lastExportedAt;
      const previousHashes: Record<string, string> = (project.exportedChunkHashes as Record<string, string>) || {};
      const currentHashes: Record<string, string> = {};
      
      const newChunks: RagChunk[] = [];
      const updatedChunks: RagChunk[] = [];
      const currentChunkIds = new Set<string>();

      for (const chunk of chunks) {
        const chunkId = chunk.chunk_id;
        const contentHash = chunk.content_hash || sha256(chunk.text);
        currentHashes[chunkId] = contentHash;
        currentChunkIds.add(chunkId);

        if (!previousHashes[chunkId]) {
          newChunks.push(chunk);
        } else if (previousHashes[chunkId] !== contentHash) {
          updatedChunks.push(chunk);
        }
      }

      const deletedChunkIds: string[] = [];
      for (const previousId of Object.keys(previousHashes)) {
        if (!currentChunkIds.has(previousId)) {
          deletedChunkIds.push(previousId);
        }
      }

      const now = new Date();
      await storage.updateProject(projectId, {
        lastExportedAt: now,
        exportedChunkHashes: currentHashes,
      } as any);

      res.json({
        newChunks,
        updatedChunks,
        deletedChunkIds,
        exportedAt: now.toISOString(),
        stats: {
          totalNew: newChunks.length,
          totalUpdated: updatedChunks.length,
          totalDeleted: deletedChunkIds.length,
        },
      });

    } catch (err) {
      console.error('Incremental export error:', err);
      res.status(500).json({ message: (err as Error).message });
    }
  });

  app.get('/api/rag-pack/download/:downloadId', async (req, res) => {
    try {
      const entry = await storage.getRagPackExportByDownloadId(req.params.downloadId);
      if (!entry) {
        return res.status(404).json({ message: 'Download nicht gefunden' });
      }
      if (new Date() > entry.expiresAt) {
        return res.status(410).json({ message: 'Download abgelaufen (älter als 30 Tage)' });
      }
      try {
        await fsPromises.access(entry.filePath);
      } catch {
        return res.status(404).json({ message: 'Export-Datei nicht mehr vorhanden' });
      }
      const stat = await fsPromises.stat(entry.filePath);
      res.setHeader('Content-Type', 'application/zip');
      res.setHeader('Content-Disposition', `attachment; filename="${entry.filename}"`);
      res.setHeader('Content-Length', stat.size);
      const { createReadStream } = await import('fs');
      const stream = createReadStream(entry.filePath);
      stream.pipe(res);
    } catch (err) {
      console.error('[RAG Pack] Download error:', err);
      res.status(500).json({ message: (err as Error).message });
    }
  });

  app.get('/api/projects/:id/exports', async (req, res) => {
    try {
      const projectId = parseInt(req.params.id);
      if (isNaN(projectId)) {
        return res.status(400).json({ message: 'Invalid project ID' });
      }
      const exports = await storage.getRagPackExportsByProject(projectId);
      const validExports = [];
      for (const exp of exports) {
        if (new Date() > exp.expiresAt) continue;
        try {
          await fsPromises.access(exp.filePath);
          validExports.push(exp);
        } catch {
          try { await storage.deleteRagPackExport(exp.id); } catch {}
        }
      }
      res.json(validExports);
    } catch (err) {
      res.status(500).json({ message: (err as Error).message });
    }
  });

  app.delete('/api/exports/:downloadId', async (req, res) => {
    try {
      const entry = await storage.getRagPackExportByDownloadId(req.params.downloadId);
      if (!entry) {
        return res.status(404).json({ message: 'Export nicht gefunden' });
      }
      try { await fsPromises.unlink(entry.filePath); } catch {}
      await storage.deleteRagPackExport(entry.id);
      res.json({ success: true });
    } catch (err) {
      res.status(500).json({ message: (err as Error).message });
    }
  });

  // Export RAG Pack as ZIP (SSE with progress)
  app.get('/api/projects/:id/rag-pack/stream', async (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');

    const sendEvent = (type: string, data: any) => {
      if (!res.writableEnded) {
        res.write(`data: ${JSON.stringify({ type, ...data })}\n\n`);
      }
    };

    let clientDisconnected = false;
    req.on('close', () => { clientDisconnected = true; });

    try {
      const projectId = parseInt(req.params.id);
      const project = await storage.getProject(projectId);
      
      if (!project) {
        sendEvent('error', { message: 'Project not found' });
        res.end();
        return;
      }

      const chunks = await loadProjectChunks(project);
      if (chunks.length === 0) {
        sendEvent('error', { message: 'No chunks available. Generate chunks first.' });
        res.end();
        return;
      }

      const settings = project.projectSettings || getDefaultSettings();
      const includeEmbeddings = settings.export?.includeEmbeddings ?? false;
      const includeAssets = settings.export?.includeAssets ?? true;
      const exportFormats = settings.export?.formats || ['json'];

      const allRagResults = (project.results || []).filter((r: any) => r.scrapedData || r.hasScrapedData);
      const scrapedResults = await loadResultsWithFilesystem(allRagResults, projectId, project.domain);
      const zip = new JSZip();
      const now = new Date().toISOString();

      // Collect all linked PDFs across all documents
      const allAssets: Array<{ url: string; title?: string; linkText?: string; docId: string; docUrl: string }> = [];
      for (const entry of scrapedResults) {
        const docId = `doc_${sha256(entry.loc).slice(0, 12)}`;
        const linkedPdfs = (entry.scrapedData as any)?.linkedPdfs;
        if (linkedPdfs && Array.isArray(linkedPdfs)) {
          for (const pdf of linkedPdfs) {
            if (pdf.url) {
              allAssets.push({ url: pdf.url, title: pdf.title, linkText: pdf.linkText, docId, docUrl: entry.loc });
            }
          }
        }
      }

      sendEvent('init', {
        totalDocuments: scrapedResults.length,
        totalPdfs: allAssets.length,
        includeAssets,
      });

      // Download and embed PDFs if includeAssets is enabled
      const assetEntries: Array<{ asset_id: string; doc_id: string; doc_url: string; url: string; title?: string; link_text?: string; filename: string; path: string; size_bytes: number; mime_type: string; downloaded: boolean; error?: string }> = [];
      const assetPathMap = new Map<string, string>();
      const pdfDocuments: any[] = [];
      const pdfChunks: any[] = [];
      const skippedBinaryPdfs: string[] = [];
      let pdfValidCount = 0;
      let pdfInvalidCount = 0;

      if (includeAssets && allAssets.length > 0) {
        const assetsFolder = zip.folder('assets');
        const seenUrls = new Set<string>();
        let assetIndex = 0;

        for (const asset of allAssets) {
          if (seenUrls.has(asset.url)) {
            const existingPath = assetPathMap.get(asset.url);
            if (existingPath) {
              assetEntries.push({
                asset_id: `asset_${sha256(asset.url).slice(0, 12)}`,
                doc_id: asset.docId,
                doc_url: asset.docUrl,
                url: asset.url,
                title: asset.title,
                link_text: asset.linkText,
                filename: existingPath.split('/').pop() || '',
                path: existingPath,
                size_bytes: 0,
                mime_type: 'application/pdf',
                downloaded: true,
              });
            }
            continue;
          }
          seenUrls.add(asset.url);

          const urlPath = asset.url.split('/').pop()?.split('?')[0] || `document_${assetIndex}`;
          const safeName = urlPath.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 100);
          const urlHash = sha256(asset.url).slice(0, 8);
          const baseName = safeName.endsWith('.pdf') ? safeName.slice(0, -4) : safeName;
          const filename = `${baseName}_${urlHash}.pdf`;
          const assetPath = `assets/${filename}`;

          try {
            let buffer: Buffer | null = null;
            const docPageDir = fileStorage.getProjectPageDir(projectId, project.domain, asset.docUrl);

            const isFailed = await fileStorage.isProjectPdfFailed(projectId, project.domain, asset.url);
            if (isFailed) {
              assetEntries.push({
                asset_id: `asset_${sha256(asset.url).slice(0, 12)}`,
                doc_id: asset.docId, doc_url: asset.docUrl, url: asset.url,
                title: asset.title, link_text: asset.linkText,
                filename: '', path: '', size_bytes: 0, mime_type: 'application/pdf',
                downloaded: false, error: 'Previously failed',
              });
              assetIndex++;
              if (clientDisconnected) break;
              continue;
            }

            buffer = await fileStorage.findProjectPdf(projectId, project.domain, asset.url, docPageDir);

            if (buffer) {
              sendEvent('progress', {
                phase: 'downloading',
                current: assetIndex + 1,
                total: seenUrls.size,
                currentUrl: asset.url,
                message: `PDF ${assetIndex + 1}/${seenUrls.size} aus Cache geladen`,
              });
            } else {
              sendEvent('progress', {
                phase: 'downloading',
                current: assetIndex + 1,
                total: seenUrls.size,
                currentUrl: asset.url,
                message: `Lade PDF ${assetIndex + 1}/${seenUrls.size} herunter...`,
              });
              const response = await fetch(asset.url, {
                headers: { 'User-Agent': 'MapScraperPro/1.0' },
                signal: AbortSignal.timeout(30000),
              });
              if (response.ok) {
                buffer = Buffer.from(await response.arrayBuffer());
                try {
                  await fileStorage.saveProjectPdf(projectId, project.domain, asset.url, buffer);
                } catch {}
              } else {
                console.warn(`[RAG Pack] Failed to download ${asset.url}: HTTP ${response.status}`);
                try {
                  await fileStorage.markProjectPdfFailed(projectId, project.domain, asset.url);
                } catch {}
                assetEntries.push({
                  asset_id: `asset_${sha256(asset.url).slice(0, 12)}`,
                  doc_id: asset.docId, doc_url: asset.docUrl, url: asset.url,
                  title: asset.title, link_text: asset.linkText,
                  filename: '', path: '', size_bytes: 0, mime_type: 'application/pdf',
                  downloaded: false, error: `HTTP ${response.status}`,
                });
                assetIndex++;
                if (clientDisconnected) break;
                continue;
              }
            }

            assetsFolder?.file(filename, buffer);
            assetPathMap.set(asset.url, assetPath);
            assetEntries.push({
              asset_id: `asset_${sha256(asset.url).slice(0, 12)}`,
              doc_id: asset.docId, doc_url: asset.docUrl, url: asset.url,
              title: asset.title, link_text: asset.linkText,
              filename, path: assetPath, size_bytes: buffer.length,
              mime_type: 'application/pdf', downloaded: true,
            });
          } catch (err) {
            console.warn(`[RAG Pack] Error downloading ${asset.url}:`, (err as Error).message);
            try {
              await fileStorage.markProjectPdfFailed(projectId, project.domain, asset.url);
            } catch {}
            assetEntries.push({
              asset_id: `asset_${sha256(asset.url).slice(0, 12)}`,
              doc_id: asset.docId, doc_url: asset.docUrl, url: asset.url,
              title: asset.title, link_text: asset.linkText,
              filename: '', path: '', size_bytes: 0, mime_type: 'application/pdf',
              downloaded: false, error: (err as Error).message,
            });
          }
          assetIndex++;
          if (clientDisconnected) break;
        }

        console.log(`[RAG Pack] Downloaded ${assetEntries.filter(a => a.downloaded).length}/${seenUrls.size} unique assets`);

        try {
          await fileStorage.buildProjectPdfsJson(projectId, project.domain);
        } catch {}
      }

      if (includeAssets) {
        const uniqueDownloadedAssets = assetEntries.filter(a => a.downloaded && a.path);
        const seenAssetPaths = new Set<string>();

        sendEvent('progress', {
          phase: 'extracting',
          current: 0,
          total: uniqueDownloadedAssets.length,
          message: 'Extrahiere Text aus PDFs...',
        });

        for (const asset of uniqueDownloadedAssets) {
          if (seenAssetPaths.has(asset.path)) continue;
          seenAssetPaths.add(asset.path);
          if (clientDisconnected) break;

          try {
            const pdfFile = zip.file(asset.path);
            if (!pdfFile) continue;

            const buffer = Buffer.from(await pdfFile.async('nodebuffer'));

            if (buffer.length < 5 || buffer.toString('ascii', 0, 5) !== '%PDF-') {
              pdfInvalidCount++;
              skippedBinaryPdfs.push(asset.filename);
              continue;
            }

            const pdfResult = await extractPdfText(buffer);
            if (!pdfResult) {
              pdfInvalidCount++;
              skippedBinaryPdfs.push(asset.filename);
              continue;
            }

            const validation = isValidPdfText(pdfResult.text);
            if (!validation.valid) {
              pdfInvalidCount++;
              skippedBinaryPdfs.push(asset.filename);
              console.log(`[RAG Pack] Skipping PDF ${asset.filename}: ${validation.reason}`);
              continue;
            }

            pdfValidCount++;

            const pdfDocId = `doc_${sha256(asset.url).slice(0, 12)}`;
            const pdfTitle = cleanPdfTitle(
              pdfResult.metadata?.Title || asset.title || asset.link_text || '',
              asset.url
            );

            const pdfDoc: any = {
              doc_id: pdfDocId,
              title: pdfTitle,
              url: asset.url,
              language: 'de',
              file_type: 'pdf',
              file_name: slugifyFilename(pdfTitle, '.pdf'),
              pdf_has_text_layer: true,
              source: {
                source_type: 'pdf',
                source_url: asset.url,
                asset_path: asset.path,
              },
              description: generateDescription(pdfResult.text),
              category: getCategoryFromUrl(asset.doc_url || asset.url),
              total_pages: pdfResult.numPages,
              dates: {
                scraped: now,
                ingested: now,
              },
              hashes: {
                content_sha256: sha256(pdfResult.text),
                source_fingerprint: sha256(asset.url + '|' + pdfTitle),
              },
            };
            pdfDocuments.push(pdfDoc);

            const pdfSections = extractSectionsFromPlainText(pdfResult.text);

            const chunkingSettings2 = settings.chunking || { targetTokens: 512, overlapTokens: 100, minChunkTokens: 80 };
            const pdfChunkedSections = chunkText(
              pdfSections,
              chunkingSettings2.targetTokens || 512,
              chunkingSettings2.overlapTokens || 100,
              chunkingSettings2.minChunkTokens || 80
            );

            pdfChunkedSections.forEach((chunk, index) => {
              const chunkId = `${pdfDocId}::c${String(index).padStart(4, '0')}`;
              const tokens = estimateTokensFast(chunk.text);

              const ragChunk: any = {
                chunk_id: chunkId,
                doc_id: pdfDocId,
                chunk_index: index,
                text: chunk.text,
                tokens_estimate: tokens,
                language: 'de',
                location: {
                  url: asset.url,
                  heading_path: chunk.headingPath?.filter(Boolean) || [],
                },
                structure: {
                  section_path: chunk.headingPath?.filter(Boolean).join(' > ') || null,
                  heading: chunk.heading,
                },
                source: {
                  source_url: asset.url,
                },
                hashes: {
                  text_sha256: sha256(chunk.text),
                },
                citation: `${pdfTitle}${chunk.heading ? ', ' + chunk.heading : ''} (${asset.url})`,
                chunk_type: chunk.type || 'text',
              };
              pdfChunks.push(ragChunk);
            });

            console.log(`[RAG Pack] PDF ${asset.filename}: ${pdfChunkedSections.length} chunks from ${pdfResult.numPages} pages`);
            sendEvent('progress', {
              phase: 'extracting',
              current: seenAssetPaths.size,
              total: uniqueDownloadedAssets.length,
              currentUrl: asset.filename,
              message: `PDF Text extrahiert: ${asset.filename}`,
            });
          } catch (err) {
            console.warn(`[RAG Pack] Error processing PDF ${asset.filename}:`, (err as Error).message);
            pdfInvalidCount++;
            skippedBinaryPdfs.push(asset.filename);
          }
        }

        console.log(`[RAG Pack] PDF processing: ${pdfValidCount} valid, ${pdfInvalidCount} invalid/skipped`);
      }

      sendEvent('progress', {
        phase: 'building',
        current: 0,
        total: 1,
        message: 'Erstelle Dokumente und Chunks...',
      });

      const documentsJsonl = [
        ...scrapedResults.map(entry => {
          const docId = `doc_${sha256(entry.loc).slice(0, 12)}`;
          const rawTitle = entry.scrapedData?.title || '';
          const cleanedTitle = cleanHtmlTitle(rawTitle, entry.loc);
          const textContent = (entry.scrapedData?.orderedElements || [])
            .filter((el: any) => el.type === 'text' || el.type === 'heading' || el.type === 'paragraph')
            .map((el: any) => el.content || '')
            .join(' ');

          const doc: any = {
            doc_id: docId,
            title: cleanedTitle,
            url: entry.loc,
            language: 'de',
            file_type: 'html',
            file_name: slugifyFilename(cleanedTitle, '.html'),
            source: {
              source_type: 'website',
              source_url: entry.loc,
            },
            description: generateDescription(textContent),
            category: getCategoryFromUrl(entry.loc),
            dates: {
              scraped: entry.scrapedData?.timestamp || now,
              ingested: now,
            },
            hashes: {
              content_sha256: sha256(JSON.stringify(entry.scrapedData?.orderedElements || [])),
              source_fingerprint: sha256(entry.loc + '|' + cleanedTitle),
            },
          };

          const linkedPdfs = (entry.scrapedData as any)?.linkedPdfs;
          if (linkedPdfs && linkedPdfs.length > 0) {
            doc.linked_pdfs = linkedPdfs.map((pdf: any) => {
              const pdfEntry: any = {
                url: pdf.url,
                title: pdf.title || pdf.linkText || undefined,
                link_text: pdf.linkText || undefined,
              };
              if (includeAssets) {
                const localPath = assetPathMap.get(pdf.url);
                if (localPath) pdfEntry.local_path = localPath;
              }
              return pdfEntry;
            });
          }

          return JSON.stringify(doc);
        }),
        ...pdfDocuments.map(doc => JSON.stringify(doc)),
      ].join('\n');

      const processedChunks = chunks.map((chunk: any) => {
        const processed = { ...chunk };
        if (!includeEmbeddings) delete processed.embedding;
        if (!processed.citation) {
          processed.citation = `${processed.doc_id}, Chunk ${processed.chunk_index}`;
        }
        return processed;
      });
      const allExportChunks = [...processedChunks, ...pdfChunks];
      const chunksJsonl = allExportChunks.map(chunk => JSON.stringify(chunk)).join('\n');

      const chunkingSettings = project.projectSettings?.chunking || {
        targetTokens: 512,
        overlapTokens: 100,
        minChunkTokens: 80,
        boundaryRules: ['paragraph', 'heading'],
        deduplication: { enabled: true, similarityThreshold: 0.90 },
      };

      const manifest = {
        rag_pack_version: '2.0',
        created_at: now,
        generator: {
          name: 'MapScraper Pro',
          version: '2.0',
        },
        source: {
          domain: project.domain,
          project_name: project.displayName || project.domain,
        },
        chunking: {
          profile: 'retrieval_v1',
          tokenizer: 'cl100k_base',
          chunk_size_tokens: chunkingSettings.targetTokens,
          chunk_overlap_tokens: chunkingSettings.overlapTokens,
          min_chunk_tokens: chunkingSettings.minChunkTokens || 80,
          split_strategy: 'semantic_paragraph_then_token',
          short_chunk_policy: 'merge_if_possible_else_drop',
          boundary_rules: chunkingSettings.boundaryRules,
          dedup: {
            enabled: chunkingSettings.deduplication?.enabled ?? true,
            method: 'text_sha256_and_jaccard_per_doc',
            similarity_threshold: chunkingSettings.deduplication?.similarityThreshold ?? 0.90,
          },
        },
        export: {
          formats: exportFormats,
          include_embeddings: includeEmbeddings,
          include_assets: includeAssets,
        },
        counts: {
          documents: scrapedResults.length + pdfDocuments.length,
          chunks: allExportChunks.length,
          assets: includeAssets ? assetEntries.filter(a => a.downloaded).length : 0,
          assets_total: includeAssets ? allAssets.length : 0,
          pdf_valid: pdfValidCount,
          pdf_invalid: pdfInvalidCount,
          skipped_documents: pdfInvalidCount,
        },
        quality_report: {
          documents_with_text_layer: pdfValidCount,
          documents_without_text_layer: pdfInvalidCount,
          skipped_binary_pdfs: skippedBinaryPdfs,
          avg_tokens_per_chunk: allExportChunks.length > 0
            ? Math.round(allExportChunks.reduce((sum: number, c: any) => sum + (c.tokens_estimate || 0), 0) / allExportChunks.length)
            : 0,
          min_tokens_in_chunk: allExportChunks.length > 0
            ? Math.min(...allExportChunks.map((c: any) => c.tokens_estimate || 0))
            : 0,
          max_tokens_in_chunk: allExportChunks.length > 0
            ? Math.max(...allExportChunks.map((c: any) => c.tokens_estimate || 0))
            : 0,
        },
        checksums: {
          'documents.jsonl': `sha256:${sha256(documentsJsonl)}`,
          'chunks.jsonl': `sha256:${sha256(chunksJsonl)}`,
        } as Record<string, string>,
      };

      let assetsJsonl = '';
      if (includeAssets && assetEntries.length > 0) {
        assetsJsonl = assetEntries.map(a => JSON.stringify(a)).join('\n');
        (manifest.checksums as Record<string, string>)['assets.jsonl'] = `sha256:${sha256(assetsJsonl)}`;
      }

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
          "file_type": { "type": "string", "enum": ["html", "pdf"] },
          "file_name": { "type": "string" },
          "pdf_has_text_layer": { "type": "boolean" },
          "description": { "type": "string" },
          "category": { "type": "string" },
          "total_pages": { "type": "integer" },
          "source": { "type": "object", "properties": { "source_type": { "type": "string" }, "source_url": { "type": "string" }, "asset_path": { "type": "string" } } },
          "dates": { "type": "object" },
          "hashes": { "type": "object" },
          "linked_pdfs": {
            "type": "array",
            "items": {
              "type": "object",
              "properties": {
                "url": { "type": "string" },
                "title": { "type": "string" },
                "link_text": { "type": "string" },
                "local_path": { "type": "string", "description": "Path to the downloaded asset within the RAG Pack ZIP" }
              },
              "required": ["url"]
            }
          },
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
          "chunk_type": { "type": "string", "enum": ["text", "table", "code", "mixed"] },
          "quality_flags": { "type": "object" },
        },
      };

      const manifestSchema = {
        "$schema": "https://json-schema.org/draft/2020-12/schema",
        "title": "manifest.json schema",
        "type": "object",
        "required": ["rag_pack_version", "created_at", "generator", "source", "chunking", "counts", "checksums"],
      };

      const assetsSchema = {
        "$schema": "https://json-schema.org/draft/2020-12/schema",
        "title": "assets.jsonl schema",
        "type": "object",
        "required": ["asset_id", "doc_id", "url", "filename", "path", "downloaded"],
        "properties": {
          "asset_id": { "type": "string" },
          "doc_id": { "type": "string" },
          "doc_url": { "type": "string" },
          "url": { "type": "string" },
          "title": { "type": "string" },
          "link_text": { "type": "string" },
          "filename": { "type": "string" },
          "path": { "type": "string", "description": "Local path within the RAG Pack ZIP" },
          "size_bytes": { "type": "integer" },
          "mime_type": { "type": "string" },
          "downloaded": { "type": "boolean" },
          "error": { "type": "string" },
          "sha256": { "type": "string" },
          "valid_pdf": { "type": "boolean" },
        },
      };

      // Add files to ZIP
      zip.file('documents.jsonl', documentsJsonl);
      zip.file('chunks.jsonl', chunksJsonl);
      if (assetsJsonl) {
        zip.file('assets.jsonl', assetsJsonl);
      }
      zip.file('manifest.json', JSON.stringify(manifest, null, 2));
      zip.folder('schema')?.file('documents.schema.json', JSON.stringify(documentsSchema, null, 2));
      zip.folder('schema')?.file('chunks.schema.json', JSON.stringify(chunksSchema, null, 2));
      zip.folder('schema')?.file('manifest.schema.json', JSON.stringify(manifestSchema, null, 2));
      if (assetsJsonl) {
        zip.folder('schema')?.file('assets.schema.json', JSON.stringify(assetsSchema, null, 2));
      }

      sendEvent('progress', {
        phase: 'zipping',
        current: 0,
        total: 1,
        message: 'Erstelle ZIP-Archiv...',
      });

      // Generate ZIP buffer
      const zipBuffer = await zip.generateAsync({ type: 'nodebuffer' });

      const downloadId = sha256(`${projectId}-${Date.now()}-${Math.random()}`).slice(0, 16);
      const fileName = `rag_pack_${project.domain.replace(/[^a-z0-9]/gi, '_')}_${Date.now()}.zip`;
      const exportStats = {
        documents: scrapedResults.length + pdfDocuments.length,
        chunks: allExportChunks.length,
        pdfValid: pdfValidCount,
        pdfInvalid: pdfInvalidCount,
        assets: assetEntries.filter(a => a.downloaded).length,
      };
      const stored = await saveRagPackExport(projectId, project.domain, downloadId, zipBuffer, fileName, exportStats);
      if (!stored) {
        sendEvent('error', { message: 'Export konnte nicht gespeichert werden' });
        res.end();
        return;
      }

      sendEvent('complete', {
        downloadId,
        filename: fileName,
        fileSize: zipBuffer.length,
        ...exportStats,
      });
      res.end();

    } catch (err) {
      console.error('RAG Pack export error:', err);
      try {
        sendEvent('error', { message: (err as Error).message });
        res.end();
      } catch {
        res.end();
      }
    }
  });

  app.get('/api/projects/:id/rag-pack', async (req, res) => {
    res.status(400).json({
      message: 'Use /api/projects/:id/rag-pack/stream for SSE progress, then download from /api/rag-pack/download/:id'
    });
  });

  // Migration endpoint: export existing DB data to filesystem
  app.post('/api/projects/:id/migrate-to-filesystem', async (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');

    const sendEvent = (type: string, data: any) => {
      if (!res.writableEnded) {
        res.write(`data: ${JSON.stringify({ type, ...data })}\n\n`);
      }
    };

    let clientDisconnected = false;
    req.on('close', () => { clientDisconnected = true; });

    try {
      const projectId = Number(req.params.id);
      const project = await storage.getProject(projectId);
      if (!project) {
        sendEvent('error', { message: 'Project not found' });
        res.end();
        return;
      }

      const results = (project.results || []).filter((r: any) => r.scrapedData);
      sendEvent('init', { totalPages: results.length });

      // Save project meta
      try {
        const projDir = fileStorage.getProjectDir(projectId, project.domain);
        await fileStorage.saveProjectMeta(projDir, {
          id: project.id,
          domain: project.domain,
          displayName: project.displayName,
          createdAt: project.createdAt,
          projectSettings: project.projectSettings,
        });
      } catch (e) {
        console.error('[Migration] Error saving project meta:', (e as Error).message);
      }

      let migrated = 0;
      let skipped = 0;

      for (const result of results) {
        if (clientDisconnected) break;
        const url = result.loc;
        const data = result.scrapedData;

        try {
          const pageDir = fileStorage.getProjectPageDir(projectId, project.domain, url);
          
          // Check if already migrated
          const existing = await fileStorage.readPageContent(pageDir);
          if (existing) {
            skipped++;
            migrated++;
            sendEvent('progress', { current: migrated, total: results.length, skipped, url: url.slice(0, 80), message: `Übersprungen (existiert): ${url.slice(0, 60)}` });
            continue;
          }

          const markdown = orderedElementsToMarkdown(data.orderedElements || []);
          await fileStorage.savePageContent(pageDir, markdown);
          await fileStorage.savePageMeta(pageDir, {
            url,
            title: data.title,
            timestamp: data.timestamp,
            wordCount: data.wordCount,
            structuredData: data.structuredData,
            linkedPdfs: data.linkedPdfs,
            orderedElements: data.orderedElements,
          });

          migrated++;
          sendEvent('progress', { current: migrated, total: results.length, skipped, url: url.slice(0, 80), message: `Migriert: ${url.slice(0, 60)}` });
        } catch (err) {
          migrated++;
          sendEvent('progress', { current: migrated, total: results.length, skipped, url: url.slice(0, 80), message: `Fehler: ${(err as Error).message}` });
        }
      }

      sendEvent('complete', { migrated: migrated - skipped, skipped, total: results.length });
      res.end();
    } catch (err) {
      sendEvent('error', { message: (err as Error).message });
      res.end();
    }
  });

  app.get('/api/projects/:id/pdf', async (req, res) => {
    try {
      const projectId = Number(req.params.id);
      const pageUrl = req.query.url as string;
      const pdfUrl = req.query.pdfUrl as string;
      const filename = req.query.filename as string;
      if (!pageUrl || !filename) {
        return res.status(400).json({ message: 'Missing url or filename query parameter' });
      }
      const project = await storage.getProject(projectId);
      if (!project) {
        return res.status(404).json({ message: 'Project not found' });
      }
      const pageDir = fileStorage.getProjectPageDir(projectId, project.domain, pageUrl);
      const safeName = fileStorage.sanitizeDirName(filename.replace(/\.pdf$/i, '')) + '.pdf';
      const pdfPath = path.join(pageDir, 'pdfs', safeName);

      let fileBuffer: Buffer | null = null;
      try {
        fileBuffer = await fsPromises.readFile(pdfPath);
      } catch {
        if (!pdfUrl) {
          return res.status(404).json({ message: 'PDF not found on filesystem' });
        }
        // Validate: only allow downloads from the project's own domain
        try {
          const parsedPdfUrl = new URL(pdfUrl);
          const projectDomain = project.domain.toLowerCase().replace(/^www\./, '');
          const pdfDomain = parsedPdfUrl.hostname.toLowerCase().replace(/^www\./, '');
          if (pdfDomain !== projectDomain) {
            return res.status(403).json({ message: 'PDF URL domain does not match project domain' });
          }
        } catch {
          return res.status(400).json({ message: 'Invalid PDF URL' });
        }
        try {
          const pdfResponse = await fetch(pdfUrl, {
            headers: { 'User-Agent': 'Mozilla/5.0 (compatible; SitemapScraper/1.0)' },
            signal: AbortSignal.timeout(30000),
          });
          if (!pdfResponse.ok) {
            return res.status(404).json({ message: `PDF not available (HTTP ${pdfResponse.status})` });
          }
          const contentType = pdfResponse.headers.get('content-type') || '';
          if (!contentType.includes('pdf') && !contentType.includes('octet-stream')) {
            return res.status(400).json({ message: 'Response is not a PDF' });
          }
          fileBuffer = Buffer.from(await pdfResponse.arrayBuffer());
          if (fileBuffer.length > 50 * 1024 * 1024) {
            return res.status(413).json({ message: 'PDF too large (>50MB)' });
          }
          await fileStorage.savePdf(pageDir, filename, fileBuffer);
        } catch (dlErr) {
          return res.status(404).json({ message: `PDF not available: ${(dlErr as Error).message}` });
        }
      }

      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `attachment; filename="${safeName}"`);
      res.send(fileBuffer);
    } catch (err) {
      res.status(500).json({ message: (err as Error).message });
    }
  });

  app.get('/api/projects/:id/pdfs', async (req, res) => {
    try {
      const projectId = Number(req.params.id);
      const project = await storage.getProject(projectId);
      if (!project) return res.status(404).json({ message: 'Project not found' });

      let pdfs = await fileStorage.readProjectPdfsJson(projectId, project.domain);
      if (!pdfs) {
        pdfs = await fileStorage.buildProjectPdfsJson(projectId, project.domain);
      }
      res.json({
        total: pdfs.length,
        downloaded: pdfs.filter(p => p.downloaded).length,
        pdfs,
      });
    } catch (err) {
      res.status(500).json({ message: (err as Error).message });
    }
  });

  app.post('/api/projects/:id/pdfs/rebuild', async (req, res) => {
    try {
      const projectId = Number(req.params.id);
      const project = await storage.getProject(projectId);
      if (!project) return res.status(404).json({ message: 'Project not found' });

      const pdfs = await fileStorage.buildProjectPdfsJson(projectId, project.domain);
      res.json({
        total: pdfs.length,
        downloaded: pdfs.filter(p => p.downloaded).length,
      });
    } catch (err) {
      res.status(500).json({ message: (err as Error).message });
    }
  });

  app.get('/api/storage/stats', async (_req, res) => {
    try {
      const stats = await fileStorage.getStorageStats();
      res.json(stats);
    } catch (err) {
      res.status(500).json({ message: (err as Error).message });
    }
  });

  app.post('/api/admin/migrate-chunks-to-filesystem', async (_req, res) => {
    try {
      const migrated: string[] = [];

      const projectRows = await db.execute(sql`
        SELECT id, domain, chunks FROM projects 
        WHERE jsonb_array_length(COALESCE(chunks, '[]'::jsonb)) > 0
      `);
      for (const row of projectRows.rows as any[]) {
        const chunks = row.chunks || [];
        if (chunks.length > 0) {
          await fileStorage.saveProjectChunks(row.id, row.domain, chunks);
          await db.execute(sql`UPDATE projects SET chunks = '[]'::jsonb WHERE id = ${row.id}`);
          migrated.push(`project:${row.id} (${row.domain}) - ${chunks.length} chunks`);
        }
      }

      const spRows = await db.execute(sql`
        SELECT id, domain, chunks FROM single_pages 
        WHERE jsonb_array_length(COALESCE(chunks, '[]'::jsonb)) > 0
      `);
      for (const row of spRows.rows as any[]) {
        const chunks = row.chunks || [];
        if (chunks.length > 0) {
          await fileStorage.saveSinglePageChunks(row.id, row.domain, chunks);
          await db.execute(sql`UPDATE single_pages SET chunks = '[]'::jsonb WHERE id = ${row.id}`);
          migrated.push(`single-page:${row.id} (${row.domain}) - ${chunks.length} chunks`);
        }
      }

      res.json({ success: true, migrated });
    } catch (err) {
      console.error('Chunk migration error:', err);
      res.status(500).json({ message: (err as Error).message });
    }
  });

  return httpServer;
}
