import fs from "fs/promises";
import path from "path";
import crypto from "crypto";

const BASE_DIR = path.resolve("./data");

function urlHash(url: string): string {
  return crypto.createHash("sha256").update(url).digest("hex").slice(0, 10);
}

export function sanitizeDirName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9.\-]/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

export function getProjectDir(projectId: number, domain: string): string {
  return path.join(BASE_DIR, "projects", `${projectId}-${sanitizeDirName(domain)}`);
}

export function getProjectPageDir(projectId: number, domain: string, url: string): string {
  const projectDir = getProjectDir(projectId, domain);
  let pathname: string;
  try {
    const parsed = new URL(url);
    pathname = parsed.pathname + (parsed.search || '');
  } catch {
    pathname = url;
  }
  const segments = pathname
    .split("/")
    .filter(Boolean)
    .map((seg) => sanitizeDirName(seg.replace(/\./g, "-")));
  if (segments.length === 0) {
    segments.push("index");
  }
  const hash = urlHash(url);
  const lastIdx = segments.length - 1;
  segments[lastIdx] = `${segments[lastIdx]}_${hash}`;
  return path.join(projectDir, "pages", ...segments);
}

export function getSinglePageDir(pageId: number, domain: string): string {
  return path.join(BASE_DIR, "single-pages", `${pageId}-${sanitizeDirName(domain)}`);
}

export async function ensureDir(dirPath: string): Promise<void> {
  await fs.mkdir(dirPath, { recursive: true });
}

export async function savePageContent(dir: string, markdown: string): Promise<void> {
  await ensureDir(dir);
  await fs.writeFile(path.join(dir, "content.md"), markdown, "utf-8");
}

export async function savePageMeta(dir: string, meta: object): Promise<void> {
  await ensureDir(dir);
  await fs.writeFile(path.join(dir, "meta.json"), JSON.stringify(meta, null, 2), "utf-8");
}

export async function saveProjectMeta(dir: string, meta: object): Promise<void> {
  await ensureDir(dir);
  await fs.writeFile(path.join(dir, "meta.json"), JSON.stringify(meta, null, 2), "utf-8");
}

export async function savePdf(dir: string, filename: string, buffer: Buffer): Promise<string> {
  const pdfDir = path.join(dir, "pdfs");
  await ensureDir(pdfDir);
  const safeName = sanitizeDirName(filename.replace(/\.pdf$/i, "")) + ".pdf";
  const filePath = path.join(pdfDir, safeName);
  await fs.writeFile(filePath, buffer);
  return filePath;
}

export async function saveMedia(dir: string, filename: string, buffer: Buffer): Promise<string> {
  const mediaDir = path.join(dir, "media");
  await ensureDir(mediaDir);
  const ext = path.extname(filename) || "";
  const baseName = sanitizeDirName(path.basename(filename, ext));
  const safeName = baseName + ext.toLowerCase();
  const filePath = path.join(mediaDir, safeName);
  await fs.writeFile(filePath, buffer);
  return filePath;
}

export async function readPageContent(dir: string): Promise<string | null> {
  try {
    return await fs.readFile(path.join(dir, "content.md"), "utf-8");
  } catch {
    return null;
  }
}

export async function readPageMeta(dir: string): Promise<any | null> {
  try {
    const raw = await fs.readFile(path.join(dir, "meta.json"), "utf-8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export async function readProjectMeta(dir: string): Promise<any | null> {
  try {
    const raw = await fs.readFile(path.join(dir, "meta.json"), "utf-8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export async function listPageDirs(projectDir: string): Promise<string[]> {
  const pagesDir = path.join(projectDir, "pages");
  try {
    const dirs: string[] = [];
    const walk = async (current: string) => {
      const entries = await fs.readdir(current, { withFileTypes: true });
      const hasContent = entries.some((e) => e.isFile() && (e.name === "content.md" || e.name === "meta.json"));
      if (hasContent) {
        dirs.push(current);
      }
      for (const entry of entries) {
        if (entry.isDirectory() && entry.name !== "pdfs" && entry.name !== "media") {
          await walk(path.join(current, entry.name));
        }
      }
    };
    await walk(pagesDir);
    return dirs;
  } catch {
    return [];
  }
}

export async function listPdfs(dir: string): Promise<string[]> {
  const pdfDir = path.join(dir, "pdfs");
  try {
    const entries = await fs.readdir(pdfDir);
    return entries.filter((f) => f.toLowerCase().endsWith(".pdf")).map((f) => path.join(pdfDir, f));
  } catch {
    return [];
  }
}

export async function listMedia(dir: string): Promise<string[]> {
  const mediaDir = path.join(dir, "media");
  try {
    const entries = await fs.readdir(mediaDir);
    return entries.map((f) => path.join(mediaDir, f));
  } catch {
    return [];
  }
}

export async function readPdf(filePath: string): Promise<Buffer | null> {
  try {
    return await fs.readFile(filePath);
  } catch {
    return null;
  }
}

export async function findPdfByUrl(pageDir: string, pdfUrl: string): Promise<Buffer | null> {
  const urlFilename = pdfUrl.split('/').pop()?.split('?')[0] || '';
  if (!urlFilename) return null;
  const expectedName = sanitizeDirName(urlFilename.replace(/\.pdf$/i, '')) + '.pdf';
  const pdfDir = path.join(pageDir, 'pdfs');
  try {
    const filePath = path.join(pdfDir, expectedName);
    return await fs.readFile(filePath);
  } catch {
    return null;
  }
}

const pdfDownloadIndexCache = new Map<string, Map<string, string>>();

async function loadPdfDownloadIndex(projectDir: string): Promise<Map<string, string>> {
  const cached = pdfDownloadIndexCache.get(projectDir);
  if (cached) return cached;
  const indexPath = path.join(projectDir, 'pdf-downloads', 'index.json');
  try {
    const data = JSON.parse(await fs.readFile(indexPath, 'utf-8'));
    const map = new Map<string, string>(Object.entries(data));
    pdfDownloadIndexCache.set(projectDir, map);
    return map;
  } catch {
    const map = new Map<string, string>();
    pdfDownloadIndexCache.set(projectDir, map);
    return map;
  }
}

async function savePdfDownloadIndex(projectDir: string, index: Map<string, string>): Promise<void> {
  const dlDir = path.join(projectDir, 'pdf-downloads');
  await ensureDir(dlDir);
  const obj: Record<string, string> = {};
  for (const [k, v] of index) obj[k] = v;
  await fs.writeFile(path.join(dlDir, 'index.json'), JSON.stringify(obj, null, 2), 'utf-8');
}

export async function findProjectPdf(projectId: number, domain: string, pdfUrl: string, pageDir?: string): Promise<Buffer | null> {
  if (pageDir) {
    const fromPage = await findPdfByUrl(pageDir, pdfUrl);
    if (fromPage) return fromPage;
  }
  const projectDir = getProjectDir(projectId, domain);
  const index = await loadPdfDownloadIndex(projectDir);
  const localPath = index.get(pdfUrl);
  if (localPath) {
    try {
      return await fs.readFile(localPath);
    } catch {
      index.delete(pdfUrl);
    }
  }
  return null;
}

export async function saveProjectPdf(projectId: number, domain: string, pdfUrl: string, buffer: Buffer): Promise<string> {
  const projectDir = getProjectDir(projectId, domain);
  const dlDir = path.join(projectDir, 'pdf-downloads');
  await ensureDir(dlDir);
  const hash = urlHash(pdfUrl);
  const urlFilename = pdfUrl.split('/').pop()?.split('?')[0] || 'document.pdf';
  const safeName = sanitizeDirName(urlFilename.replace(/\.pdf$/i, '')) + '.pdf';
  const filename = `${hash}_${safeName}`;
  const filePath = path.join(dlDir, filename);
  await fs.writeFile(filePath, buffer);
  const index = await loadPdfDownloadIndex(projectDir);
  index.set(pdfUrl, filePath);
  await savePdfDownloadIndex(projectDir, index);
  return filePath;
}

export function clearPdfDownloadIndexCache(projectId: number, domain: string): void {
  const projectDir = getProjectDir(projectId, domain);
  pdfDownloadIndexCache.delete(projectDir);
}

export async function countProjectAttachments(projectId: number, domain: string): Promise<number> {
  const projectDir = getProjectDir(projectId, domain);
  const pageDirs = await listPageDirs(projectDir);
  let total = 0;
  for (const pageDir of pageDirs) {
    try {
      const meta = await readPageMeta(pageDir);
      if (meta?.linkedPdfs && Array.isArray(meta.linkedPdfs)) {
        total += meta.linkedPdfs.length;
      }
    } catch {}
  }
  return total;
}

export async function getPagePdfCounts(projectId: number, domain: string): Promise<Map<string, number>> {
  const projectDir = getProjectDir(projectId, domain);
  const pageDirs = await listPageDirs(projectDir);
  const counts = new Map<string, number>();
  for (const pageDir of pageDirs) {
    try {
      const meta = await readPageMeta(pageDir);
      if (meta?.url && meta?.linkedPdfs && Array.isArray(meta.linkedPdfs)) {
        counts.set(meta.url, meta.linkedPdfs.length);
      }
    } catch {}
  }
  return counts;
}

export interface PdfReference {
  url: string;
  title?: string;
  linkText?: string;
  pageUrl: string;
  localPath?: string;
  downloaded: boolean;
}

export async function buildProjectPdfsJson(projectId: number, domain: string): Promise<PdfReference[]> {
  const projectDir = getProjectDir(projectId, domain);
  const pageDirs = await listPageDirs(projectDir);
  const allPdfs: PdfReference[] = [];

  for (const pageDir of pageDirs) {
    try {
      const meta = await readPageMeta(pageDir);
      if (!meta?.linkedPdfs || !Array.isArray(meta.linkedPdfs)) continue;

      const localPdfs = await listPdfs(pageDir);
      const localNames = localPdfs.map(p => p.split('/').pop() || '');

      for (const pdf of meta.linkedPdfs) {
        const urlFilename = pdf.url?.split('/').pop()?.split('?')[0] || '';
        const matchedLocal = localPdfs.find((_, i) => {
          const name = localNames[i];
          return name === urlFilename || name.includes(sanitizeDirName(urlFilename.replace(/\.pdf$/i, '')));
        });

        allPdfs.push({
          url: pdf.url,
          title: pdf.title,
          linkText: pdf.linkText,
          pageUrl: meta.url || '',
          localPath: matchedLocal ? path.relative(projectDir, matchedLocal) : undefined,
          downloaded: !!matchedLocal,
        });
      }
    } catch {}
  }

  await ensureDir(projectDir);
  await fs.writeFile(path.join(projectDir, "pdfs.json"), JSON.stringify(allPdfs, null, 2), "utf-8");
  return allPdfs;
}

export async function readProjectPdfsJson(projectId: number, domain: string): Promise<PdfReference[] | null> {
  const projectDir = getProjectDir(projectId, domain);
  try {
    const raw = await fs.readFile(path.join(projectDir, "pdfs.json"), "utf-8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export async function saveProjectChunks(projectId: number, domain: string, chunks: any[]): Promise<void> {
  const dir = getProjectDir(projectId, domain);
  await ensureDir(dir);
  await fs.writeFile(path.join(dir, "chunks.json"), JSON.stringify(chunks), "utf-8");
}

export async function readProjectChunks(projectId: number, domain: string): Promise<any[] | null> {
  const dir = getProjectDir(projectId, domain);
  try {
    const raw = await fs.readFile(path.join(dir, "chunks.json"), "utf-8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export async function saveSinglePageChunks(pageId: number, domain: string, chunks: any[]): Promise<void> {
  const dir = getSinglePageDir(pageId, domain);
  await ensureDir(dir);
  await fs.writeFile(path.join(dir, "chunks.json"), JSON.stringify(chunks), "utf-8");
}

export async function readSinglePageChunks(pageId: number, domain: string): Promise<any[] | null> {
  const dir = getSinglePageDir(pageId, domain);
  try {
    const raw = await fs.readFile(path.join(dir, "chunks.json"), "utf-8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export async function deleteProjectDir(projectId: number, domain: string): Promise<void> {
  const dir = getProjectDir(projectId, domain);
  try {
    await fs.rm(dir, { recursive: true, force: true });
  } catch {
  }
}

export async function deleteSinglePageDir(pageId: number, domain: string): Promise<void> {
  const dir = getSinglePageDir(pageId, domain);
  try {
    await fs.rm(dir, { recursive: true, force: true });
  } catch {
  }
}

export async function getStorageStats(): Promise<{ totalFiles: number; totalSizeBytes: number }> {
  let totalFiles = 0;
  let totalSizeBytes = 0;

  const walk = async (dirPath: string) => {
    try {
      const entries = await fs.readdir(dirPath, { withFileTypes: true });
      for (const entry of entries) {
        const fullPath = path.join(dirPath, entry.name);
        if (entry.isDirectory()) {
          await walk(fullPath);
        } else if (entry.isFile()) {
          totalFiles++;
          try {
            const stat = await fs.stat(fullPath);
            totalSizeBytes += stat.size;
          } catch {
          }
        }
      }
    } catch {
    }
  };

  await walk(BASE_DIR);
  return { totalFiles, totalSizeBytes };
}
