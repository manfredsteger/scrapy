// API-level regression tests for the concurrent-write guards on
// PUT /api/projects/:id (version CAS + scrape lock).
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
      domain: `test-concurrency-${Date.now()}-${Math.floor(Math.random() * 1e6)}.example`,
      status: "scraping",
      queue: ["https://a.example/", "https://b.example/"],
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

describe("PUT /api/projects/:id concurrency guards", () => {
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

  it("lets the owner write progress and take the lease", async () => {
    const res = await put(project.id, {
      queue: ["https://b.example/"],
      processed: ["https://a.example/"],
      lockOwner: "tab1",
    });
    expect(res.status).toBe(200);
    expect(res.body.scrapeLock?.owner).toBe("tab1");
    expect(res.body.queue).toEqual(["https://b.example/"]);
  });

  it("rejects progress writes from a foreign owner with 409 locked", async () => {
    // tab1 takes the lease
    await put(project.id, { queue: ["https://b.example/"], processed: ["https://a.example/"], lockOwner: "tab1" });

    // tab2 tries to write (stale) progress
    const res = await put(project.id, { queue: [], processed: ["https://a.example/", "https://b.example/"], lockOwner: "tab2" });
    expect(res.status).toBe(409);
    expect(res.body.reason).toBe("locked");

    // owner's progress must be untouched
    const fresh = await storage.getProject(project.id);
    expect(fresh?.queue).toEqual(["https://b.example/"]);
  });

  it("rejects a stale expectedVersion with 409 version_conflict", async () => {
    const first = await put(project.id, { queue: ["https://b.example/"], lockOwner: "tab1" });
    expect(first.status).toBe(200);

    // Version has advanced past the original value; a CAS with the old version must fail.
    const res = await put(project.id, {
      queue: ["stale-overwrite"],
      lockOwner: "tab1",
      expectedVersion: project.version, // stale
    });
    expect(res.status).toBe(409);
    expect(res.body.reason).toBe("version_conflict");
    expect(typeof res.body.version).toBe("number");

    const fresh = await storage.getProject(project.id);
    expect(fresh?.queue).toEqual(["https://b.example/"]);
  });

  it("accepts a correct expectedVersion", async () => {
    const first = await put(project.id, { queue: ["https://b.example/"], lockOwner: "tab1" });
    const res = await put(project.id, {
      queue: [],
      processed: ["https://a.example/", "https://b.example/"],
      lockOwner: "tab1",
      expectedVersion: first.body.version,
    });
    expect(res.status).toBe(200);
    expect(res.body.version).toBe(first.body.version + 1);
  });

  it("allows a foreign tab to stop/pause, but strips its stale progress payload", async () => {
    // Owner advances progress under the lease
    await put(project.id, { queue: ["https://b.example/"], processed: ["https://a.example/"], lockOwner: "tab1" });

    // Foreign tab stops with a stale, empty queue payload
    const res = await put(project.id, { status: "idle", queue: [], lockOwner: "tab2" });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("idle");
    // Owner's progress must survive
    expect(res.body.queue).toEqual(["https://b.example/"]);
    expect(res.body.processed).toEqual(["https://a.example/"]);
    // Non-active status releases the lock
    expect(res.body.scrapeLock ?? null).toBeNull();
  });

  it("releases the lock when the owner transitions to a non-active status", async () => {
    await put(project.id, { queue: ["https://b.example/"], processed: ["https://a.example/"], lockOwner: "tab1" });

    const paused = await put(project.id, { status: "paused", lockOwner: "tab1" });
    expect(paused.status).toBe(200);
    expect(paused.body.scrapeLock ?? null).toBeNull();

    // With the lock released, another owner may now write progress
    const res = await put(project.id, { status: "scraping", queue: ["https://b.example/"], lockOwner: "tab2" });
    expect(res.status).toBe(200);
    expect(res.body.scrapeLock?.owner).toBe("tab2");
  });

  it("does not let an unrelated write (rename) steal or clear the lease", async () => {
    await put(project.id, { queue: ["https://b.example/"], lockOwner: "tab1" });

    const res = await put(project.id, { displayName: "renamed", lockOwner: "tab2" });
    expect(res.status).toBe(200);
    expect(res.body.displayName).toBe("renamed");
    expect(res.body.scrapeLock?.owner).toBe("tab1");
  });

  it("lets the same owner keep writing progress while holding the lease", async () => {
    await put(project.id, { queue: ["https://b.example/"], processed: ["https://a.example/"], lockOwner: "tab1" });
    const res = await put(project.id, { queue: [], processed: ["https://a.example/", "https://b.example/"], lockOwner: "tab1" });
    expect(res.status).toBe(200);
    expect(res.body.processed).toHaveLength(2);
  });

  it("allows foreign progress writes once the lease has expired", async () => {
    // Manually install an already-expired lock held by tab1
    await storage.updateProject(project.id, {
      scrapeLock: { owner: "tab1", expiresAt: Date.now() - 1000 },
    });

    const res = await put(project.id, { queue: ["https://b.example/"], processed: ["https://a.example/"], lockOwner: "tab2" });
    expect(res.status).toBe(200);
    expect(res.body.scrapeLock?.owner).toBe("tab2");
  });
});
