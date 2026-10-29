import { describe, it, expect } from "vitest";
import { readBodyLimited, BodyTooLargeError } from "../utils/read-body";

function streamResponse(totalBytes: number, chunk = 64 * 1024, headers: Record<string, string> = {}) {
  let sent = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (sent >= totalBytes) return controller.close();
      const n = Math.min(chunk, totalBytes - sent);
      sent += n;
      controller.enqueue(new Uint8Array(n));
    },
  });
  return { res: new Response(body, { headers }), sentBytes: () => sent };
}

describe("readBodyLimited", () => {
  it("returns small bodies unchanged", async () => {
    const buf = await readBodyLimited(new Response("hallo"), 1024);
    expect(buf.toString()).toBe("hallo");
  });

  it("aborts a chunked body without Content-Length once the cap is passed", async () => {
    const { res, sentBytes } = streamResponse(50 * 1024 * 1024);
    await expect(readBodyLimited(res, 1024 * 1024)).rejects.toBeInstanceOf(BodyTooLargeError);
    expect(sentBytes()).toBeLessThan(2 * 1024 * 1024); // stopped early, not buffered fully
  });

  it("rejects early when Content-Length is already too large", async () => {
    const { res, sentBytes } = streamResponse(10, 10, { "content-length": String(10 * 1024 * 1024) });
    await expect(readBodyLimited(res, 1024)).rejects.toBeInstanceOf(BodyTooLargeError);
    expect(sentBytes()).toBeLessThanOrEqual(10);
  });
});
