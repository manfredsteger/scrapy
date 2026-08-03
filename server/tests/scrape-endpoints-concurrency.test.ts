// API-level regression tests for the scrape-lock guards on the server-side
// endpoints POST /api/scrape/content and POST /api/projects/:id/start-extraction.
//
// Mirrors the manual script scripts/concurrency-regression.mjs (scenario 3),
// using isolated test projects that are always deleted afterwards.
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

// A URL that shouldSkipUrl() filters out (non-HTML), so the owner-success
// batch never touches the network but still exercises the guarded persist.
const SKIPPED_URL = "https://test-scrape-endpoints.example/doc.pdf";

async function createTestProject(overrides: Record<string, any> = {}) {
  const res = await request(app)
    .post("/api/projects")
    .send({
      domain: `test-scrape-endpoints-${Date.now()}-${Math.floor(Math.random() * 1e6)}.example`,
      status: "content_scraping",
      queue: [SKIPPED_URL],
      processed: [],
      results: [{ loc: SKIPPED_URL, images: [], videos: [] }],
      errors: [],
      ...overrides,
    });
  expect(res.status).toBe(201);
  createdProjectIds.push(res.body.id);
  return res.body;
}

function put(id: number, body: Record<string, any>) {
  return request(app).put(`/api/projects/${id}`).send(body);
}

describe("scrape endpoint concurrency guards", () => {
  let project: any;

  beforeEach(async () => {
    project = await createTestProject();
    // tab1 takes the lease via a normal progress write
    const res = await put(project.id, { queue: [SKIPPED_URL], lockOwner: "tab1" });
    expect(res.status).toBe(200);
    expect(res.body.scrapeLock?.owner).toBe("tab1");
  });

  afterEach(async () => {
    const idx = createdProjectIds.indexOf(project.id);
    if (idx !== -1) createdProjectIds.splice(idx, 1);
    try {
      await storage.deleteProject(project.id);
    } catch {}
  });

  describe("POST /api/scrape/content", () => {
    it("rejects a content batch from a foreign owner with 409 locked", async () => {
      const res = await request(app)
        .post("/api/scrape/content")
        .send({ urls: [SKIPPED_URL], projectId: project.id, lockOwner: "tab2" });
      expect(res.status).toBe(409);
      expect(res.body.reason).toBe("locked");

      // Project state must be untouched
      const fresh = await storage.getProject(project.id);
      const result = (fresh?.results || []).find((r: any) => r.loc === SKIPPED_URL);
      expect(result?.errorStatus ?? null).toBeNull();
    });

    it("lets the lock owner run a content batch and returns the saved version", async () => {
      const res = await request(app)
        .post("/api/scrape/content")
        .send({ urls: [SKIPPED_URL], projectId: project.id, lockOwner: "tab1" });
      expect(res.status).toBe(200);
      expect(typeof res.body.version).toBe("number");

      // The batch's result update was persisted (URL skipped as non-HTML)
      const fresh = await storage.getProject(project.id);
      const result = (fresh?.results || []).find((r: any) => r.loc === SKIPPED_URL);
      expect(result?.errorStatus).toBe("skipped");
      // The lease was renewed for the owner
      expect((fresh as any)?.scrapeLock?.owner).toBe("tab1");

      // A follow-up CAS write from the owner with the returned version succeeds
      const followUp = await put(project.id, {
        queue: [],
        lockOwner: "tab1",
        expectedVersion: res.body.version,
      });
      expect(followUp.status).toBe(200);
    });

    it("allows a foreign batch once the lease has expired", async () => {
      await storage.updateProject(project.id, {
        scrapeLock: { owner: "tab1", expiresAt: Date.now() - 1000 },
      });
      const res = await request(app)
        .post("/api/scrape/content")
        .send({ urls: [SKIPPED_URL], projectId: project.id, lockOwner: "tab2" });
      expect(res.status).toBe(200);
      expect(typeof res.body.version).toBe("number");
    });
  });

  describe("POST /api/projects/:id/start-extraction", () => {
    it("rejects start-extraction from a foreign owner with 409 locked", async () => {
      const res = await request(app)
        .post(`/api/projects/${project.id}/start-extraction`)
        .send({ lockOwner: "tab2" });
      expect(res.status).toBe(409);
      expect(res.body.reason).toBe("locked");

      // The active owner's queue must survive
      const fresh = await storage.getProject(project.id);
      expect(fresh?.queue).toEqual([SKIPPED_URL]);
      expect((fresh as any)?.scrapeLock?.owner).toBe("tab1");
    });

    it("lets the lock owner start extraction and take a fresh lease", async () => {
      const res = await request(app)
        .post(`/api/projects/${project.id}/start-extraction`)
        .send({ lockOwner: "tab1" });
      expect(res.status).toBe(200);
      expect(res.body.status).toBe("content_scraping");
      expect(res.body.queue).toEqual([SKIPPED_URL]);
      expect(res.body.errors).toEqual([]);
      expect(res.body.scrapeLock?.owner).toBe("tab1");
    });

    it("allows a foreign start-extraction once the lease has expired", async () => {
      await storage.updateProject(project.id, {
        scrapeLock: { owner: "tab1", expiresAt: Date.now() - 1000 },
      });
      const res = await request(app)
        .post(`/api/projects/${project.id}/start-extraction`)
        .send({ lockOwner: "tab2" });
      expect(res.status).toBe(200);
      expect(res.body.scrapeLock?.owner).toBe("tab2");
    });
  });
});
