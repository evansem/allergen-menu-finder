import { describe, expect, it } from "vitest";
import { PoliteFetcher, RobotsDisallowed } from "../src/net/fetcher.js";
import { isAllowed, parseRobots } from "../src/net/robots.js";
import type { FetchedPage } from "../src/net/safeFetch.js";

const ROBOTS = `
User-agent: *
Disallow: /private
Allow: /private/menu.pdf

User-agent: allergen-menu-finder
Disallow: /catering
`;

describe("robots.txt", () => {
  it("uses our own group when there is one", () => {
    const rules = parseRobots(ROBOTS, "allergen-menu-finder");
    expect(isAllowed(rules, "/catering/x")).toBe(false);
    expect(isAllowed(rules, "/private")).toBe(true);
  });

  it("falls back to *, longest rule wins, Allow on a tie", () => {
    const rules = parseRobots(ROBOTS, "other-bot");
    expect(isAllowed(rules, "/private/staff")).toBe(false);
    expect(isAllowed(rules, "/private/menu.pdf")).toBe(true);
    expect(isAllowed(parseRobots("User-agent: *\nDisallow: /*.pdf$", "x"), "/a/guide.pdf")).toBe(false);
  });
});

const page = (url: string, text: string, status = 200): FetchedPage => ({
  url,
  finalUrl: url,
  status,
  contentType: "text/html",
  bytes: new TextEncoder().encode(text),
  text,
});

describe("PoliteFetcher", () => {
  it("honours robots.txt, treats 5xx as disallow-all, and counts requests", async () => {
    const calls: string[] = [];
    const f = new PoliteFetcher({
      delayMs: 0,
      maxRequests: 4,
      get: async (url) => {
        calls.push(url);
        if (url === "https://a.au/robots.txt") return page(url, "User-agent: *\nDisallow: /secret");
        if (url === "https://b.au/robots.txt") return page(url, "", 503);
        return page(url, "ok");
      },
    });
    expect((await f.fetch("https://a.au/menu")).text).toBe("ok");
    await expect(f.fetch("https://a.au/secret")).rejects.toBeInstanceOf(RobotsDisallowed);
    await expect(f.fetch("https://b.au/menu")).rejects.toBeInstanceOf(RobotsDisallowed);
    expect(calls).toEqual(["https://a.au/robots.txt", "https://a.au/menu", "https://b.au/robots.txt"]);
    await f.fetch("https://a.au/other");
    await expect(f.fetch("https://a.au/more")).rejects.toThrow(/budget/);
  });

  it("waits between requests to the same host", async () => {
    const waits: number[] = [];
    const f = new PoliteFetcher({ delayMs: 1000, respectRobots: false, get: async (url) => page(url, "ok"), sleep: async (ms) => void waits.push(ms) });
    await Promise.all([f.fetch("https://a.au/1"), f.fetch("https://a.au/2"), f.fetch("https://b.au/1")]);
    expect(waits.length).toBe(1);
    expect(waits[0]).toBeGreaterThan(900);
  });
});
