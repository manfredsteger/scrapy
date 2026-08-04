// Integration tests: 429 rate-limit detection in POST /api/scrape/content.
//
// Verifies that rateLimitDetected is set in the response when:
//  (a) a URL fetch returns HTTP 429 and the attempt throws (no retry available), AND
//  (b) some URLs succeed while another returns 429 — rateLimitDetected must
//      be true even when the batch is partly successful (mirrors the proxy-retry
//      scenario where had429 is signaled independently of final request success).
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from "vitest";
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

afterEach(() => {
  vi.restoreAllMocks();
});

// Regular HTML URLs — not PDF/image so shouldSkipUrl() passes them through
// and fetchWithRateLimitAndProxy is actually invoked.
const HTML_URL_A = "https://ratelimit-test.example/page-a";
const HTML_URL_B = "https://ratelimit-test.example/page-b";

async function createProject(urls: string[], overrides: Record<string, any> = {}) {
  const res = await request(app)
    .post("/api/projects")
    .send({
      domain: `test-ratelimit-${Date.now()}-${Math.floor(Math.random() * 1e6)}.example`,
      status: "content_scraping",
      queue: urls,
      processed: [],
      results: urls.map((u) => ({ loc: u, images: [], videos: [] })),
      errors: [],
      ...overrides,
    });
  expect(res.status).toBe(201);
  createdProjectIds.push(res.body.id);
  return res.body;
}

/** Build a minimal mock Response with the given status. */
function mockResponse(status: number, body = ""): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (_: string) => null } as any,
    text: async () => body,
  } as unknown as Response;
}

describe("POST /api/scrape/content — 429 rateLimitDetected signaling", () => {
  let project: any;

  afterEach(async () => {
    const idx = createdProjectIds.indexOf(project?.id);
    if (idx !== -1) createdProjectIds.splice(idx, 1);
    try { await storage.deleteProject(project.id); } catch {}
  });

  it("sets rateLimitDetected=true when the fetch returns 429 (no retry available)", async () => {
    project = await createProject([HTML_URL_A]);
    await request(app)
      .put(`/api/projects/${project.id}`)
      .send({ queue: [HTML_URL_A], lockOwner: "tab1" });

    // No proxy configured → single attempt per URL → 429 throws
    vi.spyOn(global, "fetch").mockResolvedValue(mockResponse(429));

    const res = await request(app)
      .post("/api/scrape/content")
      .send({ urls: [HTML_URL_A], projectId: project.id, lockOwner: "tab1" });

    expect(res.status).toBe(200);
    expect(res.body.rateLimitDetected).toBe(true);
    // The URL must appear as a failure with "429" in the error
    const urlResult = res.body.results.find((r: any) => r.url === HTML_URL_A);
    expect(urlResult.success).toBe(false);
    expect(String(urlResult.error)).toMatch(/429/);
  });

  it("sets rateLimitDetected=false for ordinary non-429 HTTP errors", async () => {
    project = await createProject([HTML_URL_A]);
    await request(app)
      .put(`/api/projects/${project.id}`)
      .send({ queue: [HTML_URL_A], lockOwner: "tab1" });

    // 503 is a server error but NOT a rate-limit
    vi.spyOn(global, "fetch").mockResolvedValue(mockResponse(503));

    const res = await request(app)
      .post("/api/scrape/content")
      .send({ urls: [HTML_URL_A], projectId: project.id, lockOwner: "tab1" });

    expect(res.status).toBe(200);
    expect(res.body.rateLimitDetected).toBe(false);
    const urlResult = res.body.results.find((r: any) => r.url === HTML_URL_A);
    expect(urlResult.success).toBe(false);
  });

  it("sets rateLimitDetected=true even when some URLs succeed while one returns 429", async () => {
    // This mirrors the proxy-retry scenario: had429 must be signaled as long as
    // ANY fetch received a 429, independently of whether other fetches succeed.
    // Without proxy, there is no per-URL retry; the 429 URL fails and the 200 URL
    // succeeds. The batch flag must still be true.
    project = await createProject([HTML_URL_A, HTML_URL_B]);
    await request(app)
      .put(`/api/projects/${project.id}`)
      .send({ queue: [HTML_URL_A, HTML_URL_B], lockOwner: "tab1" });

    const goodHtml = "<html><head><title>OK</title></head><body>hello</body></html>";
    // URL_A → 429, URL_B → 200; order of parallel calls is non-deterministic so
    // mock by URL identity
    vi.spyOn(global, "fetch").mockImplementation(async (url: RequestInfo | URL) => {
      const urlStr = String(url);
      if (urlStr === HTML_URL_A) return mockResponse(429);
      return mockResponse(200, goodHtml);
    });

    const res = await request(app)
      .post("/api/scrape/content")
      .send({ urls: [HTML_URL_A, HTML_URL_B], projectId: project.id, lockOwner: "tab1" });

    expect(res.status).toBe(200);
    // Despite URL_B succeeding, the 429 on URL_A must trigger rateLimitDetected
    expect(res.body.rateLimitDetected).toBe(true);
    const aResult = res.body.results.find((r: any) => r.url === HTML_URL_A);
    expect(aResult.success).toBe(false);
  });

  it("parallelRequests rollback persists via PUT after rateLimitDetected", async () => {
    // Verifies the full client rollback flow: receive rateLimitDetected=true,
    // PUT the reduced parallelRequests (no expectedVersion), confirm persistence.
    project = await createProject([HTML_URL_A]);
    await request(app)
      .put(`/api/projects/${project.id}`)
      .send({ queue: [HTML_URL_A], lockOwner: "tab1" });

    vi.spyOn(global, "fetch").mockResolvedValue(mockResponse(429));

    const batchRes = await request(app)
      .post("/api/scrape/content")
      .send({ urls: [HTML_URL_A], projectId: project.id, lockOwner: "tab1" });

    expect(batchRes.body.rateLimitDetected).toBe(true);
    expect(typeof batchRes.body.suggestedParallelRequests).toBe("number");
    const suggested = batchRes.body.suggestedParallelRequests;

    // Simulate the client rollback PUT (no expectedVersion — must not conflict
    // with the batch progress write that just completed)
    const rollbackRes = await request(app)
      .put(`/api/projects/${project.id}`)
      .send({
        projectSettings: { scraping: { parallelRequests: suggested } },
        lockOwner: "tab1",
      });

    expect(rollbackRes.status).toBe(200);
    expect(rollbackRes.body.projectSettings?.scraping?.parallelRequests).toBe(suggested);

    // Confirm in storage
    const fresh = await storage.getProject(project.id);
    expect(fresh?.projectSettings?.scraping?.parallelRequests).toBe(suggested);
  });
});
