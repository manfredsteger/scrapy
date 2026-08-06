import { describe, it, expect } from "vitest";
import { scrapePageContent } from "../content-extraction/page-content-extractor";

describe("scrapePageContent - loose/inline text capture", () => {
  it("captures label/value pairs that sit as bare text next to <div> labels and <a> links (kitanetz.de-style markup)", () => {
    // Mirrors the real kitanetz.de detail-page markup: a <div> label
    // immediately followed by loose text or an inline <a>, all inside a
    // <p> that gets auto-closed by HTML5 parsing because <div> can't
    // legally live inside <p>. Before the fix, all of this text was
    // silently dropped because it never sits inside a <p>/<h*> and text
    // nodes were ignored outright.
    const html = `
      <html><body>
        <main>
          <h1>little kids education</h1>
          <p class="titel">Traeger:<br></p>
          <a href="https://example.com/traeger">little kids education services GmbH</a><br>
          <p><div class="titel">Email:</div><br><a href="mailto:s.ockenfels@lkeducation.de">s.ockenfels@lkeducation.de</a></p>
          <p><div class="titel">Betreuung:</div><br>Fuer Kinder von ca. 10 Monaten bis ca. 3,5 Jahren</p>
          <p><div class="titel">Homepage:</div><br><a href="https://lkeducation.de/">https://lkeducation.de/</a></p>
        </main>
      </body></html>
    `;

    const result = scrapePageContent(html, "https://www.kitanetz.de/bayern/80333/fuerstenstrasse11.php", false);
    const paragraphs = (result.orderedElements || [])
      .filter((el: any) => el.type === "paragraph")
      .map((el: any) => el.content);
    const allText = paragraphs.join(" | ");

    // Note: the standalone "Traeger:" label itself is a real <p> shorter than
    // the pre-existing minimum paragraph length (unrelated to this fix); the
    // link text right after it is what matters for content recovery.
    expect(allText).toContain("little kids education services GmbH");
    expect(allText).toContain("Email:");
    expect(allText).toContain("s.ockenfels@lkeducation.de");
    expect(allText).toContain("Betreuung:");
    expect(allText).toContain("Fuer Kinder von ca. 10 Monaten bis ca. 3,5 Jahren");
    expect(allText).toContain("Homepage:");
    expect(allText).toContain("https://lkeducation.de/");
  });

  it("preserves document order between headings and the recovered loose text", () => {
    const html = `
      <html><body>
        <main>
          <h2>Section A</h2>
          <div>Loose text under A</div>
          <h2>Section B</h2>
          <div>Loose text under B</div>
        </main>
      </body></html>
    `;

    const result = scrapePageContent(html, "https://example.com/order-test", false);
    const sequence = (result.orderedElements || []).map((el: any) => el.content);

    expect(sequence.indexOf("Section A")).toBeLessThan(sequence.indexOf("Loose text under A"));
    expect(sequence.indexOf("Loose text under A")).toBeLessThan(sequence.indexOf("Section B"));
    expect(sequence.indexOf("Section B")).toBeLessThan(sequence.indexOf("Loose text under B"));
  });

  it("still extracts ordinary <p>-wrapped content unchanged", () => {
    const html = `<html><body><main><p>A perfectly normal paragraph of real content.</p></main></body></html>`;
    const result = scrapePageContent(html, "https://example.com/plain", false);
    const paragraphs = (result.orderedElements || []).filter((el: any) => el.type === "paragraph");
    expect(paragraphs).toHaveLength(1);
    expect(paragraphs[0].content).toBe("A perfectly normal paragraph of real content.");
  });

  it("does not pull in text from skipped navigation/footer containers", () => {
    const html = `
      <html><body>
        <main>
          <div>Real loose content</div>
        </main>
        <nav><div>Home</div><div>About</div></nav>
        <footer><div>Copyright 2026</div></footer>
      </body></html>
    `;
    const result = scrapePageContent(html, "https://example.com/nav-test", false);
    const allText = (result.orderedElements || []).map((el: any) => el.content).join(" | ");
    expect(allText).toContain("Real loose content");
    expect(allText).not.toContain("Copyright 2026");
  });
});
