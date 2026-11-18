#!/usr/bin/env -S npx tsx
import { parseArgs } from "node:util";
import { EVIDENCE_LEVELS, type EvidenceLevel } from "./domain.js";
import { run } from "./engine/dispatcher.js";
import { exportDraft } from "./export/draft.js";
import { ExplorationGraph, newId } from "./graph/graph.js";
import { RunStore } from "./graph/store.js";
import type { GoalNode, HintDirective, HintNode } from "./graph/types.js";
import { renderMermaid, renderTree } from "./graph/view.js";
import { ClaudeExtractor } from "./llm/extract.js";
import { PoliteFetcher } from "./net/fetcher.js";
import { pdfMatrixRows, pdfText } from "./vendor/pdfTable.js";

const HELP = `allergen-menu-finder: explore a venue's website for published allergen information.

Usage:
  amf explore --name <venue> --website <https url> [options]   start a run
  amf resume <run>                                              continue a run (after a hint, or when interrupted)
  amf hint <run> try <url> | skip <text> | website <url> | note <text>
  amf show <run> [--mermaid]                                    print the graph
  amf export <run>                                              write draft.json and provenance.json in the run folder

Options for explore and resume:
  --run <id>            run id (default: from the venue name)
  --address <text>      store address, copied into the draft
  --region <text>       region, for the reviewer
  --target <level>      stop once found: allergen-guide (default), labelled-menu or description-only
  --max-steps <n>       hypotheses tested per run (default 25)
  --max-requests <n>    web requests per run, robots.txt included (default 40)
  --depth <n>           link levels followed from the home page (default 2)
  --concurrency <n>     hypotheses tested at once (default 2)
  --country <au|any>    require an Australian site (default au)
  --llm                 let Claude read sources the parsers can't (needs ANTHROPIC_API_KEY)
  --ignore-robots       don't read robots.txt (only where you have the site's permission)
  --runs <dir>          where runs are kept (default ./runs)
`;

const slug = (s: string) =>
  s.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60) || "venue";

function die(message: string): never {
  console.error(message);
  process.exit(1);
}

async function main() {
  try {
    process.loadEnvFile(".env");
  } catch {
    // No .env file: credentials come from the environment, if needed at all.
  }
  const { values: v, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      name: { type: "string" },
      website: { type: "string" },
      address: { type: "string" },
      region: { type: "string" },
      run: { type: "string" },
      target: { type: "string", default: "allergen-guide" },
      "max-steps": { type: "string", default: "25" },
      "max-requests": { type: "string", default: "40" },
      depth: { type: "string", default: "2" },
      concurrency: { type: "string", default: "2" },
      country: { type: "string", default: "au" },
      llm: { type: "boolean", default: false },
      "ignore-robots": { type: "boolean", default: false },
      runs: { type: "string", default: "runs" },
      mermaid: { type: "boolean", default: false },
      author: { type: "string", default: "reviewer" },
      help: { type: "boolean", short: "h" },
    },
  });
  const [command, runId, ...rest] = positionals;
  if (v.help || !command) return console.log(HELP);
  const store = new RunStore(v.runs);

  const runIt = async (graph: ExplorationGraph) => {
    const fetcher = new PoliteFetcher({ maxRequests: Number(v["max-requests"]), respectRobots: !v["ignore-robots"] });
    const summary = await run(
      graph,
      {
        fetcher,
        pdf: { rows: pdfMatrixRows, text: pdfText },
        extractor: v.llm ? new ClaudeExtractor() : undefined,
        country: v.country === "any" ? undefined : "au",
        pages: new Map(),
      },
      {
        maxSteps: Number(v["max-steps"]),
        maxDepth: Number(v.depth),
        concurrency: Math.max(1, Number(v.concurrency)),
        llm: v.llm!,
        log: (line) => console.log(line),
      },
    );
    console.log(`\n${summary.steps} hypotheses tested, ${fetcher.requests} requests.`);
    if (summary.best?.data.type === "source-read") console.log(`Best source: ${summary.best.statement}`);
  };

  switch (command) {
    case "explore": {
      if (!v.name || !v.website) die("explore needs --name and --website");
      if (!EVIDENCE_LEVELS.includes(v.target as EvidenceLevel) || v.target === "none") die(`Unknown --target ${v.target}`);
      const id = v.run ?? slug(v.name);
      const graph = new ExplorationGraph();
      graph.addNode<GoalNode>({
        kind: "goal",
        id: newId("goal"),
        createdAt: new Date().toISOString(),
        venue: { name: v.name, website: v.website, address: v.address, region: v.region },
        target: v.target as EvidenceLevel,
      });
      store.create(id, graph);
      console.log(`Run ${id} (${store.dir(id)})\n`);
      await runIt(graph);
      break;
    }
    case "resume": {
      if (!runId) die("resume needs a run id");
      await runIt(store.open(runId));
      break;
    }
    case "hint": {
      if (!runId) die("hint needs a run id");
      const [kind, ...words] = rest;
      const arg = words.join(" ");
      let directive: HintDirective;
      if ((kind === "try" || kind === "website") && /^https:\/\//.test(arg)) directive = { kind, url: arg };
      else if (kind === "skip" && arg) directive = { kind, pattern: arg };
      else if (kind === "note" && arg) directive = { kind };
      else die("hint takes: try <https url> | skip <text> | website <https url> | note <text>");
      const graph = store.open(runId);
      graph.addNode<HintNode>({
        kind: "hint",
        id: newId("hint"),
        createdAt: new Date().toISOString(),
        text: `${kind} ${arg}`,
        directive,
        author: v.author!,
      });
      console.log(`Hint added. Run "amf resume ${runId}" to apply it.`);
      break;
    }
    case "show": {
      if (!runId) die("show needs a run id");
      const graph = ExplorationGraph.replay(store.read(runId));
      console.log(v.mermaid ? renderMermaid(graph) : renderTree(graph));
      break;
    }
    case "export": {
      if (!runId) die("export needs a run id");
      const graph = ExplorationGraph.replay(store.read(runId));
      const { draft, provenance } = exportDraft(graph);
      store.writeFile(runId, "provenance.json", `${JSON.stringify(provenance, null, 2)}\n`);
      if (!draft) die("No menu or allergen guide was found in this run; nothing to export.");
      store.writeFile(runId, "draft.json", `${JSON.stringify(draft, null, 2)}\n`);
      console.log(`Wrote ${store.dir(runId)}/draft.json (${draft.meals.length} dishes) and provenance.json`);
      break;
    }
    default:
      die(HELP);
  }
}

main().catch((e) => die(e instanceof Error ? e.message : String(e)));
