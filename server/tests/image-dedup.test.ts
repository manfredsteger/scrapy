// Integration tests for shared-image ("boilerplate image") deduplication:
// POST /api/projects/:id/dedupe-images and GET /api/projects/:id/shared-images.
//
// These prove that an image repeating across most of a project's pages gets
// collapsed into a compact reference on disk, while genuinely unique
// per-page images are left untouched, and that consumers reading page meta
// (markdown export, RAG, preview) transparently see the full image again.
import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import express from "express";
import { createServer, type Server } from "http";
import request from "supertest";
import { registerRoutes } from "../routes";
import { storage } from "../storage";
import { pool } from "../db";
import * as fileStorage from "../fileStorage";
import { orderedElementsToMarkdown } from "../markdownConverter";

let app: express.Express;
let httpServer: Server;
const createdProjectIds: number[] = [];

const LOGO_SRC = "https://dedup-test.example/images/logo-guetesiegel.png";

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

async function createProject(pageCount: number) {
  const urls = Array.from({ length: pageCount }, (_, i) => `https://dedup-test.example/page${i}.php`);
  const res = await request(app)
    .post("/api/projects")
    .send({
      domain: `test-dedup-${Date.now()}-${Math.floor(Math.random() * 1e6)}.example`,
      status: "idle",
      queue: [],
      processed: urls,
      results: urls.map(u => ({ loc: u, hasScrapedData: true, status: "scraped", images: [], videos: [] })),
      errors: [],
    });
  expect(res.status).toBe(201);
  createdProjectIds.push(res.body.id);
  return { project: res.body, urls };
}

function pageElements(uniqueImageSrc: string | null) {
  const elements: any[] = [
    { type: "media", tag: "img", src: LOGO_SRC, alt: "Gütesiegel Nachhaltige Kita" },
    { type: "paragraph", content: "Some page-specific text." },
  ];
  if (uniqueImageSrc) {
    elements.push({ type: "media", tag: "img", src: uniqueImageSrc, alt: "Kita Außenansicht" });
  }
  return elements;
}

describe("POST /api/projects/:id/dedupe-images", () => {
  let project: any;

  afterEach(async () => {
    if (!project) return;
    const idx = createdProjectIds.indexOf(project.id);
    if (idx !== -1) createdProjectIds.splice(idx, 1);
    try { await storage.deleteProject(project.id); } catch {}
    project = undefined;
  });

  it("collapses a recurring image into a shared reference but leaves unique images untouched", async () => {
    const pageCount = 10;
    const created = await createProject(pageCount);
    project = created.project;

    for (let i = 0; i < pageCount; i++) {
      const dir = fileStorage.getProjectPageDir(project.id, project.domain, created.urls[i]);
      await fileStorage.savePageMeta(dir, {
        url: created.urls[i],
        wordCount: 20,
        timestamp: new Date().toISOString(),
        orderedElements: pageElements(`https://dedup-test.example/unique-photo-${i}.jpg`),
      });
    }

    const res = await request(app)
      .post(`/api/projects/${project.id}/dedupe-images`)
      .send({ minOccurrences: 5, minSharePercent: 50 });
    expect(res.status).toBe(200);
    expect(res.body.scannedPages).toBe(pageCount);
    expect(res.body.sharedImageCount).toBe(1);
    expect(res.body.pagesRewritten).toBe(pageCount);

    // On-disk representation is now compact (a media-ref, not the full URL
    // repeated on every page) for the recurring logo...
    const rawDir = fileStorage.getProjectPageDir(project.id, project.domain, created.urls[0]);
    const rawJson = JSON.parse(await (await import("fs/promises")).readFile(`${rawDir}/meta.json`, "utf-8"));
    const rawLogoEntry = rawJson.orderedElements.find((el: any) => el.type === "media-ref");
    expect(rawLogoEntry).toBeTruthy();
    expect(rawJson.orderedElements.some((el: any) => el.src === LOGO_SRC)).toBe(false);

    // ...but readPageMeta transparently resolves it back to a full media
    // entry, so every existing consumer (markdown, RAG, preview) is unaffected.
    const resolvedMeta = await fileStorage.readPageMeta(rawDir);
    const resolvedLogo = resolvedMeta.orderedElements.find((el: any) => el.src === LOGO_SRC);
    expect(resolvedLogo).toBeTruthy();
    expect(resolvedLogo.type).toBe("media");

    const markdown = orderedElementsToMarkdown(resolvedMeta.orderedElements);
    expect(markdown).toContain(LOGO_SRC);

    // The unique per-page image was never collapsed.
    expect(resolvedMeta.orderedElements.some((el: any) => el.src === "https://dedup-test.example/unique-photo-0.jpg")).toBe(true);

    // The registry itself is inspectable.
    const listRes = await request(app).get(`/api/projects/${project.id}/shared-images`);
    expect(listRes.status).toBe(200);
    expect(listRes.body.computed).toBe(true);
    expect(listRes.body.images).toHaveLength(1);
    expect(listRes.body.images[0].src).toBe(LOGO_SRC);
    expect(listRes.body.images[0].occurrenceCount).toBe(pageCount);
  });

  it("does not flag an image that only appears on a small share of pages", async () => {
    const pageCount = 10;
    const created = await createProject(pageCount);
    project = created.project;

    for (let i = 0; i < pageCount; i++) {
      const dir = fileStorage.getProjectPageDir(project.id, project.domain, created.urls[i]);
      // Only 2 of 10 pages share this image - below the default threshold.
      const elements = i < 2
        ? [{ type: "media", tag: "img", src: LOGO_SRC, alt: "Occasional banner" }]
        : [{ type: "paragraph", content: "No image on this page." }];
      await fileStorage.savePageMeta(dir, { url: created.urls[i], wordCount: 5, timestamp: new Date().toISOString(), orderedElements: elements });
    }

    const res = await request(app)
      .post(`/api/projects/${project.id}/dedupe-images`)
      .send({ minOccurrences: 5, minSharePercent: 50 });
    expect(res.status).toBe(200);
    expect(res.body.sharedImageCount).toBe(0);
    expect(res.body.pagesRewritten).toBe(0);
  });

  it("returns an empty, not-yet-computed result before dedupe has ever run", async () => {
    const created = await createProject(1);
    project = created.project;
    const res = await request(app).get(`/api/projects/${project.id}/shared-images`);
    expect(res.status).toBe(200);
    expect(res.body.computed).toBe(false);
    expect(res.body.images).toEqual([]);
  });

  it("refuses to run while another session actively holds the scrape lock, so a concurrent rescrape can't be overwritten", async () => {
    const created = await createProject(1);
    project = created.project;
    await storage.updateProject(project.id, {
      scrapeLock: { owner: "other-tab", expiresAt: Date.now() + 60000 },
    });
    const res = await request(app)
      .post(`/api/projects/${project.id}/dedupe-images`)
      .send({});
    expect(res.status).toBe(409);
    expect(res.body.reason).toBe("locked");
  });

  it("releases its lock afterwards, leaving the project usable", async () => {
    const created = await createProject(1);
    project = created.project;
    const res = await request(app)
      .post(`/api/projects/${project.id}/dedupe-images`)
      .send({});
    expect(res.status).toBe(200);
    const fresh = await storage.getProject(project.id);
    expect((fresh as any)?.scrapeLock).toBeNull();
  });

  it("rejects an invalid minSharePercent", async () => {
    const created = await createProject(1);
    project = created.project;
    const res = await request(app)
      .post(`/api/projects/${project.id}/dedupe-images`)
      .send({ minSharePercent: 150 });
    expect(res.status).toBe(400);
  });

  it("consolidates already-downloaded per-page media files into one shared copy, resolvable end-to-end via url-content", async () => {
    const created = await createProject(3);
    project = created.project;
    const projectDir = fileStorage.getProjectDir(project.id, project.domain);
    const identicalBytes = Buffer.from("same-logo-bytes");
    const uniqueBytes = Buffer.from("this-page-own-photo");
    const logoUrl = "https://dedup-test.example/assets/logo.png";
    const uniqueUrl = "https://dedup-test.example/assets/unique.jpg";

    // Simulate pre-existing per-page media copies, as saved by older code
    // before shared-media storage existed: the same logo saved 3 times, each
    // page's meta.json referencing it by its source URL (so consolidation
    // can match the file back to that URL).
    for (const url of created.urls) {
      const dir = fileStorage.getProjectPageDir(project.id, project.domain, url);
      await fileStorage.savePageContent(dir, "Page content");
      await fileStorage.savePageMeta(dir, {
        url, wordCount: 1, timestamp: new Date().toISOString(),
        orderedElements: [{ type: "media", tag: "img", src: logoUrl, alt: "Logo" }],
      });
      await fileStorage.saveMedia(dir, "logo.png", identicalBytes);
    }
    // One page also has a genuinely unique file, referenced the same way.
    const firstPageDir = fileStorage.getProjectPageDir(project.id, project.domain, created.urls[0]);
    const firstMeta = await fileStorage.readPageMeta(firstPageDir);
    await fileStorage.savePageMeta(firstPageDir, {
      ...firstMeta,
      orderedElements: [...firstMeta.orderedElements, { type: "media", tag: "img", src: uniqueUrl, alt: "Unique" }],
    });
    await fileStorage.saveMedia(firstPageDir, "unique.jpg", uniqueBytes);

    const res = await request(app)
      .post(`/api/projects/${project.id}/dedupe-images`)
      .send({});
    expect(res.status).toBe(200);
    expect(res.body.media.filesScanned).toBe(4);
    expect(res.body.media.uniqueFiles).toBe(2); // one logo copy kept + the unique file
    expect(res.body.media.bytesReclaimed).toBe(identicalBytes.length * 2); // the other 2 logo copies dropped
    expect(res.body.media.unmatched).toBe(0);

    // Per-page copies are gone...
    for (const url of created.urls) {
      const dir = fileStorage.getProjectPageDir(project.id, project.domain, url);
      expect(await fileStorage.listMedia(dir)).toEqual([]);
    }
    // ...but the bytes survive exactly once in the project-wide shared store.
    const sharedDir = `${projectDir}/shared-media`;
    const fsPromises = await import("fs/promises");
    const sharedFiles = await fsPromises.readdir(sharedDir);
    expect(sharedFiles).toHaveLength(2);

    // And consumers (e.g. the preview/download endpoint) can still resolve
    // both files after consolidation - this is the actual proof that moving
    // storage didn't strand the data behind an unresolvable key.
    for (const [url, expectedCount] of [[created.urls[0], 2], [created.urls[1], 1]] as const) {
      const encoded = encodeURIComponent(url);
      const contentRes = await request(app).get(`/api/projects/${project.id}/url-content?loc=${encoded}`);
      expect(contentRes.status).toBe(200);
      expect(contentRes.body.fileMedia).toHaveLength(expectedCount);
    }
  });

  it("leaves a legacy media file in place when two distinct source URLs collide on the same legacy filename", async () => {
    const created = await createProject(1);
    project = created.project;
    const dir = fileStorage.getProjectPageDir(project.id, project.domain, created.urls[0]);
    // Two different URLs both sanitize down to the same legacy filename
    // (e.g. same basename under different hosts/paths). The page's on-disk
    // storage could only ever hold one file for that name, so there's no
    // way to tell which URL actually produced its bytes - it must not be
    // migrated under either URL's key.
    await fileStorage.savePageMeta(dir, {
      url: created.urls[0], wordCount: 1, timestamp: new Date().toISOString(),
      orderedElements: [
        { type: "media", tag: "img", src: "https://host-a.example/assets/shared.png", alt: "A" },
        { type: "media", tag: "img", src: "https://host-b.example/other/shared.png", alt: "B" },
      ],
    });
    await fileStorage.saveMedia(dir, "shared.png", Buffer.from("ambiguous-bytes"));

    const res = await request(app)
      .post(`/api/projects/${project.id}/dedupe-images`)
      .send({});
    expect(res.status).toBe(200);
    expect(res.body.media.unmatched).toBe(1);
    expect(res.body.media.uniqueFiles).toBe(0);
    expect(res.body.media.bytesReclaimed).toBe(0);

    const remaining = await fileStorage.listMedia(dir);
    expect(remaining).toHaveLength(1);
    expect(remaining[0]).toContain("shared.png");
  });

  it("leaves an unmatched legacy media file in place (never deletes data it can't confidently re-key), and it still resolves via the page's legacy media dir", async () => {
    const created = await createProject(1);
    project = created.project;
    const dir = fileStorage.getProjectPageDir(project.id, project.domain, created.urls[0]);
    // No orderedElements reference this file's expected legacy filename (as
    // could happen if the element was later removed from the page, or an
    // old naming scheme didn't line up) - consolidation can't confidently
    // attribute it to a source URL.
    await fileStorage.savePageMeta(dir, { url: created.urls[0], wordCount: 1, timestamp: new Date().toISOString(), orderedElements: [] });
    await fileStorage.saveMedia(dir, "orphan.png", Buffer.from("orphan-bytes"));

    const res = await request(app)
      .post(`/api/projects/${project.id}/dedupe-images`)
      .send({});
    expect(res.status).toBe(200);
    expect(res.body.media.unmatched).toBe(1);
    expect(res.body.media.uniqueFiles).toBe(0);
    expect(res.body.media.bytesReclaimed).toBe(0);

    // The file was left exactly where it was - not deleted, not silently
    // stranded under an unresolvable shared-store key.
    const remaining = await fileStorage.listMedia(dir);
    expect(remaining).toHaveLength(1);
    expect(remaining[0]).toContain("orphan.png");
  });

  it("does not re-fetch a media URL already downloaded for another page in the project", async () => {
    const created = await createProject(2);
    project = created.project;

    let fetchCount = 0;
    const sharedLogoUrl = "https://dedup-test.example/shared-logo.png";
    const realFetch = global.fetch;
    (global as any).fetch = async (url: string, ...args: any[]) => {
      if (url === sharedLogoUrl) {
        fetchCount++;
        return {
          ok: true,
          arrayBuffer: async () => Buffer.from("logo-bytes"),
        } as any;
      }
      return realFetch(url as any, ...(args as [any]));
    };
    try {
      for (const url of created.urls) {
        const dir = fileStorage.getProjectPageDir(project.id, project.domain, url);
        await fileStorage.savePageMeta(dir, {
          url,
          wordCount: 5,
          timestamp: new Date().toISOString(),
          orderedElements: [{ type: "media", tag: "img", src: sharedLogoUrl, alt: "Logo" }],
        });
        // Directly exercise the same content-addressed check the scrape
        // loop uses, since driving a full HTML fetch+extract here is out of
        // scope for this unit-level test.
        const { sharedImageId } = await import("../content-extraction/image-refs");
        const id = sharedImageId(sharedLogoUrl);
        const projectDir = fileStorage.getProjectDir(project.id, project.domain);
        const existing = await fileStorage.sharedMediaExists(projectDir, id, ".png");
        if (!existing) {
          const resp = await fetch(sharedLogoUrl);
          const buf = Buffer.from(await (resp as any).arrayBuffer());
          await fileStorage.saveSharedMedia(projectDir, id, ".png", buf);
        }
      }
    } finally {
      global.fetch = realFetch;
    }
    expect(fetchCount).toBe(1);
  });

  it("only downloads a media URL once when multiple pages referencing it are scraped concurrently in the same batch", async () => {
    // Drives the real scrape batch (via requeue-pages, which calls the exact
    // same runContentScrapeBatch the interactive crawl loop uses) with two
    // URLs at once, so both are processed concurrently by Promise.all - the
    // actual race the in-flight-download map guards against, not just a
    // sequential simulation of it.
    const pageCount = 2;
    const created = await createProject(pageCount);
    project = created.project;

    const sharedLogoUrl = "https://dedup-test.example/concurrent-logo.png";
    let logoFetchCount = 0;

    const realFetch = global.fetch;
    (global as any).fetch = async (url: string, opts?: any) => {
      if (url === sharedLogoUrl) {
        logoFetchCount++;
        // A small delay gives both pages' independent processing a chance
        // to reach the media-download step before this resolves, so a
        // broken (non-deduped) implementation really would issue two
        // requests instead of accidentally passing due to sequencing.
        await new Promise(resolve => setTimeout(resolve, 20));
        return { ok: true, arrayBuffer: async () => Buffer.from("logo-bytes") } as any;
      }
      if (created.urls.includes(url)) {
        const html = `<html><body><main><img src="${sharedLogoUrl}" alt="Logo"><p>Page text for ${url}</p></main></body></html>`;
        return { ok: true, status: 200, headers: new Headers(), text: async () => html } as any;
      }
      return realFetch(url as any, opts);
    };

    try {
      const res = await request(app)
        .post(`/api/projects/${project.id}/requeue-pages`)
        .send({ urls: created.urls });
      expect(res.status).toBe(200);
    } finally {
      global.fetch = realFetch;
    }

    // Both pages referenced the same not-yet-downloaded image concurrently;
    // it must still only be fetched once for the whole batch.
    expect(logoFetchCount).toBe(1);
  });
});
