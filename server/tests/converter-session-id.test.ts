// Regression: converter routes built filesystem paths straight from the
// client-supplied sessionId. Express decodes %2F, so
// DELETE /api/converter/..%2F..%2Fapp resolved to /app and fs.rm deleted it
// (in dev that is the bind-mounted source tree).
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import express from "express";
import { createServer, type Server } from "http";
import request from "supertest";
import path from "path";
import fs from "fs/promises";
import { registerRoutes } from "../routes";
import { pool } from "../db";

let app: express.Express;
let httpServer: Server;
const canaryDir = path.resolve("./data/converter-canary-test");

beforeAll(async () => {
  app = express();
  app.use(express.json());
  httpServer = createServer(app);
  await registerRoutes(httpServer, app);
  await fs.mkdir(canaryDir, { recursive: true });
  await fs.writeFile(path.join(canaryDir, "keep.txt"), "must survive");
});

afterAll(async () => {
  await fs.rm(canaryDir, { recursive: true, force: true });
  httpServer.close();
  await pool.end();
});

describe("converter sessionId validation", () => {
  it("rejects an encoded path traversal on DELETE and keeps the directory", async () => {
    const res = await request(app).delete("/api/converter/..%2Fconverter-canary-test");
    expect(res.status).toBe(400);
    await expect(fs.readFile(path.join(canaryDir, "keep.txt"), "utf8")).resolves.toBe("must survive");
  });

  it("rejects an encoded traversal sessionId on generate", async () => {
    const res = await request(app).post("/api/converter/..%2F..%2Fapp/generate");
    expect(res.status).toBe(400);
  });

  it("rejects a traversal sessionId on exports/save", async () => {
    const res = await request(app)
      .post("/api/converter/exports/save")
      .send({ sessionId: "../../app", downloadId: "x" });
    expect(res.status).toBe(400);
  });

  it("accepts a well-formed session id", async () => {
    const res = await request(app).delete("/api/converter/0123456789abcdef");
    expect(res.status).toBe(200);
  });
});
