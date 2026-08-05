import { describe, it, expect } from "vitest";
import { decodeResponse } from "../utils/decode-response";

function makeResponse(buf: Buffer, contentType?: string): Response {
  return new Response(buf, {
    headers: contentType ? { "content-type": contentType } : undefined,
  });
}

describe("decodeResponse", () => {
  it("decodes Latin-1 (ISO-8859-1) bytes using the header charset, not UTF-8", async () => {
    // "Kläranlage" encoded as ISO-8859-1: 'ä' = 0xE4
    const latin1Buf = Buffer.from([0x4b, 0x6c, 0xe4, 0x72, 0x61, 0x6e, 0x6c, 0x61, 0x67, 0x65]);
    const response = makeResponse(latin1Buf, "text/html; charset=ISO-8859-1");

    const text = await decodeResponse(response);

    expect(text).toBe("Kläranlage");
    // Decoding the same bytes as UTF-8 would have produced mojibake, not this string.
    expect(text).not.toBe(new TextDecoder("utf-8").decode(latin1Buf));
  });

  it("falls back to <meta charset> when the HTTP header has none", async () => {
    const html = '<html><head><meta charset="ISO-8859-1"></head><body>Kläranlage</body></html>';
    const latin1Buf = Buffer.from(html, "latin1");
    const response = makeResponse(latin1Buf); // no content-type header at all

    const text = await decodeResponse(response);

    expect(text).toContain("Kläranlage");
  });

  it("prefers the HTTP header charset over a conflicting <meta charset>", async () => {
    // Body declares utf-8 in the markup, but the header (source of truth) says latin1.
    const html = '<html><head><meta charset="utf-8"></head><body>Kläranlage</body></html>';
    const latin1Buf = Buffer.from(html, "latin1");
    const response = makeResponse(latin1Buf, "text/html; charset=ISO-8859-1");

    const text = await decodeResponse(response);

    expect(text).toContain("Kläranlage");
  });

  it("defaults to UTF-8 when no charset information is present", async () => {
    const utf8Buf = Buffer.from("Kläranlage", "utf-8");
    const response = makeResponse(utf8Buf);

    const text = await decodeResponse(response);

    expect(text).toBe("Kläranlage");
  });
});
