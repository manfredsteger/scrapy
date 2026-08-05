// Charset-correct decoding of fetch() Response bodies.
//
// `response.text()` (undici) always decodes as UTF-8 and ignores the
// Content-Type charset parameter. Sources that mix encodings per response
// (e.g. an old Perl CGI serving ISO-8859-1 result pages alongside UTF-8
// static pages on the same domain) need per-response detection instead of a
// single global assumption.
//
// Precedence: HTTP header charset > <meta charset> in the first 2 KB > utf-8
// default (HTML5 spec default). The header wins even when it conflicts with
// the markup — trusting the markup over the header produces mojibake when
// they disagree.
export async function decodeResponse(response: Response): Promise<string> {
  const buf = Buffer.from(await response.arrayBuffer());

  // 1. Charset from the HTTP header — takes precedence
  const ct = response.headers.get('content-type') ?? '';
  let charset = /charset=["']?([\w-]+)/i.exec(ct)?.[1]?.toLowerCase();

  // 2. Fallback: <meta charset> from the first 2 KB
  if (!charset) {
    const head = buf.subarray(0, 2048).toString('latin1');
    charset = /<meta[^>]+charset=["']?([\w-]+)/i.exec(head)?.[1]?.toLowerCase();
  }

  charset ??= 'utf-8'; // HTML5 default

  try {
    return new TextDecoder(charset).decode(buf);
  } catch {
    return new TextDecoder('utf-8').decode(buf); // unknown charset label
  }
}
