// Integration tests: POST /api/projects/:id/take-lock lets a browser tab
// unconditionally steal the scrape lock from another tab.
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
      domain: `take-lock-${Date.now()}-${Math.floor(Math.random() * 1e6)}.example`,
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

describe("POST /api/projects/:id/take-lock", () => {
  let project: any;

  beforeEach(async () => {
    project = await createProject();
  });

  it("grants the lock to the requesting tab when no lock is held", async () => {
    const res = await request(app)
      .post(`/api/projects/${project.id}/take-lock`)
      .send({ lockOwner: "new-tab-abc" });

    expect(res.status).toBe(200);
    expect(res.body.scrapeLock?.owner).toBe("new-tab-abc");
    expect(res.body.scrapeLock?.expiresAt).toBeGreaterThan(Date.now());
  });

  it("overwrites an existing active lock from another tab", async () => {
    // Simulate another tab holding the lock
    await storage.updateProject(project.id, {
      scrapeLock: { owner: "old-tab-xyz", expiresAt: Date.now() + 60000 },
    });

    const res = await request(app)
      .post(`/api/projects/${project.id}/take-lock`)
      .send({ lockOwner: "new-tab-abc" });

    expect(res.status).toBe(200);
    expect(res.body.scrapeLock?.owner).toBe("new-tab-abc");
    expect(res.body.scrapeLock?.expiresAt).toBeGreaterThan(Date.now());
  });

  it("returns 400 when lockOwner is missing", async () => {
    const res = await request(app)
      .post(`/api/projects/${project.id}/take-lock`)
      .send({});

    expect(res.status).toBe(400);
  });

  it("returns 409 when the project is not actively scraping", async () => {
    await storage.updateProject(project.id, { status: "idle", scrapeLock: null });

    const res = await request(app)
      .post(`/api/projects/${project.id}/take-lock`)
      .send({ lockOwner: "new-tab-abc" });

    expect(res.status).toBe(409);
  });

  it("returns 404 for a non-existent project", async () => {
    const res = await request(app)
      .post(`/api/projects/999999999/take-lock`)
      .send({ lockOwner: "new-tab-abc" });

    expect(res.status).toBe(404);
  });

  it("sets a 70-second TTL on the new lock", async () => {
    const before = Date.now();
    const res = await request(app)
      .post(`/api/projects/${project.id}/take-lock`)
      .send({ lockOwner: "new-tab-abc" });
    const after = Date.now();

    expect(res.status).toBe(200);
    const expiresAt = res.body.scrapeLock?.expiresAt;
    expect(expiresAt).toBeGreaterThanOrEqual(before + 70000);
    expect(expiresAt).toBeLessThanOrEqual(after + 70000);
  });
});
