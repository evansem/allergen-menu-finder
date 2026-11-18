import { lookup as dnsLookup, type LookupAddress, type LookupOptions } from "node:dns";
import { request as httpRequest, type IncomingMessage } from "node:http";
import { request as httpsRequest } from "node:https";
import { BlockList, isIP } from "node:net";
import { createBrotliDecompress, createGunzip, createInflate } from "node:zlib";
import type { Readable } from "node:stream";
import { UserError } from "../errors.js";

export const MAX_BYTES = 10_000_000;
const TIMEOUT_MS = 15_000;
const MAX_REDIRECTS = 5;
/** Identifies the tool to site owners; robots.txt rules for this token are honoured. */
export const ROBOT_TOKEN = "allergen-menu-finder";
export const USER_AGENT = `${ROBOT_TOKEN}/0.1 (+https://github.com/evansem/allergen-menu-finder)`;

/** Addresses the server must never fetch on an admin's behalf (RFC 6890 special-purpose ranges). */
const blocked = new BlockList();
for (const [net, prefix] of [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8], ["169.254.0.0", 16], ["172.16.0.0", 12],
  ["192.0.0.0", 24], ["192.0.2.0", 24], ["192.88.99.0", 24], ["192.168.0.0", 16], ["198.18.0.0", 15],
  ["198.51.100.0", 24], ["203.0.113.0", 24], ["224.0.0.0", 4], ["240.0.0.0", 4],
] as const) blocked.addSubnet(net, prefix, "ipv4");
for (const [net, prefix] of [
  ["::", 96], // unspecified, loopback and IPv4-compatible
  ["64:ff9b::", 96], ["64:ff9b:1::", 48], // NAT64
  ["100::", 64], ["2001::", 32], ["2001:db8::", 32], ["2002::", 16], // discard, Teredo, documentation, 6to4
  ["fc00::", 7], ["fe80::", 10], ["ff00::", 8], // unique local, link-local, multicast
] as const) blocked.addSubnet(net, prefix, "ipv6");

/** `::ffff:a.b.c.d` in any spelling (including hex `::ffff:7f00:1`) → `a.b.c.d`. */
function mappedIPv4(ip: string): string | undefined {
  let normal: string;
  try {
    normal = new URL(`http://[${ip}]`).hostname.slice(1, -1).toLowerCase();
  } catch {
    return undefined;
  }
  const m = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(normal);
  if (!m) return undefined;
  const [hi, lo] = [parseInt(m[1], 16), parseInt(m[2], 16)];
  return [hi >> 8, hi & 255, lo >> 8, lo & 255].join(".");
}

export function isPrivateAddress(ip: string): boolean {
  const family = isIP(ip);
  if (family === 4) return blocked.check(ip, "ipv4");
  if (family === 6) {
    const v4 = mappedIPv4(ip);
    return v4 ? blocked.check(v4, "ipv4") : blocked.check(ip, "ipv6");
  }
  return true;
}

type LookupCallback = (err: NodeJS.ErrnoException | null, address: string | LookupAddress[], family?: number) => void;

/**
 * Resolves and vets the host inside the connection itself, so the address that
 * was checked is the address that is connected to (no DNS rebinding window).
 */
const safeLookup = (isBlocked: (ip: string) => boolean) => (hostname: string, options: LookupOptions, callback: LookupCallback) => {
  dnsLookup(hostname, { ...options, all: true }, (err, addresses) => {
    if (err) return callback(err, []);
    if (!addresses.length || addresses.some((a) => isBlocked(a.address))) {
      return callback(new UserError("Refusing to fetch a private network address"), []);
    }
    if (options.all) callback(null, addresses);
    else callback(null, addresses[0].address, addresses[0].family);
  });
};

function decoded(res: IncomingMessage): Readable {
  switch (res.headers["content-encoding"]) {
    case "gzip":
    case "x-gzip":
      return res.pipe(createGunzip());
    case "deflate":
      return res.pipe(createInflate());
    case "br":
      return res.pipe(createBrotliDecompress());
    default:
      return res;
  }
}

interface Hop {
  status: number;
  location?: string;
  contentType: string;
  body?: Buffer;
}

function get(url: URL, signal: AbortSignal, isBlocked: (ip: string) => boolean): Promise<Hop> {
  return new Promise((resolve, reject) => {
    const request = url.protocol === "https:" ? httpsRequest : httpRequest;
    const req = request(
      url,
      {
        method: "GET",
        lookup: safeLookup(isBlocked) as never,
        signal,
        headers: {
          "user-agent": USER_AGENT,
          accept: "text/html,application/xhtml+xml,application/pdf,text/plain;q=0.9,*/*;q=0.5",
          "accept-encoding": "gzip, deflate, br",
        },
      },
      (res) => {
        const status = res.statusCode ?? 0;
        const contentType = String(res.headers["content-type"] ?? "");
        if (status >= 300 && status < 400) {
          res.resume();
          return resolve({ status, location: res.headers.location, contentType });
        }
        const declared = Number(res.headers["content-length"]);
        if (declared > MAX_BYTES) {
          req.destroy();
          return reject(new UserError("The page is too large"));
        }
        const chunks: Buffer[] = [];
        let size = 0;
        const body = decoded(res);
        body.on("data", (chunk: Buffer) => {
          size += chunk.length;
          // Counted after decompression, so a small compressed bomb can't exhaust memory.
          if (size > MAX_BYTES) {
            req.destroy();
            body.destroy();
            reject(new UserError("The page is too large"));
          } else chunks.push(chunk);
        });
        body.on("end", () => resolve({ status, contentType, body: Buffer.concat(chunks) }));
        body.on("error", reject);
      },
    );
    req.on("error", reject);
    req.end();
  });
}

export interface FetchedPage {
  url: string;
  finalUrl: string;
  status: number;
  contentType: string;
  bytes: Uint8Array;
  text: string;
}

/**
 * Downloads a public page or document. Only https is read (http only when a
 * test allows it). Any host that is, or resolves to, a private or
 * special-purpose address is refused on every redirect hop, checked at
 * connection time so DNS rebinding can't get around it. Bodies are capped
 * after decompression.
 */
export async function safeFetch(
  url: string,
  {
    isBlocked = isPrivateAddress,
    allowHttp = false,
    acceptStatus = (s: number) => s >= 200 && s < 300,
  }: {
    /** Only tests override this, to reach a local server. */
    isBlocked?: (ip: string) => boolean;
    allowHttp?: boolean;
    /** robots.txt reads want 4xx answers back rather than an error. */
    acceptStatus?: (status: number) => boolean;
  } = {},
): Promise<FetchedPage> {
  const signal = AbortSignal.timeout(TIMEOUT_MS);
  let current = new URL(url);
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    if (current.protocol !== "https:" && !(allowHttp && current.protocol === "http:")) throw new UserError("Only https URLs are read");
    if (current.username || current.password) throw new UserError("URLs with credentials are refused");
    // Literal IPs never reach the lookup hook, so they are checked here.
    const host = current.hostname.replace(/^\[|\]$/g, "");
    if (isIP(host) && isBlocked(host)) throw new UserError("Refusing to fetch a private network address");

    let res: Hop;
    try {
      res = await get(current, signal, isBlocked);
    } catch (e) {
      if (e instanceof UserError) throw e;
      if (signal.aborted) throw new UserError("The page took too long to respond");
      throw new UserError("Couldn't download that page");
    }
    if (res.status >= 300 && res.status < 400 && res.location) {
      current = new URL(res.location, current);
      continue;
    }
    if (!acceptStatus(res.status)) throw new UserError(`HTTP ${res.status}`);
    const bytes = new Uint8Array(res.body ?? []);
    return { url, finalUrl: current.toString(), status: res.status, contentType: res.contentType, bytes, text: new TextDecoder().decode(bytes) };
  }
  throw new UserError("Too many redirects");
}
