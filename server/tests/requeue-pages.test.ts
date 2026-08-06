// Integration tests for the kitanetz.de content-extraction backfill routes:
// GET /api/projects/:id/empty-scraped-pages and POST /api/projects/:id/requeue-pages.
//
// These prove the backfill actually re-fetches and re-persists a page's
// content synchronously (via the same code path as the interactive crawl
// loop) rather than only flipping DB state for a browser tab to pick up.
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from "vitest";
import express from "express";
import { createServer, type Server } from "http";
import request from "supertest";
import { registerRoutes } from "../routes";
import { storage } from "../storage";
import { pool } from "../db";
import * as fileStorage from "../fileStorage";

let app: express.Express;
let httpServer: Server;
const createdProjectIds: number[] = [];

beforeAll(async () => {
  app = express();
  app.use(express.json({ limit: "50mb" }));
  httpServer = createServer(app);
  await registerRoutes(httpServer, app);
});

afterAll(async () => {
  for (const id of createdProjectIds) {
    try { await storage.deleteProject(id); } catch {}
  }
  httpServer.close();
  await pool.end();
});

afterEach(() => {
  vi.restoreAllMocks();
});

const DETAIL_URL = "https://requeue-test.example/bayern/80333/some-kita.php";

function mockResponse(status: number, body: string): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (_: string) => null } as any,
    text: async () => body,
  } as unknown as Response;
}

async function createProject(overrides: Record<string, any> = {}) {
  const res = await request(app)
    .post("/api/projects")
    .send({
      domain: `test-requeue-${Date.now()}-${Math.floor(Math.random() * 1e6)}.example`,
      status: "idle",
      queue: [],
      processed: [DETAIL_URL],
      results: [{ loc: DETAIL_URL, hasScrapedData: true, status: "scraped", images: [], videos: [] }],
      errors: [],
      ...overrides,
    });
  expect(res.status).toBe(201);
  createdProjectIds.push(res.body.id);
  return res.body;
}

describe("POST /api/projects/:id/requeue-pages", () => {
  let project: any;

  afterEach(async () => {
    const idx = createdProjectIds.indexOf(project?.id);
    if (idx !== -1) createdProjectIds.splice(idx, 1);
    try { await storage.deleteProject(project.id); } catch {}
  });

  it("re-fetches and re-persists a page's content, replacing the old (stale) extraction on disk", async () => {
    project = await createProject();

    // Seed stale on-disk content, as if it were extracted before a bug fix.
    const pageDir = fileStorage.getProjectPageDir(project.id, project.domain, DETAIL_URL);
    await fileStorage.savePageContent(pageDir, "old stale content");
    await fileStorage.savePageMeta(pageDir, { url: DETAIL_URL, wordCount: 2, timestamp: new Date().toISOString() });

    const freshHtml = `<html><body><main><h1>Some Kita</h1><p>Recovered real content after the fix.</p></main></body></html>`;
    vi.spyOn(global, "fetch").mockResolvedValue(mockResponse(200, freshHtml));

    const res = await request(app)
      .post(`/api/projects/${project.id}/requeue-pages`)
      .send({ urls: [DETAIL_URL], lockOwner: "backfill-test" });

    expect(res.status).toBe(200);
    expect(res.body.requestedCount).toBe(1);
    expect(res.body.succeededCount).toBe(1);

    // The page's content on disk was actually replaced by the re-scrape.
    const newContent = await fileStorage.readPageContent(pageDir);
    expect(newContent).toContain("Recovered real content after the fix.");
    expect(newContent).not.toContain("old stale content");

    const newMeta = await fileStorage.readPageMeta(pageDir);
    expect(newMeta?.wordCount).toBeGreaterThan(2);

    // The project's result row and lock are left in a clean, usable state.
    const fresh = await storage.getProject(project.id);
    const result = (fresh?.results || []).find((r: any) => r.loc === DETAIL_URL);
    expect(result?.hasScrapedData).toBe(true);
    expect(result?.status).toBe("scraped");
    expect((fresh as any)?.scrapeLock).toBeNull();
  });

  it("rejects a batch larger than the per-call cap", async () => {
    project = await createProject();
    const manyUrls = Array.from({ length: 30 }, (_, i) => `${DETAIL_URL}?n=${i}`);
    const res = await request(app)
      .post(`/api/projects/${project.id}/requeue-pages`)
      .send({ urls: manyUrls, lockOwner: "backfill-test" });
    expect(res.status).toBe(400);
  });

  it("refuses to run while another session actively holds the scrape lock", async () => {
    project = await createProject();
    await storage.updateProject(project.id, {
      scrapeLock: { owner: "other-tab", expiresAt: Date.now() + 60000 },
    });

    const res = await request(app)
      .post(`/api/projects/${project.id}/requeue-pages`)
      .send({ urls: [DETAIL_URL], lockOwner: "backfill-test" });
    expect(res.status).toBe(409);
    expect(res.body.reason).toBe("locked");
  });
});

describe("GET /api/projects/:id/empty-scraped-pages", () => {
  let project: any;

  afterEach(async () => {
    const idx = createdProjectIds.indexOf(project?.id);
    if (idx !== -1) createdProjectIds.splice(idx, 1);
    try { await storage.deleteProject(project.id); } catch {}
  });

  it("paginates candidates and bounds filesystem reads per call", async () => {
    const urls = Array.from({ length: 5 }, (_, i) => `${DETAIL_URL}?p=${i}`);
    project = await createProject({
      results: urls.map(u => ({ loc: u, hasScrapedData: true, status: "scraped", images: [], videos: [] })),
    });
    for (const u of urls) {
      const dir = fileStorage.getProjectPageDir(project.id, project.domain, u);
      await fileStorage.savePageMeta(dir, { url: u, wordCount: 1, timestamp: new Date().toISOString() });
    }

    const res1 = await request(app)
      .get(`/api/projects/${project.id}/empty-scraped-pages`)
      .query({ limit: 2 });
    expect(res1.status).toBe(200);
    expect(res1.body.scannedCount).toBe(2);
    expect(res1.body.candidateCount).toBe(5);
    expect(res1.body.done).toBe(false);
    expect(res1.body.nextOffset).toBe(2);

    const res2 = await request(app)
      .get(`/api/projects/${project.id}/empty-scraped-pages`)
      .query({ limit: 2, offset: res1.body.nextOffset });
    expect(res2.status).toBe(200);
    expect(res2.body.scannedCount).toBe(2);
    expect(res2.body.done).toBe(false);
  });

  it("rejects an oversized urlPattern", async () => {
    project = await createProject();
    const res = await request(app)
      .get(`/api/projects/${project.id}/empty-scraped-pages`)
      .query({ urlPattern: "a".repeat(300) });
    expect(res.status).toBe(400);
  });
});
