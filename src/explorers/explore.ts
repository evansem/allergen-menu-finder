import type { Action, Evidence, FactData } from "../graph/types.js";
import { BudgetExhausted, RobotsDisallowed, sha256, type FetchedPage, type Fetcher } from "../net/fetcher.js";
import { verifyExtraction, type Extractor } from "../llm/extract.js";
import { checkSite, pageText, readHtml, readPdf, type PdfReader } from "./read.js";

export interface ExploreContext {
  fetcher: Fetcher;
  pdf: PdfReader;
  extractor?: Extractor;
  country?: "au";
  /** Pages already read in this run, so a second look (an LLM read) doesn't fetch again. */
  pages: Map<string, FetchedPage>;
}

export interface Observation {
  statement: string;
  data: FactData;
  evidence?: Evidence;
}

export interface ExploreResult {
  observations: Observation[];
  outcome: "supported" | "refuted";
  reason: string;
}

const isPdf = (page: FetchedPage) => page.contentType.includes("pdf") || /\.pdf($|\?)/i.test(page.finalUrl);

function evidenceOf(page: FetchedPage): Evidence {
  return { url: page.finalUrl, fetchedAt: new Date().toISOString(), contentHash: sha256(page.bytes), contentType: page.contentType };
}

export function describe(data: FactData): string {
  switch (data.type) {
    case "site-verified":
      return `${data.finalUrl} is the venue's live site`;
    case "site-rejected":
      return `${data.url} was rejected: ${data.reason}`;
    case "links-found":
      return `${data.from} links to ${data.links.length} possible menu or allergen page(s)`;
    case "source-read":
      return `${data.url} holds ${data.dishes.length} dishes (${data.level}, ${data.labelled} labelled, read by ${data.method})`;
    case "not-useful":
      return `${data.url}: ${data.reason}`;
    case "fetch-failed":
      return `${data.url} couldn't be read: ${data.reason}`;
  }
}

const observe = (data: FactData, evidence?: Evidence): Observation => ({ statement: describe(data), data, ...(evidence && { evidence }) });

async function load(url: string, ctx: ExploreContext): Promise<FetchedPage> {
  const cached = ctx.pages.get(url);
  if (cached) return cached;
  const page = await ctx.fetcher.fetch(url);
  ctx.pages.set(url, page);
  return page;
}

/** Runs the action a hypothesis names and reports what was observed. */
export async function explore(action: Action, ctx: ExploreContext): Promise<ExploreResult> {
  let page: FetchedPage;
  try {
    page = await load(action.url, ctx);
  } catch (e) {
    if (e instanceof BudgetExhausted) throw e;
    const reason = e instanceof RobotsDisallowed ? e.message : e instanceof Error ? e.message : "unknown error";
    return { observations: [observe({ type: "fetch-failed", url: action.url, reason })], outcome: "refuted", reason };
  }
  const evidence = evidenceOf(page);

  switch (action.type) {
    case "check-site": {
      const problem = checkSite(action.url, page.finalUrl, page.text, ctx.country);
      if (problem) {
        return { observations: [observe({ type: "site-rejected", url: action.url, reason: problem }, evidence)], outcome: "refuted", reason: problem };
      }
      const observations = [observe({ type: "site-verified", url: action.url, finalUrl: page.finalUrl }, evidence)];
      observations.push(...readHtml(page.finalUrl, page.text).map((d) => observe(d, evidence)));
      return { observations, outcome: "supported", reason: "home page checks out" };
    }
    case "read-page":
    case "read-pdf": {
      const facts = isPdf(page) ? await readPdf(page.finalUrl, page.bytes, ctx.pdf) : readHtml(page.finalUrl, page.text);
      const read = facts.some((f) => f.type === "source-read");
      return {
        observations: facts.map((d) => observe(d, evidence)),
        outcome: read ? "supported" : "refuted",
        reason: read ? "a menu or allergen guide was read" : "nothing readable as a menu",
      };
    }
    case "llm-extract": {
      if (!ctx.extractor) return { observations: [], outcome: "refuted", reason: "no LLM configured" };
      const pdf = isPdf(page);
      const text = pdf ? await ctx.pdf.text(page.bytes).catch(() => "") : pageText(page.text);
      try {
        const x = await ctx.extractor.extract({ url: page.finalUrl, format: pdf ? "pdf" : "html", text, pdfBytes: pdf ? page.bytes : undefined });
        const data = verifyExtraction(page.finalUrl, pdf ? "pdf" : "html", x, text);
        return {
          observations: [observe(data, evidence)],
          outcome: data.type === "source-read" ? "supported" : "refuted",
          reason: data.type === "source-read" ? "the LLM read dishes backed by quotes" : "the LLM found nothing it could quote",
        };
      } catch (e) {
        const reason = e instanceof Error ? e.message : "LLM extraction failed";
        return { observations: [observe({ type: "not-useful", url: page.finalUrl, reason })], outcome: "refuted", reason };
      }
    }
  }
}
