// Blocks outgoing requests to internal addresses (SSRF protection).
//
// The scraper fetches URLs that users enter and that scraped pages link to
// (PDFs, images, <base href>, redirects). Without a guard a page could make
// the server fetch http://169.254.169.254/ (cloud metadata), http://db:5432
// or anything else on the internal network, and the result would be saved
// and downloadable.
//
// The check runs in the connection layer, so it covers every fetch() in the
// process, including each hop of a redirect, and the socket connects to the
// exact IP that was checked (no DNS-rebinding window).
//
// Set SCRAPER_ALLOW_PRIVATE_HOSTS=true to scrape intranet sites on purpose.
import dns from "dns";
import net from "net";
import { Agent, buildConnector, setGlobalDispatcher } from "undici";

const blocked = new net.BlockList();
for (const [addr, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
] as const) {
  blocked.addSubnet(addr, prefix, "ipv4");
}
for (const [addr, prefix] of [
  ["::", 128],
  ["::1", 128],
  ["fc00::", 7],
  ["fe80::", 10],
  ["ff00::", 8],
] as const) {
  blocked.addSubnet(addr, prefix, "ipv6");
}

export function isBlockedAddress(ip: string): boolean {
  const family = net.isIP(ip);
  if (family === 4) return blocked.check(ip, "ipv4");
  if (family === 6) {
    // IPv4-mapped IPv6 (::ffff:127.0.0.1) must be judged as IPv4.
    const mapped = ip.toLowerCase().match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped) return blocked.check(mapped[1], "ipv4");
    return blocked.check(ip, "ipv6");
  }
  return true; // not an IP at all: refuse
}

export class BlockedAddressError extends Error {
  constructor(host: string, ip: string) {
    super(`Blocked request to internal address ${host} (${ip})`);
    this.name = "BlockedAddressError";
  }
}

async function resolvePublic(host: string): Promise<string> {
  const bare = host.replace(/^\[|\]$/g, "");
  if (net.isIP(bare)) {
    if (isBlockedAddress(bare)) throw new BlockedAddressError(host, bare);
    return bare;
  }
  const addrs = await dns.promises.lookup(bare, { all: true, verbatim: true });
  if (addrs.length === 0) throw new Error(`DNS lookup returned no address for ${host}`);
  // Reject if ANY answer is internal, so round-robin tricks don't slip through.
  for (const a of addrs) {
    if (isBlockedAddress(a.address)) throw new BlockedAddressError(host, a.address);
  }
  return addrs[0].address;
}

export function createSafeAgent(): Agent {
  const baseConnect = buildConnector({});
  return new Agent({
    connect(opts, callback) {
      resolvePublic(opts.hostname).then(
        (ip) => {
          // Connect to the checked IP; keep the name for TLS SNI/certificate.
          const servername = opts.servername || (net.isIP(opts.hostname.replace(/^\[|\]$/g, "")) ? undefined : opts.hostname);
          baseConnect({ ...opts, hostname: ip, servername } as any, callback);
        },
        (err) => callback(err, null),
      );
    },
  });
}

export function installSafeFetch(env: NodeJS.ProcessEnv = process.env) {
  if (env.SCRAPER_ALLOW_PRIVATE_HOSTS === "true") {
    console.warn("[SafeFetch] SCRAPER_ALLOW_PRIVATE_HOSTS=true: interne Adressen sind erlaubt.");
    return;
  }
  setGlobalDispatcher(createSafeAgent());
}
