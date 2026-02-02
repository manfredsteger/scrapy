import { db } from "./db";
import { projects, settings, singlePages, type Project, type InsertProject, type Settings, type InsertSettings, type SinglePage, type InsertSinglePage } from "@shared/schema";
import { eq, desc, sql } from "drizzle-orm";

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
  updateProject(id: number, updates: Partial<InsertProject>): Promise<Project | undefined>;
  deleteProject(id: number): Promise<void>;
  getSetting(key: string): Promise<Settings | undefined>;
  setSetting(key: string, value: string): Promise<Settings>;
  getSinglePages(): Promise<SinglePage[]>;
  getSinglePage(id: number): Promise<SinglePage | undefined>;
  createSinglePage(data: InsertSinglePage): Promise<SinglePage>;
  updateSinglePage(id: number, data: Partial<SinglePage>): Promise<SinglePage | undefined>;
  deleteSinglePage(id: number): Promise<boolean>;
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
        project_settings, last_scraped, created_at,
        jsonb_array_length(COALESCE(results, '[]'::jsonb)) as url_count,
        (SELECT count(*) FROM jsonb_array_elements(COALESCE(results, '[]'::jsonb)) r 
         WHERE r->'scrapedData' IS NOT NULL AND jsonb_typeof(r->'scrapedData') = 'object') as scraped_count,
        (SELECT count(*) FROM jsonb_array_elements(COALESCE(results, '[]'::jsonb)) r 
         WHERE r->>'errorStatus' IS NOT NULL) as failed_count
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
        id, domain, display_name, status, queue, errors, stats, 
        project_settings, last_exported_at, exported_chunk_hashes,
        last_scraped, created_at,
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
              'hasScrapedData', (r->'scrapedData' IS NOT NULL AND jsonb_typeof(r->'scrapedData') = 'object'),
              'errorStatus', r->>'errorStatus',
              'errorMessage', r->>'errorMessage'
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
      errors: row.errors || [],
      stats: row.stats || null,
      projectSettings: row.project_settings || null,
      chunks: [], // Don't send actual chunks - only count available
      chunkCount: parseInt(row.chunk_count) || 0,
      lastExportedAt: row.last_exported_at,
      exportedChunkHashes: row.exported_chunk_hashes || {},
      lastScraped: row.last_scraped,
      createdAt: row.created_at,
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

  async updateProject(id: number, updates: Partial<InsertProject>): Promise<Project | undefined> {
    const [project] = await db.update(projects)
      .set({ ...updates, lastScraped: new Date() })
      .where(eq(projects.id, id))
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
}

export const storage = new DatabaseStorage();
