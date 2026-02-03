import { pgTable, text, serial, integer, timestamp, jsonb, boolean } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod";

// Image metadata from sitemap
export const imageMetadataSchema = z.object({
  loc: z.string(),
  title: z.string().optional(),
  caption: z.string().optional(),
  geoLocation: z.string().optional(),
  license: z.string().optional(),
});

// Video metadata from sitemap
export const videoMetadataSchema = z.object({
  thumbnailLoc: z.string().optional(),
  title: z.string().optional(),
  description: z.string().optional(),
  contentLoc: z.string().optional(),
  playerLoc: z.string().optional(),
  duration: z.string().optional(),
  viewCount: z.string().optional(),
  publicationDate: z.string().optional(),
  rating: z.string().optional(),
});

// Scraped DOM element preserving structure
export const scrapedElementSchema = z.object({
  type: z.enum(['heading', 'paragraph', 'list', 'blockquote', 'media', 'table', 'code', 'quote', 'card']),
  tag: z.string().optional(),
  content: z.string().optional(),
  children: z.array(z.any()).optional(),
  src: z.string().optional(),
  alt: z.string().optional(),
  level: z.number().optional(),
  listType: z.enum(['ordered', 'unordered']).optional(),
  items: z.array(z.string()).optional(),
  headers: z.array(z.string()).optional(),
  rows: z.array(z.array(z.string())).optional(),
  language: z.string().optional(),
  image: z.string().optional(),
  imageAlt: z.string().optional(),
});

// Structured data extracted from pages (JSON-LD, Schema.org) - defined here before use
export const structuredDataSchema = z.object({
  jsonLd: z.array(z.any()).optional(),
  schemaOrg: z.array(z.any()).optional(),
  openGraph: z.record(z.string()).optional(),
  twitterCard: z.record(z.string()).optional(),
});

export type StructuredData = z.infer<typeof structuredDataSchema>;

// Scraped page content with DOM structure preserved
export const scrapedDataSchema = z.object({
  title: z.string(),
  orderedElements: z.array(scrapedElementSchema),
  timestamp: z.string(),
  wordCount: z.number(),
  rawHtml: z.string().optional(),
  structuredData: structuredDataSchema.optional(),
});

// Sitemap URL entry
export const sitemapUrlEntrySchema = z.object({
  loc: z.string(),
  lastmod: z.string().optional(),
  changefreq: z.string().optional(),
  priority: z.string().optional(),
  images: z.array(imageMetadataSchema),
  videos: z.array(videoMetadataSchema),
  scrapedData: scrapedDataSchema.optional(),
  hasScrapedData: z.boolean().optional(), // Lightweight indicator from API (scrapedData stripped)
});

// Scraping error
export const scrapingErrorSchema = z.object({
  url: z.string(),
  message: z.string(),
  timestamp: z.string(),
});

// Scraping stats
export const scrapingStatsSchema = z.object({
  totalSitemaps: z.number(),
  processedSitemaps: z.number(),
  totalUrls: z.number(),
  totalImages: z.number(),
  totalVideos: z.number(),
  startTime: z.number(),
  endTime: z.number().optional(),
  scrapedPages: z.number().optional(),
});

// Exported chunk hash tracking for incremental updates
export const exportedChunkHashSchema = z.record(z.string(), z.string());
export type ExportedChunkHashes = z.infer<typeof exportedChunkHashSchema>;

// Database table for projects
export const projects = pgTable("projects", {
  id: serial("id").primaryKey(),
  domain: text("domain").notNull(),
  displayName: text("display_name"),
  lastScraped: timestamp("last_scraped").defaultNow(),
  status: text("status").notNull().default("idle"),
  queue: jsonb("queue").$type<string[]>().default([]),
  processed: jsonb("processed").$type<string[]>().default([]),
  results: jsonb("results").$type<z.infer<typeof sitemapUrlEntrySchema>[]>().default([]),
  errors: jsonb("errors").$type<z.infer<typeof scrapingErrorSchema>[]>().default([]),
  stats: jsonb("stats").$type<z.infer<typeof scrapingStatsSchema>>(),
  projectSettings: jsonb("project_settings").$type<z.infer<typeof projectSettingsSchema>>(),
  chunks: jsonb("chunks").$type<z.infer<typeof ragChunkSchema>[]>().default([]),
  lastExportedAt: timestamp("last_exported_at"),
  exportedChunkHashes: jsonb("exported_chunk_hashes").$type<z.infer<typeof exportedChunkHashSchema>>().default({}),
  createdAt: timestamp("created_at").defaultNow(),
});

export const insertProjectSchema = createInsertSchema(projects).omit({ 
  id: true, 
  createdAt: true,
  lastScraped: true,
});

export type Project = typeof projects.$inferSelect;
export type InsertProject = z.infer<typeof insertProjectSchema>;
export type ImageMetadata = z.infer<typeof imageMetadataSchema>;
export type VideoMetadata = z.infer<typeof videoMetadataSchema>;
export type ScrapedElement = z.infer<typeof scrapedElementSchema>;
export type ScrapedData = z.infer<typeof scrapedDataSchema>;
export type SitemapUrlEntry = z.infer<typeof sitemapUrlEntrySchema>;
export type ScrapingError = z.infer<typeof scrapingErrorSchema>;
export type ScrapingStats = z.infer<typeof scrapingStatsSchema>;

// Settings table for user preferences
export const settings = pgTable("settings", {
  id: serial("id").primaryKey(),
  key: text("key").notNull().unique(),
  value: text("value").notNull(),
});

export const insertSettingsSchema = createInsertSchema(settings).omit({ id: true });
export type Settings = typeof settings.$inferSelect;
export type InsertSettings = z.infer<typeof insertSettingsSchema>;

// Proxy configuration (must be defined before projectSettingsSchema)
export const proxyConfigSchema = z.object({
  url: z.string(),
  username: z.string().optional(),
  password: z.string().optional(),
  protocol: z.enum(['http', 'https', 'socks5']).default('http'),
});

export type ProxyConfig = z.infer<typeof proxyConfigSchema>;

// Project settings schema for deep scraping and chunking configuration
export const projectSettingsSchema = z.object({
  // Deep Scraping Settings
  scraping: z.object({
    parallelRequests: z.number().min(1).max(20).default(10),
    delayMs: z.number().min(0).max(10000).default(500),
    contentSelectors: z.array(z.string()).default(['article', 'main', '.content', '#content']),
    excludeSelectors: z.array(z.string()).default(['nav', 'footer', 'header', '.sidebar', '.ads']),
    maxDepth: z.number().min(1).max(10).default(5),
    // Rate limiting with auto-adjustment
    rateLimiting: z.object({
      enabled: z.boolean().default(true),
      baseDelayMs: z.number().min(100).max(10000).default(500),
      maxDelayMs: z.number().min(1000).max(60000).default(30000),
      backoffMultiplier: z.number().min(1.5).max(5).default(2),
    }).default({}),
    // Proxy rotation
    proxies: z.array(proxyConfigSchema).default([]),
    rotateProxies: z.boolean().default(false),
    // Structured data extraction
    extractStructuredData: z.boolean().default(true),
  }).default({}),
  // Chunking Settings
  chunking: z.object({
    targetTokens: z.number().min(100).max(2000).default(350),
    overlapTokens: z.number().min(0).max(200).default(55),
    boundaryRules: z.array(z.enum(['paragraph', 'heading', 'sentence'])).default(['paragraph', 'heading']),
    preserveHeadingHierarchy: z.boolean().default(true),
    minChunkTokens: z.number().min(20).max(500).default(50),
    // Table and code handling
    preserveTables: z.boolean().default(true),
    preserveCodeBlocks: z.boolean().default(true),
    // Multi-language support
    multiLanguageTokenization: z.boolean().default(true),
    // Quality checks
    qualityChecks: z.object({
      enabled: z.boolean().default(true),
      minWordCount: z.number().min(5).max(100).default(10),
      warnOnShortChunks: z.boolean().default(true),
      warnOnNoContent: z.boolean().default(true),
    }).default({}),
    // Deduplication
    deduplication: z.object({
      enabled: z.boolean().default(true),
      similarityThreshold: z.number().min(0.7).max(1).default(0.95),
    }).default({}),
  }).default({}),
  // AI Integration Settings (optional)
  ai: z.object({
    enabled: z.boolean().default(false),
    endpoint: z.string().optional(),
    bearerToken: z.string().optional(),
    model: z.string().default('gpt-4o-mini'),
    features: z.object({
      semanticChunking: z.boolean().default(false),
      summaries: z.boolean().default(false),
      keywordExtraction: z.boolean().default(false),
    }).default({}),
    // Embeddings
    embeddings: z.object({
      enabled: z.boolean().default(false),
      model: z.string().default('text-embedding-3-small'),
      dimensions: z.number().min(256).max(3072).default(1536),
    }).default({}),
    // Metadata enrichment
    metadataEnrichment: z.object({
      enabled: z.boolean().default(false),
      extractKeywords: z.boolean().default(true),
      generateSummary: z.boolean().default(true),
      detectCategory: z.boolean().default(false),
      extractEntities: z.boolean().default(false),
    }).default({}),
  }).default({}),
  // Export settings
  export: z.object({
    formats: z.array(z.enum(['json', 'csv', 'parquet', 'markdown'])).default(['json']),
    includeEmbeddings: z.boolean().default(false),
    incrementalUpdates: z.boolean().default(true),
  }).default({}),
}).default({});

export type ProjectSettings = z.infer<typeof projectSettingsSchema>;

// Table chunk metadata
export const tableChunkSchema = z.object({
  headers: z.array(z.string()),
  rows: z.array(z.array(z.string())),
  caption: z.string().optional(),
  summary: z.string().optional(),
});

export type TableChunk = z.infer<typeof tableChunkSchema>;

// Code block metadata
export const codeBlockSchema = z.object({
  language: z.string().optional(),
  code: z.string(),
  lineCount: z.number(),
});

export type CodeBlock = z.infer<typeof codeBlockSchema>;

// Chunk quality metrics
export const chunkQualitySchema = z.object({
  tokenCount: z.number(),
  wordCount: z.number(),
  sentenceCount: z.number(),
  hasContent: z.boolean(),
  quality: z.enum(['good', 'warning', 'poor']),
  warnings: z.array(z.string()).optional(),
});

export type ChunkQuality = z.infer<typeof chunkQualitySchema>;

// AI-enriched metadata
export const aiMetadataSchema = z.object({
  keywords: z.array(z.string()).optional(),
  summary: z.string().optional(),
  category: z.string().optional(),
  entities: z.array(z.object({
    text: z.string(),
    type: z.string(),
  })).optional(),
  sentiment: z.enum(['positive', 'neutral', 'negative']).optional(),
});

export type AiMetadata = z.infer<typeof aiMetadataSchema>;

// RAG Pack chunk schema
export const ragChunkSchema = z.object({
  chunk_id: z.string(),
  doc_id: z.string(),
  chunk_index: z.number(),
  text: z.string(),
  location: z.object({
    url: z.string(),
    heading_path: z.array(z.string()).optional(),
  }),
  structure: z.object({
    section_path: z.string().nullable(),
    heading: z.string().nullable(),
  }),
  language: z.string(),
  source: z.object({
    source_url: z.string(),
  }),
  hashes: z.object({
    text_sha256: z.string(),
  }),
  tokens_estimate: z.number(),
  citation: z.string(),
  // New fields for enhanced features
  chunk_type: z.enum(['text', 'table', 'code', 'mixed']).optional(),
  table_data: tableChunkSchema.optional(),
  code_block: codeBlockSchema.optional(),
  quality: chunkQualitySchema.optional(),
  embedding: z.array(z.number()).optional(),
  ai_metadata: aiMetadataSchema.optional(),
  content_hash: z.string().optional(),
  is_duplicate: z.boolean().optional(),
  duplicate_of: z.string().optional(),
  created_at: z.string().optional(),
  updated_at: z.string().optional(),
});

export type RagChunk = z.infer<typeof ragChunkSchema>;

// Rate limiting state
export const rateLimitStateSchema = z.object({
  currentDelay: z.number(),
  baseDelay: z.number(),
  maxDelay: z.number(),
  backoffMultiplier: z.number(),
  consecutiveErrors: z.number(),
  lastRequestTime: z.number().optional(),
});

export type RateLimitState = z.infer<typeof rateLimitStateSchema>;

// Chunk statistics schema
export const chunkStatsSchema = z.object({
  totalChunks: z.number(),
  textChunks: z.number(),
  tableChunks: z.number(),
  codeChunks: z.number(),
  exactDuplicates: z.number(),
  nearDuplicates: z.number(),
  uniqueChunks: z.number(),
  totalTokens: z.number(),
  avgTokensPerChunk: z.number(),
  embeddingsGenerated: z.number().optional(),
  enrichmentStats: z.object({
    keywordsExtracted: z.number(),
    summariesGenerated: z.number(),
  }).optional(),
});

export type ChunkStats = z.infer<typeof chunkStatsSchema>;

// Single page scraping table
export const singlePages = pgTable("single_pages", {
  id: serial("id").primaryKey(),
  url: text("url").notNull(),
  title: text("title"),
  domain: text("domain").notNull(),
  scrapedData: jsonb("scraped_data").$type<ScrapedData>(),
  structuredData: jsonb("structured_data").$type<StructuredData>(),
  wordCount: integer("word_count").default(0),
  imageCount: integer("image_count").default(0),
  videoCount: integer("video_count").default(0),
  chunks: jsonb("chunks").$type<RagChunk[]>(),
  chunkStats: jsonb("chunk_stats").$type<ChunkStats>(),
  status: text("status").notNull().default("pending"), // pending, scraping, chunking, completed, error
  error: text("error"),
  createdAt: timestamp("created_at").defaultNow(),
});

export const insertSinglePageSchema = createInsertSchema(singlePages).omit({
  id: true,
  createdAt: true,
});

export type SinglePage = typeof singlePages.$inferSelect;
export type InsertSinglePage = z.infer<typeof insertSinglePageSchema>;
