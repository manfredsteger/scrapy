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
  type: z.enum(['heading', 'paragraph', 'list', 'blockquote', 'media', 'table', 'code']),
  tag: z.string().optional(),
  content: z.string().optional(),
  children: z.array(z.any()).optional(),
  src: z.string().optional(),
  alt: z.string().optional(),
  level: z.number().optional(),
});

// Scraped page content with DOM structure preserved
export const scrapedDataSchema = z.object({
  title: z.string(),
  orderedElements: z.array(scrapedElementSchema),
  timestamp: z.string(),
  wordCount: z.number(),
  rawHtml: z.string().optional(),
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

// Project settings schema for deep scraping and chunking configuration
export const projectSettingsSchema = z.object({
  // Deep Scraping Settings
  scraping: z.object({
    parallelRequests: z.number().min(1).max(20).default(10),
    delayMs: z.number().min(0).max(10000).default(500),
    contentSelectors: z.array(z.string()).default(['article', 'main', '.content', '#content']),
    excludeSelectors: z.array(z.string()).default(['nav', 'footer', 'header', '.sidebar', '.ads']),
    maxDepth: z.number().min(1).max(10).default(5),
  }).default({}),
  // Chunking Settings
  chunking: z.object({
    targetTokens: z.number().min(100).max(2000).default(350),
    overlapTokens: z.number().min(0).max(200).default(55),
    boundaryRules: z.array(z.enum(['paragraph', 'heading', 'sentence'])).default(['paragraph', 'heading']),
    preserveHeadingHierarchy: z.boolean().default(true),
    minChunkTokens: z.number().min(20).max(500).default(50),
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
  }).default({}),
}).default({});

export type ProjectSettings = z.infer<typeof projectSettingsSchema>;

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
});

export type RagChunk = z.infer<typeof ragChunkSchema>;
