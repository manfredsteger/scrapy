// Tests for crawl-depth enforcement:
// 1. Pure logic (shared/crawl-depth.ts) used by the client crawl loop.
// 2. API persistence: crawlDepths survives project creation and is returned
//    by the detail endpoint (the crawl loop reads it from there).
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import express from "express";
import { createServer, type Server } from "http";
import request from "supertest";
import { registerRoutes } from "../routes";
import { storage } from "../storage";
import { pool } from "../db";
import { addDiscoveredLinks, type DiscoveredLinkState } from "@shared/crawl-depth";

function makeState(overrides: Partial<DiscoveredLinkState> = {}): DiscoveredLinkState {
  return {
    queue: [],
    depths: {},
    resultCount: 0,
    existingLocs: new Set(),
    existingProcessed: new Set(),
    existingQueue: new Set(),
    ...overrides,
  };
}

describe("addDiscoveredLinks (maxDepth enforcement)", () => {
  it("enqueues links within maxDepth and records their depth", () => {
    const state = makeState({ depths: { "https://a.example/": 0 } });
    addDiscoveredLinks(state, "https://a.example/", ["https://a.example/p1", "https://a.example/p2"], 2, 20000);
    expect(state.queue).toEqual(["https://a.example/p1", "https://a.example/p2"]);
    expect(state.depths["https://a.example/p1"]).toBe(1);
  });

  it("drops links beyond maxDepth (fresh crawl with maxDepth 1)", () => {
    // Seed page at depth 0 -> its links are depth 1 (allowed at maxDepth 1)
    const state = makeState({ depths: { "https://a.example/": 0 } });
    addDiscoveredLinks(state, "https://a.example/", ["https://a.example/l1"], 1, 20000);
    expect(state.queue).toEqual(["https://a.example/l1"]);

    // Depth-1 page's links would be depth 2 -> rejected
    addDiscoveredLinks(state, "https://a.example/l1", ["https://a.example/l2"], 1, 20000);
    expect(state.queue).toEqual(["https://a.example/l1"]);
    expect(state.depths["https://a.example/l2"]).toBeUndefined();
  });

  it("enforces maxDepth 2 across three levels", () => {
    const state = makeState({ depths: { "https://a.example/": 0 } });
    addDiscoveredLinks(state, "https://a.example/", ["https://a.example/d1"], 2, 20000);
    addDiscoveredLinks(state, "https://a.example/d1", ["https://a.example/d2"], 2, 20000);
    addDiscoveredLinks(state, "https://a.example/d2", ["https://a.example/d3"], 2, 20000);
    expect(state.queue).toEqual(["https://a.example/d1", "https://a.example/d2"]);
  });

  it("treats URLs without a recorded depth as depth 0 (legacy projects)", () => {
    const state = makeState(); // no depths at all
    addDiscoveredLinks(state, "https://legacy.example/", ["https://legacy.example/p"], 5, 20000);
    expect(state.queue).toEqual(["https://legacy.example/p"]);
    expect(state.depths["https://legacy.example/p"]).toBe(1);
  });

  it("keeps the global URL cap as a second bound", () => {
    const state = makeState({ resultCount: 1, queue: ["https://a.example/q"], existingQueue: new Set(["https://a.example/q"]) });
    addDiscoveredLinks(state, "https://a.example/", ["https://a.example/x", "https://a.example/y"], 5, 3);
    expect(state.queue).toEqual(["https://a.example/q", "https://a.example/x"]);
  });

  it("does not re-enqueue known URLs", () => {
    const state = makeState({
      existingLocs: new Set(["https://a.example/seen"]),
      existingProcessed: new Set(["https://a.example/done"]),
    });
    addDiscoveredLinks(state, "https://a.example/", ["https://a.example/seen", "https://a.example/done", "https://a.example/new"], 5, 20000);
    expect(state.queue).toEqual(["https://a.example/new"]);
  });
});

describe("crawlDepths persistence via API", () => {
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

  it("persists crawlDepths on create and returns it from the detail endpoint", async () => {
    const seed = "https://depth-test.example";
    const createRes = await request(app)
      .post("/api/projects")
      .send({
        domain: `test-crawl-depth-${Date.now()}-${Math.floor(Math.random() * 1e6)}.example`,
        status: "crawling",
        queue: [seed],
        crawlDepths: { [seed]: 0 },
        processed: [],
        results: [],
        errors: [],
      });
    expect(createRes.status).toBe(201);
    createdProjectIds.push(createRes.body.id);
    expect(createRes.body.crawlDepths).toEqual({ [seed]: 0 });

    // The crawl loop fetches the detail endpoint - depth map must be there
    const detailRes = await request(app).get(`/api/projects/${createRes.body.id}`);
    expect(detailRes.status).toBe(200);
    expect(detailRes.body.crawlDepths).toEqual({ [seed]: 0 });

    // Progress write (as the crawl loop does after a batch, resync uses the same path)
    const putRes = await request(app)
      .put(`/api/projects/${createRes.body.id}`)
      .send({
        queue: [`${seed}/p1`],
        crawlDepths: { [`${seed}/p1`]: 1 },
        expectedVersion: detailRes.body.version,
        lockOwner: "test-owner",
      });
    expect(putRes.status).toBe(200);
    expect(putRes.body.crawlDepths).toEqual({ [`${seed}/p1`]: 1 });
  });
});
