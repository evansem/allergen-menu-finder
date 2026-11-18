import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { run } from "../src/engine/dispatcher.js";
import { exportDraft } from "../src/export/draft.js";
import type { ExploreContext } from "../src/explorers/explore.js";
import { ExplorationGraph, newId } from "../src/graph/graph.js";
import { RunStore } from "../src/graph/store.js";
import type { GoalNode, HintNode } from "../src/graph/types.js";
import type { Extraction, Extractor } from "../src/llm/extract.js";
import type { FetchedPage, Fetcher } from "../src/net/fetcher.js";

const fixture = (name: string) => readFileSync(join(import.meta.dirname, "fixtures", "cafe", name), "utf8");
const SITE = "https://www.kowhai.com.au/";
const GUIDE = "https://cdn.example-assets.com/kowhai/allergen-guide.pdf";

const GUIDE_ROWS = [
  ["Item", "Gluten", "Egg", "Milk", "Peanut", "Soy", "Sesame", "Fish", "Crustacea"],
  ["Smashed avocado", "", "", "Y", "", "", "", "", ""],
  ["Bircher muesli", "Y", "", "Y", "", "", "", "", ""],
  ["Tofu scramble", "", "", "", "", "Y", "M", "", ""],
  ["Eggs benedict", "Y", "Y", "Y", "", "", "", "", ""],
  ["Prawn omelette", "", "Y", "", "", "", "", "", "Y"],
  ["Satay chicken bowl", "", "", "", "Y", "Y", "", "", ""],
];

function site(pages: Record<string, { body: string; type?: string }>): Fetcher & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    async fetch(url: string): Promise<FetchedPage> {
      calls.push(url);
      const p = pages[url];
      if (!p) throw new Error("HTTP 404");
      const bytes = new TextEncoder().encode(p.body);
      return { url, finalUrl: url, status: 200, contentType: p.type ?? "text/html", bytes, text: p.body };
    },
  };
}

const PAGES = {
  [SITE]: { body: fixture("home.html") },
  [`${SITE}menu`]: { body: fixture("menu.html") },
  [GUIDE]: { body: "%PDF guide", type: "application/pdf" },
};

function newGraph(target: GoalNode["target"] = "allergen-guide") {
  const g = new ExplorationGraph();
  g.addNode<GoalNode>({ kind: "goal", id: newId("goal"), createdAt: new Date().toISOString(), venue: { name: "Kōwhai Kitchen", website: SITE }, target });
  return g;
}

const ctx = (fetcher: Fetcher, over: Partial<ExploreContext> = {}): ExploreContext => ({
  fetcher,
  pdf: { rows: async () => GUIDE_ROWS, text: async () => "" },
  country: "au",
  pages: new Map(),
  ...over,
});

const opts = { maxSteps: 10, maxDepth: 2, concurrency: 1, llm: false };

describe("exploration", () => {
  it("follows the allergen guide link first and stops when it is read", async () => {
    const g = newGraph();
    const f = site(PAGES);
    const summary = await run(g, ctx(f), opts);
    expect(summary.reason).toBe("found a allergen-guide source");
    expect(f.calls).toEqual([SITE, GUIDE]);
    // The wine list, careers page and Instagram were never proposed.
    expect(g.hypotheses().map((h) => h.action.url).sort()).toEqual([GUIDE, SITE, `${SITE}menu`].sort());
    expect(g.status.get(g.hypotheses().find((h) => h.action.url === `${SITE}menu`)!.id)).toBe("open");

    const { draft, provenance } = exportDraft(g);
    expect(draft!.meals).toHaveLength(6);
    const prawn = draft!.meals.find((m) => m.name === "Prawn omelette")!;
    expect(prawn.extraction.coveredTags).toContain("crustaceans");
    expect(prawn.ingredients.flatMap((i) => i.contains)).toEqual(expect.arrayContaining(["egg", "crustaceans"]));
    expect(draft!.meals.find((m) => m.name === "Tofu scramble")!.mayContain).toEqual(["sesame"]);
    expect(provenance.path.map((n) => n.kind)).toEqual(["goal", "hypothesis", "fact", "hypothesis", "fact"]);
    expect(provenance.source!.contentHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("settles for a labelled menu when a hint rules the guide out", async () => {
    const g = newGraph();
    g.addNode<HintNode>({ kind: "hint", id: newId("hint"), createdAt: new Date().toISOString(), text: "skip allergen-guide.pdf", directive: { kind: "skip", pattern: "allergen-guide.pdf" }, author: "test" });
    const summary = await run(g, ctx(site(PAGES)), opts);
    expect(summary.reason).toMatch(/nothing left to try; kept the best source/);
    expect(summary.best!.data.type === "source-read" && summary.best!.data.level).toBe("labelled-menu");
    const { draft } = exportDraft(g);
    expect(draft!.meals.find((m) => m.name === "Tofu scramble")!.claims).toEqual(expect.arrayContaining(["vegan", "gluten-free"]));
    // Keyword inference still flags what the menu describes.
    expect(draft!.meals.find((m) => m.name === "Satay chicken bowl")!.ingredients.flatMap((i) => i.contains)).toContain("peanuts");
  });

  it("refutes a website that redirects elsewhere and records why", async () => {
    const g = newGraph();
    const f: Fetcher = {
      fetch: async (url) => ({ url, finalUrl: "https://parked-domains.example.com/", status: 200, contentType: "text/html", bytes: new Uint8Array(), text: "" }),
    };
    const summary = await run(g, ctx(f), opts);
    expect(summary.reason).toBe("nothing left to try; no source found");
    expect(g.facts()[0].data).toMatchObject({ type: "site-rejected", reason: "redirected to parked-domains.example.com" });
  });

  it("asks the LLM only when the parsers give up, and keeps only quoted data", async () => {
    const guideText =
      "Allergen guide. Please tell our staff about any allergy before ordering; our kitchen handles all major allergens. " +
      "Key: VG = vegan. Tofu scramble VG — tofu, turmeric. Eggs benedict contains egg, milk, gluten. Seasonal dishes change weekly.";
    const extraction: Extraction = {
      kind: "labelled-menu",
      dietKey: [{ code: "VG", diet: "vegan", quote: "VG = vegan" }],
      guideColumns: [],
      dishes: [
        { name: "Tofu scramble", section: "Breakfast", description: null, price: null, claims: ["vegan", "gluten-free"], contains: [], mayContain: [], quote: "Tofu scramble VG — tofu, turmeric" },
        { name: "Eggs benedict", section: "Breakfast", description: null, price: null, claims: [], contains: ["egg", "milk", "gluten"], mayContain: [], quote: "Eggs benedict contains egg, milk, gluten" },
        { name: "Invented pancakes", section: "Breakfast", description: null, price: null, claims: ["vegan"], contains: [], mayContain: [], quote: "Invented pancakes VG" },
      ],
    };
    const seen: string[] = [];
    const extractor: Extractor = { extract: async (input) => (seen.push(input.url), extraction) };
    const g = newGraph();
    await run(g, ctx(site(PAGES), { extractor, pdf: { rows: async () => [], text: async () => guideText } }), { ...opts, llm: true });

    expect(seen).toEqual([GUIDE]);
    const llmFact = g.facts().find((f) => f.data.type === "source-read" && f.data.method === "llm")!;
    if (llmFact.data.type !== "source-read") throw new Error("expected a source");
    expect(llmFact.data.dishes.map((d) => d.name)).toEqual(["Tofu scramble", "Eggs benedict"]);
    // "vegan" is defined in the key; "gluten-free" isn't supported by anything in the source.
    expect(llmFact.data.dishes[0].claims).toEqual(["vegan"]);
    expect(llmFact.data.notes.join(" ")).toMatch(/1 dish\(es\) dropped/);
    expect(llmFact.data.dishes[1].allergens!.contains).toEqual(["egg", "milk", "gluten"]);
  });

  it("stores the log, takes a hint and resumes", async () => {
    const store = new RunStore(mkdtempSync(join(tmpdir(), "amf-")));
    const g = newGraph();
    store.create("kowhai", g);
    const pages = { [SITE]: PAGES[SITE] };
    await run(g, ctx(site(pages)), opts);
    expect(store.open("kowhai").completed?.reason).toBe("nothing left to try; no source found");

    const resumed = store.open("kowhai");
    resumed.addNode<HintNode>({ kind: "hint", id: newId("hint"), createdAt: new Date(Date.now() + 1000).toISOString(), text: "try menu", directive: { kind: "try", url: `${SITE}menu` }, author: "test" });
    await run(resumed, ctx(site({ ...pages, [`${SITE}menu`]: PAGES[`${SITE}menu`] })), opts);
    const final = ExplorationGraph.replay(store.read("kowhai"));
    expect(final.bestSource()?.data).toMatchObject({ type: "source-read", level: "labelled-menu" });
    expect(final.events.filter((e) => e.type === "reopen")).toHaveLength(1);
    expect(final.edges.some((e) => e.type === "steers")).toBe(true);
  });
});
