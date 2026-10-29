// Reads a fetch() response body with a hard size cap.
//
// response.arrayBuffer()/text() buffer everything; a server that sends no
// Content-Length (chunked) can stream gigabytes into memory before any size
// check runs. This aborts as soon as the cap is passed.
export const MAX_HTML_BYTES = 20 * 1024 * 1024;
export const MAX_PDF_BYTES = 50 * 1024 * 1024;
export const MAX_MEDIA_BYTES = 10 * 1024 * 1024;

export class BodyTooLargeError extends Error {
  constructor(maxBytes: number) {
    super(`Response larger than ${Math.round(maxBytes / 1024 / 1024)} MB`);
    this.name = "BodyTooLargeError";
  }
}

export async function readBodyLimited(response: Response, maxBytes: number): Promise<Buffer> {
  const declared = Number(response.headers?.get("content-length") || 0);
  if (declared > maxBytes) {
    await response.body?.cancel().catch(() => {});
    throw new BodyTooLargeError(maxBytes);
  }
  if (response.body === null) return Buffer.alloc(0);
  if (!response.body) {
    // Response-like objects without a stream (test doubles): buffer, then check.
    const buf = typeof response.arrayBuffer === "function"
      ? Buffer.from(await response.arrayBuffer())
      : Buffer.from(await response.text());
    if (buf.length > maxBytes) throw new BodyTooLargeError(maxBytes);
    return buf;
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => {});
      throw new BodyTooLargeError(maxBytes);
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks, total);
}
