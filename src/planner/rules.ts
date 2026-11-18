import { evidenceRank, type EvidenceLevel } from "../domain.js";
import { actionKey, type ExplorationGraph } from "../graph/graph.js";
import type { Action, ActionType, HintNode, HypothesisNode } from "../graph/types.js";

/** A hypothesis the planner wants added, with the nodes it came from. */
export interface Proposal {
  statement: string;
  action: Action;
  prior: number;
  expected: EvidenceLevel;
  proposedBy: HypothesisNode["proposedBy"];
  /** Goal or fact ids that led to it ("derives" edges), and hint ids ("steers" edges). */
  derivedFrom: string[];
  steeredBy?: string[];
}

export interface Plan {
  proposals: Proposal[];
  /** Open hypotheses a hint says to skip. */
  abandon: Array<{ id: string; hintId: string }>;
  complete?: { reason: string; factId?: string };
}

export interface PlannerOptions {
  maxDepth: number;
  llm: boolean;
}

/** Relative cost of each action, in fetches and model calls. */
export const COST: Record<ActionType, number> = { "check-site": 1, "read-page": 1, "read-pdf": 1.5, "llm-extract": 4 };

/**
 * Which open hypothesis to test next: likely ones that could yield strong
 * evidence cheaply, close to the venue's home page.
 */
export function score(h: HypothesisNode): number {
  const depth = "depth" in h.action ? h.action.depth : 0;
  return (h.prior * (1 + evidenceRank(h.expected))) / COST[h.action.type] / (1 + 0.25 * depth);
}

const matchesSkip = (hint: HintNode, url: string) => hint.directive.kind === "skip" && url.includes(hint.directive.pattern);

/**
 * The rule-based planner. It reads the whole graph and returns what to add,
 * so it holds no state of its own: running it twice proposes nothing new,
 * because every action already in the graph is skipped.
 */
export function planFromRules(graph: ExplorationGraph, opts: PlannerOptions): Plan {
  const goal = graph.goal;
  const hints = graph.hints();
  const skips = hints.filter((h) => h.directive.kind === "skip");
  const proposals: Proposal[] = [];
  const seen = new Set<string>();
  const propose = (p: Proposal) => {
    const key = actionKey(p.action);
    if (graph.hasAction(p.action) || seen.has(key)) return;
    if (skips.some((s) => matchesSkip(s, p.action.url))) return;
    seen.add(key);
    proposals.push(p);
  };

  const best = graph.bestSource();
  if (best?.data.type === "source-read" && evidenceRank(best.data.level) >= evidenceRank(goal.target)) {
    return { proposals: [], abandon: [], complete: { reason: `found a ${best.data.level} source`, factId: best.id } };
  }

  // The venue's website: from a hint if a person gave one, else from the goal.
  const websiteHint = hints.findLast((h) => h.directive.kind === "website");
  const website = websiteHint?.directive.kind === "website" ? websiteHint.directive.url : goal.venue.website;
  if (website) {
    propose({
      statement: `${website} is ${goal.venue.name}'s own live website`,
      action: { type: "check-site", url: website },
      prior: 0.9,
      expected: "labelled-menu",
      proposedBy: websiteHint ? "hint" : "rules",
      derivedFrom: [goal.id],
      ...(websiteHint && { steeredBy: [websiteHint.id] }),
    });
  }

  for (const hint of hints) {
    if (hint.directive.kind !== "try") continue;
    // Each "try" hint creates one hypothesis; if the URL was already tried, it is tried again.
    if (graph.children(hint.id).length) continue;
    const url = hint.directive.url;
    const type = /\.pdf($|\?)/i.test(url) ? "read-pdf" : "read-page";
    const earlier = graph.hypotheses().filter((h) => h.action.type === type && actionKey({ ...h.action, attempt: undefined }) === actionKey({ type, url, depth: 0 }));
    const attempt = earlier.length ? Math.max(...earlier.map((h) => h.action.attempt ?? 1)) + 1 : undefined;
    propose({
      statement: `${url} has ${goal.venue.name}'s menu or allergen guide (a person suggested it)`,
      action: { type, url, depth: 0, ...(attempt && { attempt }) },
      prior: 0.95,
      expected: "allergen-guide",
      proposedBy: "hint",
      derivedFrom: [goal.id],
      steeredBy: [hint.id],
    });
  }

  for (const fact of graph.facts()) {
    const d = fact.data;
    const tested = graph.testedBy(fact.id);
    const depth = tested && "depth" in tested.action ? tested.action.depth : 0;

    if (d.type === "links-found" && depth < opts.maxDepth) {
      for (const link of d.links) {
        propose({
          statement: link.guide
            ? `"${link.label || link.url}" is an allergen guide`
            : `"${link.label || link.url}" is a menu with diet labels`,
          action: { type: link.pdf ? "read-pdf" : "read-page", url: link.url, depth: depth + 1 },
          prior: link.guide ? (link.pdf ? 0.8 : 0.7) : link.pdf ? 0.55 : 0.45,
          expected: link.guide ? "allergen-guide" : "labelled-menu",
          proposedBy: "rules",
          derivedFrom: [fact.id],
        });
      }
    }

    // The parsers failed, or read only descriptions, where the text suggests more is there: ask the LLM.
    if (!opts.llm) continue;
    const parserGaveUp = d.type === "not-useful" && (d.format === "pdf" ? (d.textLength ?? 0) > 200 : d.mentionsAllergens && (d.textLength ?? 0) > 500);
    const weakRead = d.type === "source-read" && d.method !== "llm" && d.level === "description-only" && d.format === "pdf";
    if (parserGaveUp || weakRead) {
      const url = d.url;
      propose({
        statement: `An LLM can read the dishes and allergens at ${url} that the parsers missed`,
        action: { type: "llm-extract", url, depth },
        prior: d.type === "not-useful" && d.mentionsAllergens ? 0.6 : 0.4,
        expected: d.type === "not-useful" && d.mentionsAllergens ? "allergen-guide" : "labelled-menu",
        proposedBy: "rules",
        derivedFrom: [fact.id],
      });
    }
  }

  const abandon = graph
    .hypotheses("open")
    .flatMap((h) => {
      const hint = skips.find((s) => matchesSkip(s, h.action.url));
      return hint ? [{ id: h.id, hintId: hint.id }] : [];
    });

  return { proposals, abandon };
}
