// API-level regression tests for the sitemap loop's delta progress writes on
// POST /api/projects/:id/crawl-progress (shared with the crawl loop).
//
// The sitemap loop sends richer entries (lastmod/changefreq/priority may be
// null, images carry captions, videos carry sitemap video metadata) and
// sitemap-specific stats (processedSitemaps/totalSitemaps). These tests pin
// down that the endpoint appends atomically, keeps CAS + lock-lease guards,
// and never strips sitemap metadata.
//
// Runs against the development database using isolated test projects
// (unique domains) that are always deleted afterwards.
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import express from "express";
import { createServer, type Server } from "http";
import request from "supertest";
import { registerRoutes } from "../routes";
import { storage } from "../storage";
import { pool } from "../db";

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
    try {
      await storage.deleteProject(id);
    } catch {}
  }
  httpServer.close();
  await pool.end();
});

async function createTestProject(overrides: Record<string, any> = {}) {
  const res = await request(app)
    .post("/api/projects")
    .send({
      domain: `test-sitemap-progress-${Date.now()}-${Math.floor(Math.random() * 1e6)}.example`,
      status: "scraping",
      queue: ["https://s.example/sitemap.xml", "https://s.example/sitemap2.xml"],
      processed: [],
      results: [],
      errors: [],
      stats: { totalUrls: 0, totalImages: 0, totalVideos: 0, processedSitemaps: 0, totalSitemaps: 2, startTime: Date.now() },
      ...overrides,
    });
  expect(res.status).toBe(201);
  createdProjectIds.push(res.body.id);
  return res.body;
}

function progress(id: number, body: Record<string, any>) {
  return request(app).post(`/api/projects/${id}/crawl-progress`).send(body);
}

function baseDelta(project: any, overrides: Record<string, any> = {}) {
  return {
    lockOwner: "tab1",
    expectedVersion: project.version,
    queue: ["https://s.example/sitemap2.xml"],
    crawlDepths: {},
    processedAppend: ["https://s.example/sitemap.xml"],
    resultsAppend: [
      {
        loc: "https://s.example/page-1",
        lastmod: null, // sitemap entries may carry null metadata
        changefreq: "daily",
        priority: null,
        images: [{ loc: "https://s.example/img.jpg", title: "Bild", caption: "Eine Caption" }],
        videos: [{ title: "Video", contentLoc: "https://s.example/v.mp4", duration: "60" }],
      },
    ],
    errorsAppend: [],
    stats: {
      totalUrls: 1,
      totalImages: 1,
      totalVideos: 1,
      processedSitemaps: 1,
      totalSitemaps: 2,
    },
    ...overrides,
  };
}

describe("POST /api/projects/:id/crawl-progress (sitemap loop deltas)", () => {
  let project: any;

  beforeEach(async () => {
    project = await createTestProject();
  });

  afterEach(async () => {
    const idx = createdProjectIds.indexOf(project.id);
    if (idx !== -1) createdProjectIds.splice(idx, 1);
    try {
      await storage.deleteProject(project.id);
    } catch {}
  });

  it("appends sitemap entries with nullish metadata and preserves image/video fields", async () => {
    const res = await progress(project.id, baseDelta(project));
    expect(res.status).toBe(200);
    expect(res.body.version).toBe(project.version + 1);

    const fresh = await storage.getProject(project.id);
    expect(fresh?.queue).toEqual(["https://s.example/sitemap2.xml"]);
    expect(fresh?.processed).toEqual(["https://s.example/sitemap.xml"]);
    expect(fresh?.results).toHaveLength(1);
    const entry: any = fresh?.results?.[0];
    expect(entry.loc).toBe("https://s.example/page-1");
    expect(entry.images[0].caption).toBe("Eine Caption");
    expect(entry.videos[0].contentLoc).toBe("https://s.example/v.mp4");
    // sitemap-specific stats pass through
    expect((fresh?.stats as any)?.processedSitemaps).toBe(1);
    expect((fresh?.stats as any)?.totalSitemaps).toBe(2);
  });

  it("appends across consecutive batches instead of overwriting", async () => {
    const first = await progress(project.id, baseDelta(project));
    expect(first.status).toBe(200);

    const second = await progress(project.id, baseDelta(project, {
      expectedVersion: first.body.version,
      queue: [],
      processedAppend: ["https://s.example/sitemap2.xml"],
      resultsAppend: [{
        loc: "https://s.example/page-2",
        images: [],
        videos: [],
      }],
      stats: { totalUrls: 2, totalImages: 1, totalVideos: 1, processedSitemaps: 2, totalSitemaps: 2 },
    }));
    expect(second.status).toBe(200);

    const fresh = await storage.getProject(project.id);
    expect(fresh?.processed).toEqual([
      "https://s.example/sitemap.xml",
      "https://s.example/sitemap2.xml",
    ]);
    expect(fresh?.results?.map((r: any) => r.loc)).toEqual([
      "https://s.example/page-1",
      "https://s.example/page-2",
    ]);
    // totalUrls is recomputed server-side from the post-append array length
    expect((fresh?.stats as any)?.totalUrls).toBe(2);
  });

  it("rejects a stale expectedVersion with 409 and leaves progress untouched", async () => {
    const first = await progress(project.id, baseDelta(project));
    expect(first.status).toBe(200);

    const res = await progress(project.id, baseDelta(project)); // stale version
    expect(res.status).toBe(409);

    const fresh = await storage.getProject(project.id);
    expect(fresh?.results).toHaveLength(1);
  });

  it("rejects progress writes from a foreign owner while the lease is held", async () => {
    const first = await progress(project.id, baseDelta(project));
    expect(first.status).toBe(200);

    const res = await progress(project.id, baseDelta(project, {
      lockOwner: "tab2",
      expectedVersion: first.body.version,
    }));
    expect(res.status).toBe(409);

    const fresh = await storage.getProject(project.id);
    expect((fresh?.scrapeLock as any)?.owner).toBe("tab1");
  });

  it("allows a foreign owner to write once the lease has expired", async () => {
    await storage.updateProject(project.id, {
      scrapeLock: { owner: "tab1", expiresAt: Date.now() - 1000 },
    });
    const fresh = await storage.getProject(project.id);

    const res = await progress(project.id, baseDelta(project, {
      lockOwner: "tab2",
      expectedVersion: fresh!.version,
    }));
    expect(res.status).toBe(200);

    const after = await storage.getProject(project.id);
    expect((after?.scrapeLock as any)?.owner).toBe("tab2");
  });

  it("returns 404 for a missing project", async () => {
    const res = await progress(999999999, baseDelta(project));
    expect(res.status).toBe(404);
  });
});
