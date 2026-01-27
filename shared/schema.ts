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
