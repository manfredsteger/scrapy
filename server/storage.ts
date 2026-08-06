import { db } from "./db";
import { projects, projectResults, settings, singlePages, ragPackExports, converterExports, type Project, type InsertProject, type Settings, type InsertSettings, type SinglePage, type InsertSinglePage, type RagPackExport, type InsertRagPackExport, type ConverterExport, type InsertConverterExport } from "@shared/schema";
import { eq, desc, sql, and, lt, asc, inArray } from "drizzle-orm";

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
  getProjectSettingsOnly(id: number): Promise<{ status: string; projectSettings: any | null; scrapeLock: { owner: string; expiresAt: number } | null } | undefined>;
  getProjectCrawlState(id: number): Promise<any | undefined>;
  appendCrawlProgress(
    id: number,
    delta: {
      queue: string[];
      crawlDepths: Record<string, number>;
      processedAppend: string[];
      resultsAppend: any[];
      errorsAppend: any[];
      stats: any;
      scrapeLock: { owner: string; expiresAt: number };
    },
    guard: { expectedVersion: number; enforceLockOwner: string },
  ): Promise<{ version: number } | undefined>;
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

const RESULT_INSERT_BATCH = 200;
export class DatabaseStorage implements IStorage {
  async getProjects(): Promise<Project[]> {
    const rows = await db.select().from(projects).orderBy(desc(projects.lastScraped));
    if (rows.length === 0) return rows;
    const ids = rows.map(r => r.id);
    const entries = await db.select({ projectId: projectResults.projectId, entry: projectResults.entry })
      .from(projectResults)
      .where(inArray(projectResults.projectId, ids))
      .orderBy(asc(projectResults.id));
    const byProject = new Map<number, any[]>();
    for (const e of entries) {
      const list = byProject.get(e.projectId) || [];
      list.push(e.entry);
      byProject.set(e.projectId, list);
    }
    return rows.map(r => ({ ...r, results: byProject.get(r.id) || [] }));
  }

  // Optimized: Get project list with counts computed in SQL (no large data transfer)
  async getProjectsLite(): Promise<ProjectLite[]> {
    const result = await db.execute(sql`
      SELECT 
        id, domain, display_name, status, queue, errors, stats, 
        project_settings, last_scraped, created_at, version, scrape_lock, update_run,
        (SELECT count(*) FROM project_results pr WHERE pr.project_id = projects.id) as url_count,
        (SELECT count(*) FROM project_results pr 
         WHERE pr.project_id = projects.id
           AND ((pr.entry->>'hasScrapedData')::boolean = true 
            OR (pr.entry->'scrapedData' IS NOT NULL AND jsonb_typeof(pr.entry->'scrapedData') = 'object'))) as scraped_count,
        (SELECT count(*) FROM project_results pr 
         WHERE pr.project_id = projects.id
           AND (pr.entry->>'status' = 'failed'
            OR pr.entry->>'errorStatus' IS NOT NULL 
            OR (pr.entry->>'errorMessage' IS NOT NULL AND (pr.entry->>'hasScrapedData')::boolean IS NOT TRUE AND (pr.entry->'scrapedData' IS NULL OR jsonb_typeof(pr.entry->'scrapedData') != 'object')))) as failed_count
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
    if (!project) return undefined;
    return { ...project, results: await this.loadResults(db, id) };
  }

  // Optimized: Get single project with results stripped of scrapedData (computed in SQL)
  // Does NOT load chunks or full scrapedData to minimize data transfer
  // `skipResults` omits the (potentially huge — images/videos arrays for
  // every page) results array entirely; callers that only need project
  // metadata plus counts should set it and fetch result rows separately via
  // getProjectResultsPage, keeping this call cheap even on 10k+ page projects.
  async getProjectLite(id: number, opts: { skipResults?: boolean } = {}): Promise<any | undefined> {
    const resultsSelect = opts.skipResults
      ? sql`'[]'::jsonb as results`
      : sql`(
          SELECT jsonb_agg(
            jsonb_build_object(
              'loc', pr.entry->>'loc',
              'lastmod', pr.entry->>'lastmod',
              'changefreq', pr.entry->>'changefreq',
              'priority', pr.entry->>'priority',
              'images', COALESCE(pr.entry->'images', '[]'::jsonb),
              'videos', COALESCE(pr.entry->'videos', '[]'::jsonb),
              'hasScrapedData', COALESCE((pr.entry->>'hasScrapedData')::boolean, pr.entry->'scrapedData' IS NOT NULL AND jsonb_typeof(pr.entry->'scrapedData') = 'object'),
              'status', COALESCE(pr.entry->>'status', CASE WHEN (pr.entry->>'hasScrapedData')::boolean = true THEN 'scraped' WHEN pr.entry->>'errorMessage' IS NOT NULL THEN 'failed' ELSE 'pending' END),
              'pdfCount', 0,
              'errorStatus', pr.entry->>'errorStatus',
              'errorMessage', pr.entry->>'errorMessage',
              'removedFromSource', COALESCE((pr.entry->>'removedFromSource')::boolean, false)
            )
            ORDER BY pr.id
          )
          FROM project_results pr
          WHERE pr.project_id = projects.id
        ) as results`;
    const result = await db.execute(sql`
      SELECT
        id, domain, display_name, status, queue, crawl_depths, processed, errors, stats,
        project_settings, last_exported_at, exported_chunk_hashes,
        last_scraped, created_at, version, scrape_lock, update_run,
        jsonb_array_length(COALESCE(chunks, '[]'::jsonb)) as chunk_count,
        (SELECT count(*) FROM project_results pr WHERE pr.project_id = projects.id) as url_count,
        (SELECT count(*) FROM project_results pr
         WHERE pr.project_id = projects.id
           AND ((pr.entry->>'hasScrapedData')::boolean = true
            OR (pr.entry->'scrapedData' IS NOT NULL AND jsonb_typeof(pr.entry->'scrapedData') = 'object'))) as scraped_count,
        (SELECT count(*) FROM project_results pr
         WHERE pr.project_id = projects.id
           AND (pr.entry->>'status' = 'failed'
            OR pr.entry->>'errorStatus' IS NOT NULL
            OR (pr.entry->>'errorMessage' IS NOT NULL AND (pr.entry->>'hasScrapedData')::boolean IS NOT TRUE AND (pr.entry->'scrapedData' IS NULL OR jsonb_typeof(pr.entry->'scrapedData') != 'object')))) as failed_count,
        ${resultsSelect}
      FROM projects 
      WHERE id = ${id}
    `);
    
    if (result.rows.length === 0) return undefined;
    
    const row = result.rows[0] as any;
    const urlCount = parseInt(row.url_count) || 0;
    const scrapedCount = parseInt(row.scraped_count) || 0;
    const failedCount = parseInt(row.failed_count) || 0;
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
      urlCount,
      scrapedCount,
      failedCount,
      pendingCount: Math.max(0, urlCount - scrapedCount - failedCount),
      // attachmentCount (PDF count) is filled in by the route handler from
      // fileStorage, which is the source of truth for per-page PDF counts.
      attachmentCount: 0,
    };
  }

  async createProject(insertProject: InsertProject): Promise<Project> {
    const { results: initialResults, ...rest } = insertProject as any;
    return await db.transaction(async (tx) => {
      const [project] = await tx.insert(projects).values({
        ...rest,
        results: [], // legacy column stays empty; rows live in project_results
        lastScraped: new Date(),
      }).returning();
      const entries = Array.isArray(initialResults) ? initialResults : [];
      if (entries.length > 0) {
        await this.insertResultRows(tx, project.id, entries);
      }
      return { ...project, results: entries };
    });
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
    // Results live in the normalized project_results table now. Strip them
    // from the project-row update and replace the rows only after the guarded
    // UPDATE succeeded (same transaction, so CAS/lock failures change nothing).
    const { results: newResults, ...rowUpdates } = updates as any;
    const hasResultsUpdate = 'results' in (updates as any);
    return await db.transaction(async (tx) => {
      const [project] = await tx.update(projects)
        .set({ ...rowUpdates, lastScraped: new Date(), version: sql`${projects.version} + 1` })
        .where(and(...conditions))
        .returning();
      if (!project) return undefined;
      if (hasResultsUpdate) {
        await this.replaceResultRows(tx, id, Array.isArray(newResults) ? newResults : []);
        return { ...project, results: Array.isArray(newResults) ? newResults : [] };
      }
      return { ...project, results: await this.loadResults(tx, id) };
    });
  }

  // Lightweight settings/status load — avoids pulling the multi-MB
  // queue/processed/results jsonb columns when an endpoint only needs
  // settings (e.g. per-batch rate-limit configuration).
  async getProjectSettingsOnly(id: number): Promise<{ status: string; projectSettings: any | null; scrapeLock: { owner: string; expiresAt: number } | null } | undefined> {
    const result = await db.execute(sql`
      SELECT status, project_settings, scrape_lock FROM projects WHERE id = ${id}
    `);
    if (result.rows.length === 0) return undefined;
    const row = result.rows[0] as any;
    return {
      status: row.status || 'idle',
      projectSettings: row.project_settings || null,
      scrapeLock: row.scrape_lock || null,
    };
  }

  // Crawl-loop state without the heavy results payload. The crawl loop only
  // needs result LOCs for dedup — not images/videos/scrapedData. On large
  // projects this shrinks the per-batch read from tens of MB to a few hundred KB.
  async getProjectCrawlState(id: number): Promise<any | undefined> {
    const result = await db.execute(sql`
      SELECT
        id, status, domain, queue, crawl_depths, processed, errors, stats,
        project_settings, version, scrape_lock, update_run,
        (
          SELECT COALESCE(jsonb_agg(pr.loc ORDER BY pr.id), '[]'::jsonb)
          FROM project_results pr
          WHERE pr.project_id = projects.id
        ) AS result_locs
      FROM projects
      WHERE id = ${id}
    `);
    if (result.rows.length === 0) return undefined;
    const row = result.rows[0] as any;
    return {
      id: row.id,
      status: row.status || 'idle',
      domain: row.domain,
      queue: row.queue || [],
      crawlDepths: row.crawl_depths || {},
      processed: row.processed || [],
      errors: row.errors || [],
      stats: row.stats || null,
      projectSettings: row.project_settings || null,
      version: parseInt(row.version) || 0,
      scrapeLock: row.scrape_lock || null,
      updateRun: row.update_run || null,
      resultLocs: row.result_locs || [],
    };
  }

  // Atomic delta write for crawl progress: appends new results/processed/errors
  // in SQL instead of the client re-uploading the full arrays (which grows
  // quadratically with project size). CAS (expectedVersion) and lock-lease
  // enforcement live in the UPDATE's WHERE clause, exactly like updateProject.
  async appendCrawlProgress(
    id: number,
    delta: {
      queue: string[];
      crawlDepths: Record<string, number>;
      processedAppend: string[];
      resultsAppend: any[];
      errorsAppend: any[];
      stats: any;
      scrapeLock: { owner: string; expiresAt: number };
    },
    guard: { expectedVersion: number; enforceLockOwner: string },
  ): Promise<{ version: number } | undefined> {
    const now = Date.now();
    const processedJson = JSON.stringify(delta.processedAppend);
    return await db.transaction(async (tx) => {
      // Guarded UPDATE of the small per-project fields. New results are NOT
      // appended to the monolithic jsonb anymore — they become individual rows
      // below, so postgres never rewrites a multi-MB TOAST value per batch.
      // The processed append is deduped in SQL against the stored array and
      // within the batch itself (retried/replayed deltas must be idempotent);
      // results dedup is handled by the unique (project_id, loc) index.
      const result = await tx.execute(sql`
        UPDATE projects SET
          queue = ${JSON.stringify(delta.queue)}::jsonb,
          crawl_depths = ${JSON.stringify(delta.crawlDepths)}::jsonb,
          processed = COALESCE(processed, '[]'::jsonb) || (
            SELECT COALESCE(jsonb_agg(t.e ORDER BY t.ord), '[]'::jsonb)
            FROM jsonb_array_elements(${processedJson}::jsonb) WITH ORDINALITY AS t(e, ord)
            WHERE NOT COALESCE(projects.processed, '[]'::jsonb) @> jsonb_build_array(t.e)
              AND t.ord = (
                SELECT min(t2.ord)
                FROM jsonb_array_elements(${processedJson}::jsonb) WITH ORDINALITY AS t2(e, ord)
                WHERE t2.e = t.e
              )
          ),
          errors = COALESCE(errors, '[]'::jsonb) || ${JSON.stringify(delta.errorsAppend)}::jsonb,
          stats = ${JSON.stringify(delta.stats)}::jsonb,
          scrape_lock = ${JSON.stringify(delta.scrapeLock)}::jsonb,
          last_scraped = NOW(),
          version = version + 1
        WHERE id = ${id}
          AND version = ${guard.expectedVersion}
          AND (
            scrape_lock IS NULL
            OR jsonb_typeof(scrape_lock) = 'null'
            OR COALESCE((scrape_lock->>'expiresAt')::bigint, 0) <= ${now}
            OR scrape_lock->>'owner' = ${guard.enforceLockOwner}
          )
        RETURNING version
      `);
      if (result.rows.length === 0) return undefined;
      const version = parseInt((result.rows[0] as any).version);

      // Append-only inserts; the unique (project_id, loc) index dedups
      // against existing rows and concurrent writers.
      if (delta.resultsAppend.length > 0) {
        await this.insertResultRows(tx, id, delta.resultsAppend);
      }

      // totalUrls is computed authoritatively from the row count, so
      // client-side stat drift can never accumulate.
      await tx.execute(sql`
        UPDATE projects SET stats = jsonb_set(
          COALESCE(stats, '{}'::jsonb),
          '{totalUrls}',
          to_jsonb((SELECT count(*) FROM project_results WHERE project_id = ${id}))
        )
        WHERE id = ${id}
      `);

      return { version };
    });
  }

  async deleteProject(id: number): Promise<void> {
    await db.transaction(async (tx) => {
      await tx.delete(projectResults).where(eq(projectResults.projectId, id));
      await tx.delete(projects).where(eq(projects.id, id));
    });
  }

  // Lightweight summary counts for a project's results, computed entirely in
  // SQL so the client never has to download the full results array just to
  // render the stat cards. Mirrors the per-row classification used elsewhere
  // (getProjectsLite, getProjectLite) so numbers stay consistent.
  async getProjectResultsSummary(projectId: number): Promise<{
    urlCount: number; scrapedCount: number; failedCount: number; pendingCount: number; attachmentCount: number;
    folders: Array<[string, number]>;
  }> {
    const [countsResult, foldersResult] = await Promise.all([
      db.execute(sql`
        SELECT
          count(*) as url_count,
          count(*) FILTER (
            WHERE (pr.entry->>'hasScrapedData')::boolean = true
               OR (pr.entry->'scrapedData' IS NOT NULL AND jsonb_typeof(pr.entry->'scrapedData') = 'object')
          ) as scraped_count,
          count(*) FILTER (
            WHERE pr.entry->>'status' = 'failed'
               OR pr.entry->>'errorStatus' IS NOT NULL
               OR (pr.entry->>'errorMessage' IS NOT NULL
                   AND (pr.entry->>'hasScrapedData')::boolean IS NOT TRUE
                   AND (pr.entry->'scrapedData' IS NULL OR jsonb_typeof(pr.entry->'scrapedData') != 'object'))
          ) as failed_count
        FROM project_results pr
        WHERE pr.project_id = ${projectId}
      `),
      // Top-level path segment counts (mirrors the client's previous
      // `new URL(loc).pathname` folder grouping), computed in SQL so it
      // covers the whole dataset instead of whatever page is loaded.
      db.execute(sql`
        SELECT first_segment, count(*) as cnt FROM (
          SELECT CASE
            WHEN split_part(regexp_replace(pr.loc, '^[a-zA-Z][a-zA-Z0-9+.-]*://[^/]*', ''), '/', 2) = ''
            THEN '/'
            ELSE '/' || split_part(regexp_replace(pr.loc, '^[a-zA-Z][a-zA-Z0-9+.-]*://[^/]*', ''), '/', 2) || '/'
          END as first_segment
          FROM project_results pr
          WHERE pr.project_id = ${projectId}
        ) t
        GROUP BY first_segment
        ORDER BY cnt DESC
        LIMIT 12
      `),
    ]);
    const row = (countsResult.rows[0] || {}) as any;
    const urlCount = parseInt(row.url_count) || 0;
    const scrapedCount = parseInt(row.scraped_count) || 0;
    const failedCount = parseInt(row.failed_count) || 0;
    return {
      urlCount,
      scrapedCount,
      failedCount,
      pendingCount: Math.max(0, urlCount - scrapedCount - failedCount),
      // PDF attachment count comes from the filesystem (fileStorage), not
      // the jsonb rows — filled in by the route handler.
      attachmentCount: 0,
      folders: foldersResult.rows.map((r: any) => [r.first_segment as string, parseInt(r.cnt) || 0]),
    };
  }

  // Paginated, optionally filtered slice of a project's lite results — used
  // by the results table so opening a huge project never has to transfer or
  // parse the entire result set (which can be tens of MB with image/video
  // arrays included). Filtering runs in SQL so it applies to the whole
  // dataset, not just whatever page happens to be loaded client-side.
  async getProjectResultsPage(
    projectId: number,
    opts: { offset: number; limit: number; search?: string; folder?: string; tab?: 'results' | 'errors' },
  ): Promise<{ results: any[]; total: number }> {
    const { offset, limit, search, folder, tab = 'results' } = opts;
    const searchPattern = search ? `%${search.toLowerCase()}%` : null;
    // Path portion of the URL, stripped of scheme+host, mirrors the
    // client's `new URL(loc).pathname` folder matching.
    const pathExpr = sql`regexp_replace(pr.loc, '^[a-zA-Z][a-zA-Z0-9+.-]*://[^/]*', '')`;
    const folderCondition = folder
      ? (folder === '/'
        ? sql`(${pathExpr} = '' OR ${pathExpr} = '/')`
        : sql`${pathExpr} LIKE ${folder + '%'}`)
      : sql`TRUE`;
    const searchCondition = searchPattern ? sql`lower(pr.loc) LIKE ${searchPattern}` : sql`TRUE`;
    const tabCondition = tab === 'errors'
      ? sql`(pr.entry->>'errorStatus' IS NOT NULL OR pr.entry->>'status' = 'failed')`
      : sql`TRUE`;
    const whereClause = sql`pr.project_id = ${projectId} AND ${folderCondition} AND ${searchCondition} AND ${tabCondition}`;

    const [countResult, rowsResult] = await Promise.all([
      db.execute(sql`SELECT count(*) as total FROM project_results pr WHERE ${whereClause}`),
      db.execute(sql`
        SELECT
          pr.entry->>'loc' as loc,
          pr.entry->>'lastmod' as lastmod,
          pr.entry->>'changefreq' as changefreq,
          pr.entry->>'priority' as priority,
          COALESCE((pr.entry->>'hasScrapedData')::boolean, pr.entry->'scrapedData' IS NOT NULL AND jsonb_typeof(pr.entry->'scrapedData') = 'object') as "hasScrapedData",
          COALESCE(pr.entry->>'status', CASE WHEN (pr.entry->>'hasScrapedData')::boolean = true THEN 'scraped' WHEN pr.entry->>'errorMessage' IS NOT NULL THEN 'failed' ELSE 'pending' END) as status,
          pr.entry->>'errorStatus' as "errorStatus",
          pr.entry->>'errorMessage' as "errorMessage",
          COALESCE((pr.entry->>'removedFromSource')::boolean, false) as "removedFromSource",
          jsonb_array_length(COALESCE(pr.entry->'images', '[]'::jsonb)) as "imageCount",
          jsonb_array_length(COALESCE(pr.entry->'videos', '[]'::jsonb)) as "videoCount"
        FROM project_results pr
        WHERE ${whereClause}
        ORDER BY pr.id
        OFFSET ${offset} LIMIT ${limit}
      `),
    ]);
    return {
      total: parseInt((countResult.rows[0] as any)?.total) || 0,
      results: rowsResult.rows as any[],
    };
  }

  // Get scraped data for a single URL in a project (lazy loading for content preview)
  async getProjectUrlScrapedData(projectId: number, urlLoc: string): Promise<any | null> {
    const [row] = await db.select({ entry: projectResults.entry })
      .from(projectResults)
      .where(and(eq(projectResults.projectId, projectId), eq(projectResults.loc, urlLoc)))
      .limit(1);
    return row ? row.entry : null;
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

  // ---- Normalized results helpers -------------------------------------

  // Load a project's full results array from the normalized table (insertion order).
  private async loadResults(dbOrTx: any, projectId: number): Promise<any[]> {
    const rows = await dbOrTx.select({ entry: projectResults.entry })
      .from(projectResults)
      .where(eq(projectResults.projectId, projectId))
      .orderBy(asc(projectResults.id));
    return rows.map((r: any) => r.entry);
  }

  // Insert result entries as rows. Dedup within the given array (last wins)
  // and against existing rows via ON CONFLICT DO NOTHING.
  private async insertResultRows(dbOrTx: any, projectId: number, entries: any[]): Promise<void> {
    const byLoc = new Map<string, any>();
    for (const e of entries) {
      if (e && typeof e.loc === 'string' && e.loc.length > 0) byLoc.set(e.loc, e);
    }
    const deduped = Array.from(byLoc.values());
    for (let i = 0; i < deduped.length; i += RESULT_INSERT_BATCH) {
      const batch = deduped.slice(i, i + RESULT_INSERT_BATCH);
      await dbOrTx.insert(projectResults)
        .values(batch.map(e => ({ projectId, loc: e.loc, entry: e })))
        .onConflictDoNothing({ target: [projectResults.projectId, projectResults.loc] });
    }
  }

  // Replace all result rows of a project (used by wholesale writes like
  // PUT /api/projects/:id and update-diff merges).
  private async replaceResultRows(dbOrTx: any, projectId: number, entries: any[]): Promise<void> {
    await dbOrTx.delete(projectResults).where(eq(projectResults.projectId, projectId));
    await this.insertResultRows(dbOrTx, projectId, entries);
  }

  // One-time migration: move any legacy monolithic projects.results jsonb
  // arrays into the normalized project_results table, then blank the column.
  // Idempotent and safe to run on every startup.
  async migrateLegacyResults(): Promise<number> {
    const legacy = await db.execute(sql`
      SELECT id FROM projects
      WHERE jsonb_array_length(COALESCE(results, '[]'::jsonb)) > 0
    `);
    let migrated = 0;
    for (const row of legacy.rows as any[]) {
      const id = row.id;
      await db.transaction(async (tx) => {
        // Preserve original array order; keep the first occurrence per loc.
        await tx.execute(sql`
          INSERT INTO project_results (project_id, loc, entry)
          SELECT ${id}, s.loc, s.r
          FROM (
            SELECT DISTINCT ON (t.r->>'loc') t.r->>'loc' AS loc, t.r AS r, t.ord AS ord
            FROM projects p,
                 jsonb_array_elements(p.results) WITH ORDINALITY AS t(r, ord)
            WHERE p.id = ${id} AND t.r->>'loc' IS NOT NULL
            ORDER BY t.r->>'loc', t.ord
          ) s
          ORDER BY s.ord
          ON CONFLICT (project_id, loc) DO NOTHING
        `);
        await tx.execute(sql`UPDATE projects SET results = '[]'::jsonb WHERE id = ${id}`);
      });
      migrated++;
      console.log(`[ResultsMigration] Project ${id}: legacy results moved to project_results`);
    }
    return migrated;
  }
}

export const storage = new DatabaseStorage();
