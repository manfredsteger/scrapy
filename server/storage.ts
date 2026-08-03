import { db } from "./db";
import { projects, settings, singlePages, ragPackExports, converterExports, type Project, type InsertProject, type Settings, type InsertSettings, type SinglePage, type InsertSinglePage, type RagPackExport, type InsertRagPackExport, type ConverterExport, type InsertConverterExport } from "@shared/schema";
import { eq, desc, sql, and, lt } from "drizzle-orm";

// Lightweight project type for list views (without large data fields)
export interface ProjectLite {
  id: number;
  domain: string;
  displayName: string | null;
  status: string;
  queue: any[];
  errors: any[];
  stats: any;
  projectSettings: any;
  lastScraped: Date | null;
  createdAt: Date | null;
  version: number;
  scrapeLock: { owner: string; expiresAt: number } | null;
  updateRun: any | null;
  urlCount: number;
  scrapedCount: number;
  failedCount: number;
}

export interface IStorage {
  getProjects(): Promise<Project[]>;
  getProjectsLite(): Promise<ProjectLite[]>;
  getProject(id: number): Promise<Project | undefined>;
  getProjectLite(id: number): Promise<any | undefined>;
  createProject(project: InsertProject): Promise<Project>;
  updateProject(id: number, updates: Partial<InsertProject> & { scrapeLock?: { owner: string; expiresAt: number } | null }, guard?: { expectedVersion?: number; enforceLockOwner?: string }): Promise<Project | undefined>;
  deleteProject(id: number): Promise<void>;
  getSetting(key: string): Promise<Settings | undefined>;
  setSetting(key: string, value: string): Promise<Settings>;
  getSinglePages(): Promise<SinglePage[]>;
  getSinglePage(id: number): Promise<SinglePage | undefined>;
  createSinglePage(data: InsertSinglePage): Promise<SinglePage>;
  updateSinglePage(id: number, data: Partial<SinglePage>): Promise<SinglePage | undefined>;
  deleteSinglePage(id: number): Promise<boolean>;
  createRagPackExport(data: InsertRagPackExport): Promise<RagPackExport>;
  getRagPackExportsByProject(projectId: number): Promise<RagPackExport[]>;
  getRagPackExportByDownloadId(downloadId: string): Promise<RagPackExport | undefined>;
  deleteRagPackExport(id: number): Promise<void>;
  deleteExpiredRagPackExports(): Promise<RagPackExport[]>;
  createConverterExport(data: InsertConverterExport): Promise<ConverterExport>;
  getConverterExports(): Promise<ConverterExport[]>;
  getConverterExportByDownloadId(downloadId: string): Promise<ConverterExport | undefined>;
  renameConverterExport(id: number, name: string): Promise<ConverterExport | undefined>;
  deleteConverterExport(id: number): Promise<void>;
}

export class DatabaseStorage implements IStorage {
  async getProjects(): Promise<Project[]> {
    return await db.select().from(projects).orderBy(desc(projects.lastScraped));
  }

  // Optimized: Get project list with counts computed in SQL (no large data transfer)
  async getProjectsLite(): Promise<ProjectLite[]> {
    const result = await db.execute(sql`
      SELECT 
        id, domain, display_name, status, queue, errors, stats, 
        project_settings, last_scraped, created_at, version, scrape_lock, update_run,
        jsonb_array_length(COALESCE(results, '[]'::jsonb)) as url_count,
        (SELECT count(*) FROM jsonb_array_elements(COALESCE(results, '[]'::jsonb)) r 
         WHERE (r->>'hasScrapedData')::boolean = true 
            OR (r->'scrapedData' IS NOT NULL AND jsonb_typeof(r->'scrapedData') = 'object')) as scraped_count,
        (SELECT count(*) FROM jsonb_array_elements(COALESCE(results, '[]'::jsonb)) r 
         WHERE r->>'status' = 'failed'
            OR r->>'errorStatus' IS NOT NULL 
            OR (r->>'errorMessage' IS NOT NULL AND (r->>'hasScrapedData')::boolean IS NOT TRUE AND (r->'scrapedData' IS NULL OR jsonb_typeof(r->'scrapedData') != 'object'))) as failed_count
      FROM projects 
      ORDER BY last_scraped DESC NULLS LAST
    `);
    
    return (result.rows as any[]).map(row => ({
      id: row.id,
      domain: row.domain,
      displayName: row.display_name,
      status: row.status || 'idle',
      queue: row.queue || [],
      errors: row.errors || [],
      stats: row.stats || null,
      projectSettings: row.project_settings || null,
      lastScraped: row.last_scraped,
      createdAt: row.created_at,
      version: parseInt(row.version) || 0,
      scrapeLock: row.scrape_lock || null,
      updateRun: row.update_run || null,
      urlCount: parseInt(row.url_count) || 0,
      scrapedCount: parseInt(row.scraped_count) || 0,
      failedCount: parseInt(row.failed_count) || 0,
    }));
  }

  async getProject(id: number): Promise<Project | undefined> {
    const [project] = await db.select().from(projects).where(eq(projects.id, id));
    return project;
  }

  // Optimized: Get single project with results stripped of scrapedData (computed in SQL)
  // Does NOT load chunks or full scrapedData to minimize data transfer
  async getProjectLite(id: number): Promise<any | undefined> {
    const result = await db.execute(sql`
      SELECT 
        id, domain, display_name, status, queue, crawl_depths, processed, errors, stats, 
        project_settings, last_exported_at, exported_chunk_hashes,
        last_scraped, created_at, version, scrape_lock, update_run,
        jsonb_array_length(COALESCE(chunks, '[]'::jsonb)) as chunk_count,
        (
          SELECT jsonb_agg(
            jsonb_build_object(
              'loc', r->>'loc',
              'lastmod', r->>'lastmod',
              'changefreq', r->>'changefreq',
              'priority', r->>'priority',
              'images', COALESCE(r->'images', '[]'::jsonb),
              'videos', COALESCE(r->'videos', '[]'::jsonb),
              'hasScrapedData', COALESCE((r->>'hasScrapedData')::boolean, r->'scrapedData' IS NOT NULL AND jsonb_typeof(r->'scrapedData') = 'object'),
              'status', COALESCE(r->>'status', CASE WHEN (r->>'hasScrapedData')::boolean = true THEN 'scraped' WHEN r->>'errorMessage' IS NOT NULL THEN 'failed' ELSE 'pending' END),
              'pdfCount', 0,
              'errorStatus', r->>'errorStatus',
              'errorMessage', r->>'errorMessage',
              'removedFromSource', COALESCE((r->>'removedFromSource')::boolean, false)
            )
          )
          FROM jsonb_array_elements(COALESCE(results, '[]'::jsonb)) r
        ) as results
      FROM projects 
      WHERE id = ${id}
    `);
    
    if (result.rows.length === 0) return undefined;
    
    const row = result.rows[0] as any;
    return {
      id: row.id,
      domain: row.domain,
      displayName: row.display_name,
      status: row.status || 'idle',
      queue: row.queue || [],
      crawlDepths: row.crawl_depths || {},
      processed: row.processed || [],
      errors: row.errors || [],
      stats: row.stats || null,
      projectSettings: row.project_settings || null,
      chunks: [], // Don't send actual chunks - only count available
      chunkCount: parseInt(row.chunk_count) || 0,
      lastExportedAt: row.last_exported_at,
      exportedChunkHashes: row.exported_chunk_hashes || {},
      lastScraped: row.last_scraped,
      createdAt: row.created_at,
      version: parseInt(row.version) || 0,
      scrapeLock: row.scrape_lock || null,
      updateRun: row.update_run || null,
      results: row.results || [],
    };
  }

  async createProject(insertProject: InsertProject): Promise<Project> {
    const [project] = await db.insert(projects).values({
      ...insertProject,
      lastScraped: new Date(),
    }).returning();
    return project;
  }

  // Updates a project, always incrementing its version. The optional guard makes
  // the write conditional *atomically* (conditions live in the UPDATE's WHERE):
  // - expectedVersion: compare-and-swap against the stored version
  // - enforceLockOwner: only write if the scrape lock is free, expired, or owned
  //   by this owner (lock check + write is one atomic DB operation)
  // Returns undefined when the row doesn't match (not found or guard failed).
  async updateProject(
    id: number,
    updates: Partial<InsertProject> & { scrapeLock?: { owner: string; expiresAt: number } | null },
    guard?: { expectedVersion?: number; enforceLockOwner?: string },
  ): Promise<Project | undefined> {
    const conditions: any[] = [eq(projects.id, id)];
    if (guard?.expectedVersion !== undefined) {
      conditions.push(eq(projects.version, guard.expectedVersion));
    }
    if (guard?.enforceLockOwner !== undefined) {
      const now = Date.now();
      conditions.push(sql`(
        ${projects.scrapeLock} IS NULL
        OR jsonb_typeof(${projects.scrapeLock}) = 'null'
        OR COALESCE((${projects.scrapeLock}->>'expiresAt')::bigint, 0) <= ${now}
        OR ${projects.scrapeLock}->>'owner' = ${guard.enforceLockOwner}
      )`);
    }
    const [project] = await db.update(projects)
      .set({ ...updates, lastScraped: new Date(), version: sql`${projects.version} + 1` })
      .where(and(...conditions))
      .returning();
    return project;
  }

  async deleteProject(id: number): Promise<void> {
    await db.delete(projects).where(eq(projects.id, id));
  }

  // Get scraped data for a single URL in a project (lazy loading for content preview)
  async getProjectUrlScrapedData(projectId: number, urlLoc: string): Promise<any | null> {
    const result = await db.execute(sql`
      SELECT r.value as url_entry
      FROM projects p,
           jsonb_array_elements(COALESCE(p.results, '[]'::jsonb)) r
      WHERE p.id = ${projectId}
        AND r.value->>'loc' = ${urlLoc}
      LIMIT 1
    `);
    
    if (result.rows.length === 0) return null;
    const row = result.rows[0] as any;
    return row.url_entry;
  }

  async getSetting(key: string): Promise<Settings | undefined> {
    const [setting] = await db.select().from(settings).where(eq(settings.key, key));
    return setting;
  }

  async setSetting(key: string, value: string): Promise<Settings> {
    const existing = await this.getSetting(key);
    if (existing) {
      const [updated] = await db.update(settings)
        .set({ value })
        .where(eq(settings.key, key))
        .returning();
      return updated;
    }
    const [created] = await db.insert(settings).values({ key, value }).returning();
    return created;
  }

  async getSinglePages(): Promise<SinglePage[]> {
    return await db.select().from(singlePages).orderBy(desc(singlePages.createdAt));
  }

  async getSinglePage(id: number): Promise<SinglePage | undefined> {
    const [singlePage] = await db.select().from(singlePages).where(eq(singlePages.id, id));
    return singlePage;
  }

  async createSinglePage(data: InsertSinglePage): Promise<SinglePage> {
    const [singlePage] = await db.insert(singlePages).values(data).returning();
    return singlePage;
  }

  async updateSinglePage(id: number, data: Partial<SinglePage>): Promise<SinglePage | undefined> {
    const [singlePage] = await db.update(singlePages)
      .set(data)
      .where(eq(singlePages.id, id))
      .returning();
    return singlePage;
  }

  async deleteSinglePage(id: number): Promise<boolean> {
    const result = await db.delete(singlePages).where(eq(singlePages.id, id));
    return true;
  }

  async createRagPackExport(data: InsertRagPackExport): Promise<RagPackExport> {
    const [entry] = await db.insert(ragPackExports).values(data).returning();
    return entry;
  }

  async getRagPackExportsByProject(projectId: number): Promise<RagPackExport[]> {
    return await db.select().from(ragPackExports)
      .where(eq(ragPackExports.projectId, projectId))
      .orderBy(desc(ragPackExports.createdAt));
  }

  async getRagPackExportByDownloadId(downloadId: string): Promise<RagPackExport | undefined> {
    const [entry] = await db.select().from(ragPackExports)
      .where(eq(ragPackExports.downloadId, downloadId));
    return entry;
  }

  async deleteRagPackExport(id: number): Promise<void> {
    await db.delete(ragPackExports).where(eq(ragPackExports.id, id));
  }

  async deleteExpiredRagPackExports(): Promise<RagPackExport[]> {
    const expired = await db.select().from(ragPackExports)
      .where(lt(ragPackExports.expiresAt, new Date()));
    if (expired.length > 0) {
      await db.delete(ragPackExports)
        .where(lt(ragPackExports.expiresAt, new Date()));
    }
    return expired;
  }

  async createConverterExport(data: InsertConverterExport): Promise<ConverterExport> {
    const [entry] = await db.insert(converterExports).values(data).returning();
    return entry;
  }

  async getConverterExports(): Promise<ConverterExport[]> {
    return await db.select().from(converterExports)
      .orderBy(desc(converterExports.createdAt));
  }

  async getConverterExportByDownloadId(downloadId: string): Promise<ConverterExport | undefined> {
    const [entry] = await db.select().from(converterExports)
      .where(eq(converterExports.downloadId, downloadId));
    return entry;
  }

  async renameConverterExport(id: number, name: string): Promise<ConverterExport | undefined> {
    const [entry] = await db.update(converterExports)
      .set({ name })
      .where(eq(converterExports.id, id))
      .returning();
    return entry;
  }

  async deleteConverterExport(id: number): Promise<void> {
    await db.delete(converterExports).where(eq(converterExports.id, id));
  }
}

export const storage = new DatabaseStorage();
