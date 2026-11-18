import { createHash } from "node:crypto";
import { UserError } from "../errors.js";
import { isAllowed, parseRobots, type RobotsRules } from "./robots.js";
import { ROBOT_TOKEN, safeFetch, type FetchedPage } from "./safeFetch.js";

export type { FetchedPage } from "./safeFetch.js";

/** What explorers use to read the web. Tests pass a fake one. */
export interface Fetcher {
  fetch(url: string): Promise<FetchedPage>;
}

export const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

export class RobotsDisallowed extends UserError {
  override name = "RobotsDisallowed";
}

export class BudgetExhausted extends UserError {
  override name = "BudgetExhausted";
}

export interface PoliteOptions {
  /** Pause between requests to the same host. */
  delayMs?: number;
  /** Most requests in one run, robots.txt reads included. */
  maxRequests?: number;
  respectRobots?: boolean;
  /** Injected for tests. */
  get?: (url: string, opts?: { acceptStatus?: (s: number) => boolean }) => Promise<FetchedPage>;
  sleep?: (ms: number) => Promise<void>;
}

/**
 * Wraps the safe fetcher with the manners a crawler owes the sites it reads:
 * robots.txt, one request at a time per host with a pause between them, and a
 * per-run request budget.
 */
export class PoliteFetcher implements Fetcher {
  requests = 0;
  private robots = new Map<string, Promise<RobotsRules | { blocked: string }>>();
  private hostQueue = new Map<string, Promise<unknown>>();
  private lastHit = new Map<string, number>();
  private readonly opts: Required<Omit<PoliteOptions, "get" | "sleep">>;
  private readonly get: NonNullable<PoliteOptions["get"]>;
  private readonly sleep: NonNullable<PoliteOptions["sleep"]>;

  constructor(opts: PoliteOptions = {}) {
    this.opts = { delayMs: opts.delayMs ?? 1500, maxRequests: opts.maxRequests ?? 40, respectRobots: opts.respectRobots ?? true };
    this.get = opts.get ?? ((url, o) => safeFetch(url, o));
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  async fetch(url: string): Promise<FetchedPage> {
    const u = new URL(url);
    if (this.opts.respectRobots) {
      const rules = await this.rulesFor(u.origin);
      if ("blocked" in rules) throw new RobotsDisallowed(rules.blocked);
      if (!isAllowed(rules, `${u.pathname}${u.search}`)) throw new RobotsDisallowed(`robots.txt disallows ${u.pathname}`);
    }
    return this.queued(u.host, () => this.get(url));
  }

  private rulesFor(origin: string) {
    let rules = this.robots.get(origin);
    if (!rules) {
      rules = this.queued(new URL(origin).host, () => this.get(`${origin}/robots.txt`, { acceptStatus: (s) => s < 600 }))
        .then((page) => {
          // RFC 9309: a 4xx means no rules; a 5xx means assume everything is disallowed.
          if (page.status >= 500) return { blocked: `robots.txt answered HTTP ${page.status}, so the site is treated as off limits` };
          if (page.status >= 400) return { allow: [], disallow: [] };
          return parseRobots(page.text, ROBOT_TOKEN);
        })
        .catch((e) => {
          if (e instanceof BudgetExhausted) throw e;
          return { blocked: "robots.txt couldn't be read, so the site is treated as off limits" };
        });
      this.robots.set(origin, rules);
    }
    return rules;
  }

  private queued<T>(host: string, task: () => Promise<T>): Promise<T> {
    const run = async () => {
      if (this.requests >= this.opts.maxRequests) throw new BudgetExhausted("Request budget used up");
      const wait = (this.lastHit.get(host) ?? -Infinity) + this.opts.delayMs - Date.now();
      if (wait > 0) await this.sleep(wait);
      this.requests++;
      try {
        return await task();
      } finally {
        this.lastHit.set(host, Date.now());
      }
    };
    const previous = this.hostQueue.get(host) ?? Promise.resolve();
    const next = previous.then(run, run);
    this.hostQueue.set(host, next.catch(() => undefined));
    return next;
  }
}
