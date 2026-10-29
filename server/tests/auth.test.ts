// The whole /api must sit behind the login whenever the app is reachable
// publicly (Replit, production). Locally without APP_PASSWORD it stays open.
import { describe, it, expect } from "vitest";
import express from "express";
import request from "supertest";
import { setupAuth, readAuthConfig, createSessionToken, verifySessionToken } from "../auth";

function makeApp(env: Record<string, string>) {
  const app = express();
  app.use(express.json());
  setupAuth(app, readAuthConfig(env as NodeJS.ProcessEnv));
  app.get("/api/projects", (_req, res) => res.json([{ id: 1 }]));
  app.delete("/api/projects/:id", (_req, res) => res.json({ ok: true }));
  return app;
}

describe("readAuthConfig", () => {
  it("requires login on Replit and in production even without a password", () => {
    expect(readAuthConfig({ REPL_ID: "x" } as any).required).toBe(true);
    expect(readAuthConfig({ NODE_ENV: "production" } as any).required).toBe(true);
    expect(readAuthConfig({ NODE_ENV: "development" } as any).required).toBe(false);
  });
});

describe("API protection", () => {
  it("blocks the API with 401 until logged in, then allows it", async () => {
    const app = makeApp({ APP_PASSWORD: "geheim", NODE_ENV: "production" });
    expect((await request(app).get("/api/projects")).status).toBe(401);
    expect((await request(app).delete("/api/projects/1")).status).toBe(401);

    const bad = await request(app).post("/api/auth/login").send({ password: "falsch" });
    expect(bad.status).toBe(401);

    const login = await request(app).post("/api/auth/login").send({ password: "geheim" });
    expect(login.status).toBe(200);
    const cookie = login.headers["set-cookie"];
    expect(String(cookie)).toMatch(/HttpOnly/);

    const ok = await request(app).get("/api/projects").set("Cookie", cookie);
    expect(ok.status).toBe(200);
  });

  it("fails closed on Replit when APP_PASSWORD is missing", async () => {
    const app = makeApp({ REPL_ID: "abc" });
    const res = await request(app).get("/api/projects");
    expect(res.status).toBe(503);
    const status = await request(app).get("/api/auth/status");
    expect(status.body).toMatchObject({ authRequired: true, configured: false, authenticated: false });
  });

  it("stays open locally without a password", async () => {
    const app = makeApp({ NODE_ENV: "development" });
    expect((await request(app).get("/api/projects")).status).toBe(200);
  });

  it("rejects forged, expired and old-password tokens", () => {
    const cfg = readAuthConfig({ APP_PASSWORD: "a" } as any);
    const token = createSessionToken(cfg, 1000);
    expect(verifySessionToken(cfg, token, 2000)).toBe(true);
    expect(verifySessionToken(cfg, token.replace(/.$/, (c) => (c === "A" ? "B" : "A")), 2000)).toBe(false);
    expect(verifySessionToken(cfg, token, 1000 + 31 * 24 * 3600 * 1000)).toBe(false);
    const newCfg = readAuthConfig({ APP_PASSWORD: "b" } as any);
    expect(verifySessionToken(newCfg, token, 2000)).toBe(false);
  });

  it("locks out after too many failed logins", async () => {
    const app = makeApp({ APP_PASSWORD: "geheim2", NODE_ENV: "production" });
    for (let i = 0; i < 10; i++) {
      await request(app).post("/api/auth/login").send({ password: "nope" });
    }
    const res = await request(app).post("/api/auth/login").send({ password: "geheim2" });
    expect(res.status).toBe(429);
  });
});
