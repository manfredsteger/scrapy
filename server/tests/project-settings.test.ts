// Integration tests: projectSettings are accepted and persisted via
// PUT /api/projects/:id, so that in-flight scraping loops can save a
// parallelRequests rollback and pick it up on the next batch.
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
      domain: `test-settings-${Date.now()}-${Math.floor(Math.random() * 1e6)}.example`,
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

function put(id: number, body: Record<string, any>) {
  return request(app).put(`/api/projects/${id}`).send(body);
}

describe("PUT /api/projects/:id — projectSettings persistence", () => {
  let project: any;

  beforeEach(async () => {
    project = await createProject();
  });

  it("accepts and persists projectSettings.scraping.parallelRequests", async () => {
    const res = await put(project.id, {
      projectSettings: {
        scraping: { parallelRequests: 3, delayMs: 500 },
      },
    });
    expect(res.status).toBe(200);
    expect(res.body.projectSettings?.scraping?.parallelRequests).toBe(3);
    expect(res.body.projectSettings?.scraping?.delayMs).toBe(500);
  });

  it("persists a parallelRequests rollback without overwriting existing settings", async () => {
    // First write: full settings object (simulates user saving settings dialog)
    await put(project.id, {
      projectSettings: {
        scraping: { parallelRequests: 20, delayMs: 1000, maxDepth: 5 },
      },
    });

    // Rollback: reduce parallelRequests (simulates rate-limit auto-rollback)
    const rollback = await put(project.id, {
      projectSettings: {
        scraping: { parallelRequests: 10, delayMs: 1000, maxDepth: 5 },
      },
    });
    expect(rollback.status).toBe(200);
    expect(rollback.body.projectSettings?.scraping?.parallelRequests).toBe(10);
    // Other settings must not be lost
    expect(rollback.body.projectSettings?.scraping?.delayMs).toBe(1000);
    expect(rollback.body.projectSettings?.scraping?.maxDepth).toBe(5);
  });

  it("can update projectSettings alongside progress fields in the same write", async () => {
    const res = await put(project.id, {
      queue: [],
      stats: {
        totalSitemaps: 1, processedSitemaps: 1,
        totalUrls: 1, totalImages: 0, totalVideos: 0,
        startTime: Date.now(), endTime: Date.now(), scrapedPages: 1,
      },
      projectSettings: { scraping: { parallelRequests: 5 } },
      lockOwner: "tab1",
    });
    expect(res.status).toBe(200);
    expect(res.body.queue).toHaveLength(0);
    expect(res.body.projectSettings?.scraping?.parallelRequests).toBe(5);
  });

  it("version increments after a projectSettings-only write", async () => {
    const before = project.version ?? 0;
    const res = await put(project.id, {
      projectSettings: { scraping: { parallelRequests: 7 } },
    });
    expect(res.status).toBe(200);
    expect(res.body.version).toBeGreaterThan(before);
  });
});
