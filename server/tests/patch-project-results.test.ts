// storage.patchProjectResults: a scrape batch updates only its own result
// rows instead of deleting and re-inserting every row of the project.
import { describe, it, expect, afterAll } from "vitest";
import { storage } from "../storage";
import { pool } from "../db";

const created: number[] = [];
afterAll(async () => {
  for (const id of created) {
    try { await storage.deleteProject(id); } catch {}
  }
  await pool.end();
});

async function makeProject(scrapeLock: any = null) {
  const p = await storage.createProject({
    domain: `test-patch-${Date.now()}-${Math.floor(Math.random() * 1e6)}.example`,
    status: "content_scraping",
    queue: [],
    processed: [],
    errors: [],
    results: [
      { loc: "https://x.example/a", status: "failed", errorStatus: "failed", errorMessage: "timeout" },
      { loc: "https://x.example/b", status: "pending", note: "untouched" },
    ],
  } as any);
  created.push(p.id);
  if (scrapeLock) await storage.updateProject(p.id, { scrapeLock } as any);
  return p;
}

describe("patchProjectResults", () => {
  it("merges fields, removes undefined keys and leaves other rows alone", async () => {
    const p = await makeProject();
    const patches = new Map<string, Record<string, any>>([
      ["https://x.example/a", { status: "scraped", hasScrapedData: true, errorStatus: undefined, errorMessage: undefined }],
      ["https://x.example/unknown", { status: "scraped" }],
    ]);
    const saved = await storage.patchProjectResults(p.id, patches, { enforceLockOwner: "" });
    expect(saved?.version).toBeGreaterThan((p as any).version ?? 0);

    const fresh = await storage.getProject(p.id);
    const byLoc = Object.fromEntries((fresh!.results || []).map((r: any) => [r.loc, r]));
    expect(byLoc["https://x.example/a"]).toEqual({ loc: "https://x.example/a", status: "scraped", hasScrapedData: true });
    expect(byLoc["https://x.example/b"]).toEqual({ loc: "https://x.example/b", status: "pending", note: "untouched" });
    expect(fresh!.results).toHaveLength(2); // unknown loc not inserted
  });

  it("refuses to write while another session holds the lock", async () => {
    const p = await makeProject({ owner: "other-tab", expiresAt: Date.now() + 60_000 });
    const saved = await storage.patchProjectResults(
      p.id,
      new Map([["https://x.example/a", { status: "scraped" }]]),
      { enforceLockOwner: "me" },
    );
    expect(saved).toBeUndefined();
    const fresh = await storage.getProject(p.id);
    expect((fresh!.results || []).find((r: any) => r.loc === "https://x.example/a")?.status).toBe("failed");
  });
});
