import { describe, it, expect } from "vitest";
import { JSDOM } from "jsdom";
import { detectSoftNotFound } from "../content-extraction/soft-404";

function docFor(html: string): Document {
  return new JSDOM(html).window.document;
}

describe("detectSoftNotFound", () => {
  it("flags a small body with a 'not found' heading (kita-bayern.de style)", () => {
    const html = '<html><body><div class="error_online"><h2>Seite nicht gefunden</h2></div></body></html>';
    expect(detectSoftNotFound(docFor(html), html)).toBe(true);
  });

  it("does not flag a genuine short page without a not-found heading", () => {
    const html = '<html><body><h1>Willkommen</h1><p>Kurzer Text.</p></body></html>';
    expect(detectSoftNotFound(docFor(html), html)).toBe(false);
  });

  it("does not flag a large page even if it happens to mention 404 somewhere", () => {
    const filler = '<p>Lorem ipsum dolor sit amet. </p>'.repeat(200);
    const html = `<html><body><h1>Fehlercode 404 in unserem Blogartikel</h1>${filler}</body></html>`;
    expect(Buffer.byteLength(html, 'utf-8')).toBeGreaterThan(4096);
    expect(detectSoftNotFound(docFor(html), html)).toBe(false);
  });

  it("uses the source-specific hook when provided, even if the generic heuristic would miss it", () => {
    const html = '<html><body><div class="error_online">Kein Treffer</div></body></html>';
    const hook = (doc: Document) => doc.querySelector('.error_online') !== null;
    expect(detectSoftNotFound(docFor(html), html, hook)).toBe(true);
  });
});
