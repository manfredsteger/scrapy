// Regression test: GET /api/projects/:id/export must return each result's
// real scrapedData (title, wordCount, etc.), unlike the lite project-detail
// endpoint which intentionally strips it for transfer-size reasons. This
// guards against re-pointing the export UI at a lite/summary endpoint that
// silently produces blank exports.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
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

describe("GET /api/projects/:id/export", () => {
  it("includes full scrapedData for each result, not just lite fields", async () => {
    const created = await request(app)
      .post("/api/projects")
      .send({
        domain: `test-export-${Date.now()}-${Math.floor(Math.random() * 1e6)}.example`,
        status: "idle",
        queue: [],
        processed: [],
        errors: [],
        results: [
          {
            loc: "https://test-export.example/page-1",
            images: [],
            videos: [],
            hasScrapedData: true,
            status: "scraped",
            scrapedData: {
              title: "Known Page Title",
              orderedElements: [],
              timestamp: new Date().toISOString(),
              wordCount: 1234,
            },
          },
        ],
      });
    expect(created.status).toBe(201);
    const projectId = created.body.id;
    createdProjectIds.push(projectId);

    // Sanity check: the lite project-detail endpoint (used for normal page
    // loads) must NOT carry scrapedData - that's the whole point of #39.
    const lite = await request(app).get(`/api/projects/${projectId}?full=true`);
    expect(lite.status).toBe(200);
    expect(lite.body.results?.[0]?.scrapedData).toBeUndefined();

    // The dedicated export endpoint must carry the real scrapedData.
    const exported = await request(app).get(`/api/projects/${projectId}/export`);
    expect(exported.status).toBe(200);
    expect(exported.body.results).toHaveLength(1);
    expect(exported.body.results[0].scrapedData?.title).toBe("Known Page Title");
    expect(exported.body.results[0].scrapedData?.wordCount).toBe(1234);
  });
});
