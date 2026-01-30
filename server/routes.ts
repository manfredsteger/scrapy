import type { Express } from "express";
import type { Server } from "http";
import { storage } from "./storage";
import { api } from "@shared/routes";
import { z } from "zod";
import { JSDOM } from "jsdom";
import { encode } from "gpt-tokenizer";
import crypto from "crypto";
import JSZip from "jszip";
import { ProxyAgent, fetch as undiciFetch } from "undici";
import type { RagChunk, ProjectSettings, ScrapedElement, SitemapUrlEntry, StructuredData, ChunkQuality, TableChunk, CodeBlock, RateLimitState, ProxyConfig, ChunkStats } from "@shared/schema";

const CONCURRENCY = 10;

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

// CJK character detection regex (Chinese, Japanese, Korean)
const CJK_REGEX = /[\u3000-\u303f\u3040-\u309f\u30a0-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\ufe30-\ufe4f\u20000-\u2a6df\u2a700-\u2b73f\u2b740-\u2b81f\u2b820-\u2ceaf\u2ceb0-\u2ebef\u30000-\u3134f\uac00-\ud7af\u1100-\u11ff\u3130-\u318f\ua960-\ua97f\ud7b0-\ud7ff]/g;

// Chunking utility functions
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
  const tokenCount = estimateTokens(text, true);
  const words = text.trim().split(/\s+/).filter(w => w.length > 0);
  const wordCount = words.length;
  
  // Count sentences (basic heuristic)
  const sentences = text.split(/[.!?]+/).filter(s => s.trim().length > 0);
  const sentenceCount = sentences.length;
  
  // Check for meaningful content (not just whitespace/punctuation)
  const alphanumericContent = text.replace(/[\s\p{P}]/gu, '');
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
  threshold: number = 0.95
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

  // First pass: Mark exact duplicates by content_hash
  const hashToOriginal = new Map<string, string>(); // content_hash -> chunk_id
  const processedChunks: RagChunk[] = [];

  for (const chunk of chunks) {
    const hash = chunk.content_hash || sha256(chunk.text);
    
    if (hashToOriginal.has(hash)) {
      // Exact duplicate found
      stats.exactDuplicates++;
      processedChunks.push({
        ...chunk,
        content_hash: hash,
        is_duplicate: true,
        duplicate_of: hashToOriginal.get(hash)!,
      });
    } else {
      // First occurrence
      hashToOriginal.set(hash, chunk.chunk_id);
      processedChunks.push({
        ...chunk,
        content_hash: hash,
        is_duplicate: false,
      });
    }
  }

  // Second pass: Near-duplicate detection using Jaccard similarity
  // Only compare non-duplicates against each other
  const nonDuplicates = processedChunks.filter(c => !c.is_duplicate);
  
  // Pre-compute word sets for efficiency
  const wordSets = new Map<string, Set<string>>();
  for (const chunk of nonDuplicates) {
    wordSets.set(chunk.chunk_id, getWordSet(chunk.text));
  }

  // Track which chunks are marked as near-duplicates
  const nearDuplicateIds = new Set<string>();
  const nearDuplicateOf = new Map<string, string>();

  // Compare each pair (optimize by only comparing against earlier chunks)
  for (let i = 1; i < nonDuplicates.length; i++) {
    const chunkB = nonDuplicates[i];
    const setB = wordSets.get(chunkB.chunk_id)!;
    
    // Skip if already marked as near-duplicate
    if (nearDuplicateIds.has(chunkB.chunk_id)) continue;
    
    for (let j = 0; j < i; j++) {
      const chunkA = nonDuplicates[j];
      
      // Skip if chunkA is already a near-duplicate (only compare against originals)
      if (nearDuplicateIds.has(chunkA.chunk_id)) continue;
      
      const setA = wordSets.get(chunkA.chunk_id)!;
      
      // Quick size check: if size difference is too large, similarity can't be high
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

  // Apply near-duplicate markers
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
    if (currentChunk && estimateTokens(currentChunk) >= minChunkTokens) {
      chunks.push({ 
        text: currentChunk.trim(), 
        heading: currentHeading,
        headingPath: [...currentHeadingPath],
        type: 'text',
      });
      return true;
    }
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
      if (saveTextChunk()) {
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
    const tokens = estimateTokens(currentChunk);
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
    targetTokens: 350,
    overlapTokens: 55,
    minChunkTokens: 50,
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
      similarityThreshold: 0.95,
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
      const tokens = estimateTokens(chunk.text, useMultiLang);
      
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

function scrapePageContent(html: string, url: string, extractStructuredDataFlag: boolean = true): any {
  const dom = new JSDOM(html);
  const doc = dom.window.document;
  
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
    
    // Check element's own classes and id
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
    
    // Use enhanced skip detection
    if (shouldSkipElement(el)) {
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
              const absoluteSrc = new URL(imgSrc, url).href;
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
  
  const result: any = {
    title: doc.title || url,
    orderedElements,
    timestamp: new Date().toISOString(),
    wordCount: totalWords,
  };

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
  
  app.get(api.projects.list.path, async (req, res) => {
    const allProjects = await storage.getProjects();
    // Return lightweight summaries without full results/chunks data to prevent memory issues
    const summaries = allProjects.map(p => ({
      ...p,
      // For very large projects, don't send full results - just count
      results: p.results && p.results.length > 100 
        ? p.results.slice(0, 20) // Send first 20 for preview
        : p.results,
      // Add result count for UI
      _resultsCount: p.results?.length || 0,
      // Calculate scraped count using multiple fallbacks:
      // 1. Count results with scrapedData
      // 2. Use stats.scrapedPages if available
      // 3. If chunks exist, assume all results were scraped
      _scrapedCount: (() => {
        const scrapedDataCount = p.results?.filter(r => r.scrapedData).length || 0;
        if (scrapedDataCount > 0) return scrapedDataCount;
        // Check stats.scrapedPages
        const statsScrapedPages = (p.stats as any)?.scrapedPages;
        if (statsScrapedPages && statsScrapedPages > 0) return statsScrapedPages;
        // If chunks exist, assume all results were scraped (project completed chunking)
        if (p.chunks && p.chunks.length > 0) {
          return p.results?.length || 0;
        }
        return 0;
      })(),
      // Don't send large chunks array in list view
      chunks: undefined,
      _chunksCount: p.chunks?.length || 0,
    }));
    res.json(summaries);
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

    res.json(singlePage);
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

        // Count images and videos from scraped data
        const imageCount = scrapedResult.orderedElements?.filter((el: any) => el.type === 'media' && el.tag === 'img').length || 0;
        const videoCount = scrapedResult.orderedElements?.filter((el: any) => el.type === 'media' && el.tag === 'video').length || 0;

        // Update status to chunking
        await storage.updateSinglePage(singlePage.id, {
          title: scrapedResult.title,
          scrapedData: scrapedResult,
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
          const tokens = estimateTokens(chunk.text, useMultiLang);

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

        // Update with final data
        const updatedPage = await storage.updateSinglePage(singlePage.id, {
          chunks: allChunks,
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

  app.delete("/api/single-pages/:id", async (req, res) => {
    const id = Number(req.params.id);
    if (isNaN(id)) {
      return res.status(400).json({ message: 'Invalid ID' });
    }

    const deleted = await storage.deleteSinglePage(id);
    res.status(204).send();
  });

  app.get("/api/single-pages/:id/rag-pack", async (req, res) => {
    try {
      const id = Number(req.params.id);
      if (isNaN(id)) {
        return res.status(400).json({ message: 'Invalid ID' });
      }

      const singlePage = await storage.getSinglePage(id);
      if (!singlePage) {
        return res.status(404).json({ message: 'Single page not found' });
      }

      const chunks = singlePage.chunks || [];
      if (chunks.length === 0) {
        return res.status(400).json({ message: 'No chunks available.' });
      }

      const zip = new JSZip();
      const now = new Date().toISOString();
      const docId = `doc_${sha256(singlePage.url).slice(0, 12)}`;

      const documentObj = {
        doc_id: docId,
        title: singlePage.title || '',
        url: singlePage.url,
        domain: singlePage.domain,
        language: 'de',
        source: {
          source_type: 'single_page',
          source_url: singlePage.url,
        },
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
          content_sha256: sha256(JSON.stringify(singlePage.scrapedData?.orderedElements || [])),
        },
      };

      const documentsJsonl = JSON.stringify(documentObj);
      const chunksJsonl = chunks.map(chunk => {
        const { embedding, ...chunkWithoutEmbedding } = chunk;
        return JSON.stringify(chunkWithoutEmbedding);
      }).join('\n');

      const manifest = {
        version: '1.0',
        created_at: now,
        source: {
          url: singlePage.url,
          domain: singlePage.domain,
          type: 'single_page',
        },
        counts: {
          documents: 1,
          chunks: chunks.length,
        },
        checksums: {
          documents_sha256: sha256(documentsJsonl),
          chunks_sha256: sha256(chunksJsonl),
        },
      };

      zip.file('manifest.json', JSON.stringify(manifest, null, 2));
      zip.file('documents.jsonl', documentsJsonl);
      zip.file('chunks.jsonl', chunksJsonl);

      const schemaFolder = zip.folder('schema');
      schemaFolder?.file('manifest.schema.json', JSON.stringify({
        "$schema": "http://json-schema.org/draft-07/schema#",
        "type": "object",
        "properties": {
          "version": { "type": "string" },
          "created_at": { "type": "string", "format": "date-time" },
        }
      }, null, 2));

      const content = await zip.generateAsync({ type: 'nodebuffer' });
      const filename = `rag-pack-single-${singlePage.domain}-${singlePage.id}.zip`;

      res.set({
        'Content-Type': 'application/zip',
        'Content-Disposition': `attachment; filename="${filename}"`,
        'Content-Length': content.length,
      });
      res.send(content);
    } catch (err) {
      console.error('Error generating single page RAG pack:', err);
      res.status(500).json({ message: (err as Error).message });
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
          // Return wiki pages as direct URLs (not sitemaps)
          res.json({ sitemaps: [], wikiJsPages: wikiPages, isWikiJs: true });
          return;
        }
      }
      
      const sitemaps = await discoverSitemaps(input.domain);
      res.json({ sitemaps, isWikiJs: false });
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
      
      // Get project settings if projectId is provided for rate limiting/proxy support
      let rateLimiter: RateLimiter | undefined;
      let proxyRotator: ProxyRotator | undefined;
      let extractStructuredDataFlag = true; // Default to true
      
      if (input.projectId) {
        const project = await storage.getProject(input.projectId);
        if (project?.projectSettings?.scraping) {
          const settings = project.projectSettings.scraping;
          rateLimiter = new RateLimiter(settings.rateLimiting);
          proxyRotator = new ProxyRotator(settings.proxies, settings.rotateProxies);
          extractStructuredDataFlag = settings.extractStructuredData ?? true;
        }
      }
      
      const results = await Promise.all(urls.map(async (url) => {
        try {
          const { text: html, usedProxy } = await fetchWithRateLimitAndProxy(url, {
            rateLimiter,
            proxyRotator,
          });
          const data = scrapePageContent(html, url, extractStructuredDataFlag);
          return { url, data, error: null, usedProxy };
        } catch (err) {
          return { url, data: null, error: (err as Error).message };
        }
      }));
      
      // Include rate limiter state in response for debugging
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
                if (!resolvedUrl.match(/\.(pdf|jpg|jpeg|png|gif|svg|css|js|zip|tar|gz|ico|woff|woff2|ttf|eot)$/i)) {
                  const cleanUrl = resolvedUrl.split('#')[0].split('?')[0];
                  if (cleanUrl && !cleanUrl.endsWith('/manifest.json')) {
                    links.push(cleanUrl);
                  }
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
          const uniqueLinks = [...new Set(links)];
          
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

      const scrapedResults = (project.results || []).filter(r => r.scrapedData);
      if (scrapedResults.length === 0) {
        return res.status(400).json({ message: 'No scraped content available. Run deep scraping first.' });
      }

      const settings: ProjectSettings = project.projectSettings || getDefaultSettings();

      const { chunks, deduplicationStats } = generateChunksForProject(scrapedResults, project.domain, settings);

      await storage.updateProject(projectId, { chunks });

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
          const tokens = estimateTokens(chunk.text, useMultiLang);
          
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

        const threshold = chunkingSettings.deduplication?.similarityThreshold ?? 0.95;
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

      // Save chunks to database
      await storage.updateProject(projectId, { chunks: finalChunks });

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

      const chunks = project.chunks || [];
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

      const chunks = project.chunks || [];
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

      const chunks = project.chunks || [];
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

      const settings = project.projectSettings || getDefaultSettings();
      const includeEmbeddings = settings.export?.includeEmbeddings ?? false;
      const exportFormats = settings.export?.formats || ['json'];

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

      // Create chunks.jsonl - respect includeEmbeddings setting
      const processedChunks = chunks.map(chunk => {
        if (!includeEmbeddings) {
          const { embedding, ...chunkWithoutEmbedding } = chunk;
          return chunkWithoutEmbedding;
        }
        return chunk;
      });
      const chunksJsonl = processedChunks.map(chunk => JSON.stringify(chunk)).join('\n');

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
        export: {
          formats: exportFormats,
          include_embeddings: includeEmbeddings,
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
