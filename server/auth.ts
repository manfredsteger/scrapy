// Password protection for the whole API.
//
// Every /api route can read scraped data, delete projects or spend the
// OpenAI key, so none of them may be reachable without logging in once the
// app runs anywhere public (Replit dev URL, Replit deployment).
//
// - APP_PASSWORD set: login required everywhere.
// - APP_PASSWORD missing on Replit or in production: the API refuses all
//   requests (fail closed) until the secret is configured.
// - APP_PASSWORD missing locally (Docker / npm run dev, not on Replit):
//   no login, the ports are bound to 127.0.0.1 only.
//
// Sessions are a stateless signed cookie, so they survive restarts and work
// across autoscale instances. Changing APP_PASSWORD or SESSION_SECRET logs
// everyone out.
import crypto from "crypto";
import type { Express, Request, Response, NextFunction } from "express";

const COOKIE_NAME = "scrapy_session";
const SESSION_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_MAX_FAILURES = 10;

export interface AuthConfig {
  password: string | undefined;
  required: boolean;
  sessionSecret: string | undefined;
}

export function readAuthConfig(env: NodeJS.ProcessEnv = process.env): AuthConfig {
  const password = env.APP_PASSWORD?.trim() || undefined;
  const onReplit = !!(env.REPL_ID || env.REPLIT_DEPLOYMENT || env.REPLIT_DEV_DOMAIN);
  return {
    password,
    required: !!password || onReplit || env.NODE_ENV === "production",
    sessionSecret: env.SESSION_SECRET || undefined,
  };
}

function signingKey(cfg: AuthConfig): Buffer {
  return crypto
    .createHash("sha256")
    .update(`scrapy-session|${cfg.password ?? ""}|${cfg.sessionSecret ?? ""}`)
    .digest();
}

export function createSessionToken(cfg: AuthConfig, now = Date.now()): string {
  const exp = String(now + SESSION_MAX_AGE_MS);
  const sig = crypto.createHmac("sha256", signingKey(cfg)).update(exp).digest("base64url");
  return `${exp}.${sig}`;
}

export function verifySessionToken(cfg: AuthConfig, token: string | undefined, now = Date.now()): boolean {
  if (!token || !cfg.password) return false;
  const [exp, sig] = token.split(".");
  if (!exp || !sig || !/^\d+$/.test(exp) || Number(exp) < now) return false;
  const expected = crypto.createHmac("sha256", signingKey(cfg)).update(exp).digest("base64url");
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function passwordMatches(cfg: AuthConfig, given: unknown): boolean {
  if (!cfg.password || typeof given !== "string") return false;
  const a = crypto.createHash("sha256").update(given).digest();
  const b = crypto.createHash("sha256").update(cfg.password).digest();
  return crypto.timingSafeEqual(a, b);
}

function readCookie(req: Request, name: string): string | undefined {
  const header = req.headers.cookie;
  if (!header) return undefined;
  for (const part of header.split(";")) {
    const idx = part.indexOf("=");
    if (idx === -1) continue;
    if (part.slice(0, idx).trim() === name) return decodeURIComponent(part.slice(idx + 1).trim());
  }
  return undefined;
}

function isSecureRequest(req: Request): boolean {
  return req.secure || req.headers["x-forwarded-proto"] === "https";
}

function setSessionCookie(req: Request, res: Response, value: string, maxAgeMs: number) {
  const parts = [
    `${COOKIE_NAME}=${encodeURIComponent(value)}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${Math.floor(maxAgeMs / 1000)}`,
  ];
  if (isSecureRequest(req)) parts.push("Secure");
  res.setHeader("Set-Cookie", parts.join("; "));
}

export function isAuthenticated(cfg: AuthConfig, req: Request): boolean {
  if (!cfg.required) return true;
  return verifySessionToken(cfg, readCookie(req, COOKIE_NAME));
}

// Failed login attempts per client IP, to slow down password guessing.
const failedLogins = new Map<string, { count: number; firstAt: number }>();

function loginBlocked(ip: string, now = Date.now()): boolean {
  const entry = failedLogins.get(ip);
  if (!entry) return false;
  if (now - entry.firstAt > LOGIN_WINDOW_MS) {
    failedLogins.delete(ip);
    return false;
  }
  return entry.count >= LOGIN_MAX_FAILURES;
}

function recordFailedLogin(ip: string, now = Date.now()) {
  const entry = failedLogins.get(ip);
  if (!entry || now - entry.firstAt > LOGIN_WINDOW_MS) {
    failedLogins.set(ip, { count: 1, firstAt: now });
  } else {
    entry.count++;
  }
}

export function setupAuth(app: Express, cfg: AuthConfig = readAuthConfig()) {
  if (cfg.required && !cfg.password) {
    console.error(
      "[Auth] APP_PASSWORD ist nicht gesetzt. Die API ist gesperrt, bis das Secret gesetzt ist " +
        "(Replit: Tools → Secrets → APP_PASSWORD).",
    );
  } else if (!cfg.required) {
    console.log("[Auth] Lokaler Modus ohne Passwort (APP_PASSWORD nicht gesetzt, nicht auf Replit).");
  }

  app.get("/api/auth/status", (req, res) => {
    res.json({
      authRequired: cfg.required,
      configured: !cfg.required || !!cfg.password,
      authenticated: isAuthenticated(cfg, req),
    });
  });

  app.post("/api/auth/login", (req, res) => {
    const ip = req.ip || "unknown";
    if (!cfg.password) {
      return res.status(503).json({ message: "Login ist nicht eingerichtet: APP_PASSWORD fehlt." });
    }
    if (loginBlocked(ip)) {
      return res.status(429).json({ message: "Zu viele Fehlversuche. Bitte in 15 Minuten erneut versuchen." });
    }
    if (!passwordMatches(cfg, req.body?.password)) {
      recordFailedLogin(ip);
      return res.status(401).json({ message: "Passwort falsch." });
    }
    failedLogins.delete(ip);
    setSessionCookie(req, res, createSessionToken(cfg), SESSION_MAX_AGE_MS);
    res.json({ authenticated: true });
  });

  app.post("/api/auth/logout", (req, res) => {
    setSessionCookie(req, res, "", 0);
    res.json({ authenticated: false });
  });

  app.use("/api", (req: Request, res: Response, next: NextFunction) => {
    if (req.path.startsWith("/auth/")) return next();
    if (cfg.required && !cfg.password) {
      return res.status(503).json({ message: "API gesperrt: APP_PASSWORD ist nicht gesetzt." });
    }
    if (!isAuthenticated(cfg, req)) {
      return res.status(401).json({ message: "Bitte anmelden." });
    }
    next();
  });
}
