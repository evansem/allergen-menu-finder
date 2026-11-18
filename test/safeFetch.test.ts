import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { gzipSync } from "node:zlib";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { isPrivateAddress, MAX_BYTES, safeFetch } from "../src/net/safeFetch.js";

describe("isPrivateAddress", () => {
  it.each([
    "127.0.0.1", "10.1.2.3", "172.16.0.1", "192.168.1.1", "169.254.169.254", "100.64.0.1", "0.0.0.0",
    "::1", "::", "fd00::1", "fe80::1", "::ffff:127.0.0.1", "::ffff:7f00:1", "64:ff9b::a9fe:a9fe",
  ])("blocks %s", (ip) => expect(isPrivateAddress(ip)).toBe(true));

  it.each(["93.184.216.34", "8.8.8.8", "2606:4700:4700::1111"])("allows %s", (ip) => expect(isPrivateAddress(ip)).toBe(false));
});

describe("safeFetch", () => {
  let server: Server;
  let base: string;
  const local = { allowHttp: true, isBlocked: (ip: string) => ip !== "127.0.0.1" && isPrivateAddress(ip) };

  beforeAll(async () => {
    server = createServer((req, res) => {
      if (req.url === "/menu") return res.end("<h1>Menu</h1>");
      if (req.url === "/gzip") {
        res.setHeader("content-encoding", "gzip");
        return res.end(gzipSync("<h1>Zipped</h1>"));
      }
      if (req.url === "/bomb") {
        res.setHeader("content-encoding", "gzip");
        return res.end(gzipSync(Buffer.alloc(MAX_BYTES + 1, "a")));
      }
      if (req.url === "/to-metadata") {
        res.writeHead(302, { location: "http://169.254.169.254/latest/meta-data/" });
        return res.end();
      }
      res.writeHead(404).end("missing");
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => new Promise<void>((r) => server.close(() => r())));

  it("reads only https unless a test allows http", async () => {
    await expect(safeFetch(`${base}/menu`)).rejects.toThrow(/Only https/);
    await expect(safeFetch("file:///etc/passwd")).rejects.toThrow(/Only https/);
  });

  it("refuses loopback, including by hostname", async () => {
    await expect(safeFetch(`${base}/menu`, { allowHttp: true })).rejects.toThrow(/private network/);
    await expect(safeFetch(`${base.replace("127.0.0.1", "localhost")}/menu`, { allowHttp: true })).rejects.toThrow(/private network/);
  });

  it("downloads and decompresses", async () => {
    expect((await safeFetch(`${base}/menu`, local)).text).toBe("<h1>Menu</h1>");
    expect((await safeFetch(`${base}/gzip`, local)).text).toBe("<h1>Zipped</h1>");
  });

  it("re-checks every redirect hop and caps the decompressed size", async () => {
    await expect(safeFetch(`${base}/to-metadata`, local)).rejects.toThrow(/private network/);
    await expect(safeFetch(`${base}/bomb`, local)).rejects.toThrow(/too large/);
  });

  it("returns error statuses only when asked", async () => {
    await expect(safeFetch(`${base}/missing`, local)).rejects.toThrow(/HTTP 404/);
    expect((await safeFetch(`${base}/missing`, { ...local, acceptStatus: () => true })).status).toBe(404);
  });
});
