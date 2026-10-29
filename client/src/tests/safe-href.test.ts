import { describe, it, expect } from "vitest";
import { safeHref } from "@/lib/utils";

describe("safeHref", () => {
  it("keeps http and https links", () => {
    expect(safeHref("https://example.com/a.pdf")).toBe("https://example.com/a.pdf");
    expect(safeHref("http://example.com/")).toBe("http://example.com/");
  });

  it("drops script and data URLs from scraped content", () => {
    expect(safeHref("javascript:alert(1)//x.pdf")).toBeUndefined();
    expect(safeHref(" JavaScript:alert(1)")).toBeUndefined();
    expect(safeHref("data:text/html,<script>alert(1)</script>")).toBeUndefined();
  });

  it("handles empty values", () => {
    expect(safeHref(undefined)).toBeUndefined();
    expect(safeHref("")).toBeUndefined();
  });
});
