// Integration tests: POST /api/projects/:id/crawl-progress writes delta
// progress atomically (expectedVersion CAS + lock-lease guard) so that
// concurrent tabs / take-lock can never silently overwrite each other.
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
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
    try { await storage.deleteProject(id); } catch {}
  }
  httpServer.close();
  await pool.end();
});

async function createProject(overrides: Record<string, any> = {}) {
  const res = await request(app)
    .post("/api/projects")
    .send({
      domain: `crawl-progress-${Date.now()}-${Math.floor(Math.random() * 1e6)}.example`,
      status: "content_scraping",
      queue: ["https://a.example/"],
      processed: [],
      results: [],
      errors: [],
      ...overrides,
    });
  expect(res.status).toBe(201);
  createdProjectIds.push(res.body.id);
  return res.body;
}

function progressBody(overrides: Record<string, any> = {}) {
  return {
    lockOwner: "tab-1",
    expectedVersion: 0,
    queue: ["https://a.example/next"],
    crawlDepths: { "https://a.example/next": 1 },
    processedAppend: ["https://a.example/"],
    resultsAppend: [
      { loc: "https://a.example/", images: [], videos: [] },
    ],
    errorsAppend: [],
    stats: { totalUrls: 999, totalImages: 0, totalVideos: 0 },
    ...overrides,
  };
}

describe("POST /api/projects/:id/crawl-progress", () => {
  let project: any;

  beforeEach(async () => {
    project = await createProject();
  });

  it("appends the delta and returns the incremented version", async () => {
    const res = await request(app)
      .post(`/api/projects/${project.id}/crawl-progress`)
      .send(progressBody({ expectedVersion: project.version }));

    expect(res.status).toBe(200);
    expect(res.body.version).toBe(project.version + 1);

    const stored = await storage.getProject(project.id);
    expect(stored!.queue).toEqual(["https://a.example/next"]);
    expect(stored!.processed).toEqual(["https://a.example/"]);
    expect((stored!.results as any[]).map((r) => r.loc)).toEqual([
      "https://a.example/",
    ]);
    expect(stored!.scrapeLock?.owner).toBe("tab-1");
  });

  it("returns 409 on a version conflict (stale expectedVersion)", async () => {
    // First write succeeds and bumps the version.
    const first = await request(app)
      .post(`/api/projects/${project.id}/crawl-progress`)
      .send(progressBody({ expectedVersion: project.version }));
    expect(first.status).toBe(200);

    // Second write reuses the stale version → rejected, nothing appended.
    const second = await request(app)
      .post(`/api/projects/${project.id}/crawl-progress`)
      .send(progressBody({
        expectedVersion: project.version,
        resultsAppend: [{ loc: "https://a.example/dup", images: [], videos: [] }],
      }));
    expect(second.status).toBe(409);
    expect(second.body.reason).toBe("conflict");

    const stored = await storage.getProject(project.id);
    expect((stored!.results as any[]).map((r) => r.loc)).toEqual([
      "https://a.example/",
    ]);
  });

  it("returns 409 when another tab holds an active lock", async () => {
    await storage.updateProject(project.id, {
      scrapeLock: { owner: "other-tab", expiresAt: Date.now() + 60000 },
    });
    const current = await storage.getProject(project.id);

    const res = await request(app)
      .post(`/api/projects/${project.id}/crawl-progress`)
      .send(progressBody({ expectedVersion: current!.version, lockOwner: "tab-1" }));

    expect(res.status).toBe(409);
    expect(res.body.reason).toBe("conflict");

    // The other tab's lock is untouched and nothing was appended.
    const stored = await storage.getProject(project.id);
    expect(stored!.scrapeLock?.owner).toBe("other-tab");
    expect(stored!.results).toEqual([]);
  });

  it("succeeds when the other tab's lock has expired", async () => {
    await storage.updateProject(project.id, {
      scrapeLock: { owner: "other-tab", expiresAt: Date.now() - 1000 },
    });
    const current = await storage.getProject(project.id);

    const res = await request(app)
      .post(`/api/projects/${project.id}/crawl-progress`)
      .send(progressBody({ expectedVersion: current!.version, lockOwner: "tab-1" }));

    expect(res.status).toBe(200);
    const stored = await storage.getProject(project.id);
    expect(stored!.scrapeLock?.owner).toBe("tab-1");
  });

  it("appends sequential deltas without duplicates when versions chain correctly", async () => {
    const first = await request(app)
      .post(`/api/projects/${project.id}/crawl-progress`)
      .send(progressBody({ expectedVersion: project.version }));
    expect(first.status).toBe(200);

    const second = await request(app)
      .post(`/api/projects/${project.id}/crawl-progress`)
      .send(progressBody({
        expectedVersion: first.body.version,
        queue: [],
        processedAppend: ["https://a.example/next"],
        resultsAppend: [{ loc: "https://a.example/next", images: [], videos: [] }],
      }));
    expect(second.status).toBe(200);

    const stored = await storage.getProject(project.id);
    expect((stored!.results as any[]).map((r) => r.loc)).toEqual([
      "https://a.example/",
      "https://a.example/next",
    ]);
    expect(stored!.processed).toEqual([
      "https://a.example/",
      "https://a.example/next",
    ]);
  });

  it("ignores already-persisted and within-batch duplicate entries on a valid retried delta", async () => {
    const first = await request(app)
      .post(`/api/projects/${project.id}/crawl-progress`)
      .send(progressBody({ expectedVersion: project.version }));
    expect(first.status).toBe(200);

    // A later, correctly versioned delta re-sends the already-stored URL
    // (e.g. a replayed batch) plus a new one — and the new one twice.
    const second = await request(app)
      .post(`/api/projects/${project.id}/crawl-progress`)
      .send(progressBody({
        expectedVersion: first.body.version,
        processedAppend: ["https://a.example/", "https://a.example/next", "https://a.example/next"],
        resultsAppend: [
          { loc: "https://a.example/", images: [], videos: [] },
          { loc: "https://a.example/next", images: [], videos: [] },
          { loc: "https://a.example/next", images: [], videos: [] },
        ],
        stats: { totalUrls: 999, totalImages: 0, totalVideos: 0 },
      }));
    expect(second.status).toBe(200);

    const stored = await storage.getProject(project.id);
    expect((stored!.results as any[]).map((r) => r.loc)).toEqual([
      "https://a.example/",
      "https://a.example/next",
    ]);
    expect(stored!.processed).toEqual([
      "https://a.example/",
      "https://a.example/next",
    ]);
    // totalUrls reflects the deduplicated result count.
    expect((stored!.stats as any).totalUrls).toBe(2);
  });

  it("computes totalUrls server-side from the post-append results length", async () => {
    // Client sends a bogus totalUrls (999) — server must ignore it.
    const res = await request(app)
      .post(`/api/projects/${project.id}/crawl-progress`)
      .send(progressBody({
        expectedVersion: project.version,
        resultsAppend: [
          { loc: "https://a.example/1", images: [], videos: [] },
          { loc: "https://a.example/2", images: [], videos: [] },
        ],
        stats: { totalUrls: 999, totalImages: 3, totalVideos: 4 },
      }));
    expect(res.status).toBe(200);

    const stored = await storage.getProject(project.id);
    expect((stored!.stats as any).totalUrls).toBe(2);
    // Other client-provided stats pass through unchanged.
    expect((stored!.stats as any).totalImages).toBe(3);
    expect((stored!.stats as any).totalVideos).toBe(4);
  });

  it("keeps totalUrls consistent after a concurrent take-lock races a progress write", async () => {
    // Seed one result via a normal progress write.
    const first = await request(app)
      .post(`/api/projects/${project.id}/crawl-progress`)
      .send(progressBody({ expectedVersion: project.version }));
    expect(first.status).toBe(200);

    // Fire take-lock (other tab) and a progress write (old tab, stale-prone)
    // in parallel. Whatever the interleaving, the write either lands with a
    // server-computed totalUrls or is rejected with 409 — never a torn state.
    const [takeRes, progressRes] = await Promise.all([
      request(app)
        .post(`/api/projects/${project.id}/take-lock`)
        .send({ lockOwner: "tab-2" }),
      request(app)
        .post(`/api/projects/${project.id}/crawl-progress`)
        .send(progressBody({
          expectedVersion: first.body.version,
          lockOwner: "tab-1",
          resultsAppend: [{ loc: "https://a.example/b", images: [], videos: [] }],
          stats: { totalUrls: 12345, totalImages: 0, totalVideos: 0 },
        })),
    ]);

    expect(takeRes.status).toBe(200);
    expect([200, 409]).toContain(progressRes.status);

    const stored = await storage.getProject(project.id);
    // The takeover must persist: whichever request committed last, the lock
    // belongs to one of the two tabs — and if the progress write was rejected,
    // it must not have clobbered tab-2's freshly taken lock.
    if (progressRes.status === 409) {
      expect(stored!.scrapeLock?.owner).toBe("tab-2");
    } else {
      expect(["tab-1", "tab-2"]).toContain(stored!.scrapeLock?.owner);
    }
    const resultCount = (stored!.results as any[]).length;
    if (progressRes.status === 200) {
      expect(resultCount).toBe(2);
      expect((stored!.stats as any).totalUrls).toBe(2);
    } else {
      // Rejected write appended nothing; stats still match the real count.
      expect(resultCount).toBe(1);
      expect((stored!.stats as any).totalUrls).toBe(1);
    }
  });

  it("returns 404 for a non-existent project", async () => {
    const res = await request(app)
      .post(`/api/projects/999999999/crawl-progress`)
      .send(progressBody());
    expect(res.status).toBe(404);
  });

  it("returns 400 on invalid input", async () => {
    const res = await request(app)
      .post(`/api/projects/${project.id}/crawl-progress`)
      .send({ lockOwner: "tab-1" });
    expect(res.status).toBe(400);
  });
});
