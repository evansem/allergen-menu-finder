import type { EvidenceLevel, IngredientTag } from "../domain.js";

/**
 * The exploration graph has four kinds of node:
 *
 * - goal        what we are looking for: one venue's published allergen information.
 * - hypothesis  a testable guess about where that information is ("the PDF linked
 *               as 'Allergens' is an allergen matrix"), with the action that tests it.
 * - fact        what an action actually observed, with the evidence for it. Facts
 *               never change once written.
 * - hint        a person's steer ("try this URL", "skip /catering"), applied the
 *               next time the planner reads the graph.
 *
 * Edges record why each node exists, so every dish in an export can be traced
 * back through the facts and hypotheses that led to it.
 */
export type NodeKind = "goal" | "hypothesis" | "fact" | "hint";

export interface Venue {
  name: string;
  website?: string;
  address?: string;
  region?: string;
}

export interface GoalNode {
  kind: "goal";
  id: string;
  createdAt: string;
  venue: Venue;
  /** Exploration stops once a source at this level is found. */
  target: EvidenceLevel;
}

/** What a hypothesis asks an explorer to do. `url` is always a URL already seen in the graph or given by a person. */
export type Action = (
  | { type: "check-site"; url: string }
  | { type: "read-page"; url: string; depth: number }
  | { type: "read-pdf"; url: string; depth: number }
  | { type: "llm-extract"; url: string; depth: number }
) & {
  /** Set when a person asks for an action already tried to be tried again. */
  attempt?: number;
};

export type ActionType = Action["type"];

export type HypothesisStatus = "open" | "claimed" | "supported" | "refuted" | "abandoned";

export interface HypothesisNode {
  kind: "hypothesis";
  id: string;
  createdAt: string;
  statement: string;
  action: Action;
  /** How likely the planner thinks the hypothesis is, 0 to 1. */
  prior: number;
  /** The best evidence level testing it could produce. */
  expected: EvidenceLevel;
  /** Who proposed it: "rules", "llm" or "hint". */
  proposedBy: "rules" | "llm" | "hint";
}

export interface Evidence {
  url: string;
  fetchedAt: string;
  /** sha256 of the bytes read, so a later refresh can tell whether the source changed. */
  contentHash: string;
  contentType?: string;
}

/** A dish as a source states it. Every quote has been checked to appear in the source. */
export interface ObservedDish {
  name: string;
  section: string;
  description?: string;
  price?: string;
  claims?: string[];
  /** From an allergen guide: authoritative for the `covered` tags. */
  allergens?: { contains: IngredientTag[]; mayContain: IngredientTag[]; covered: IngredientTag[] };
  /** Verbatim text from the source that supports the dish's allergen or diet data. */
  quotes?: string[];
}

export type FactData =
  | { type: "site-verified"; url: string; finalUrl: string }
  | { type: "site-rejected"; url: string; reason: string }
  | { type: "links-found"; from: string; links: FoundLink[] }
  | {
      type: "source-read";
      url: string;
      format: "html" | "pdf" | "text";
      method: string;
      level: EvidenceLevel;
      dishes: ObservedDish[];
      labelled: number;
      notes: string[];
    }
  | { type: "not-useful"; url: string; reason: string; textLength?: number; mentionsAllergens?: boolean; format?: "html" | "pdf" }
  | { type: "fetch-failed"; url: string; reason: string };

export type FactType = FactData["type"];

export interface FoundLink {
  url: string;
  label: string;
  pdf: boolean;
  /** The link's text or path mentions allergens, allergy, dietary or nutrition. */
  guide: boolean;
}

export interface FactNode {
  kind: "fact";
  id: string;
  createdAt: string;
  statement: string;
  data: FactData;
  evidence?: Evidence;
}

export type HintDirective =
  | { kind: "try"; url: string }
  | { kind: "skip"; pattern: string }
  | { kind: "website"; url: string }
  | { kind: "note" };

export interface HintNode {
  kind: "hint";
  id: string;
  createdAt: string;
  text: string;
  directive: HintDirective;
  author: string;
}

export type GraphNode = GoalNode | HypothesisNode | FactNode | HintNode;

/**
 * - derives   goal or fact → hypothesis: the hypothesis was proposed because of it.
 * - tests     hypothesis → fact: the fact is what exploring the hypothesis observed.
 * - steers    hint → hypothesis: a person's hint created or abandoned it.
 */
export type EdgeType = "derives" | "tests" | "steers";

export interface Edge {
  from: string;
  to: string;
  type: EdgeType;
}

/** The graph is stored as an append-only event log; replaying it rebuilds the graph. */
export type GraphEvent =
  | { seq: number; at: string; type: "node"; node: GraphNode }
  | { seq: number; at: string; type: "edge"; edge: Edge }
  | { seq: number; at: string; type: "status"; id: string; status: HypothesisStatus; worker?: string; reason?: string }
  | { seq: number; at: string; type: "complete"; reason: string; factId?: string }
  | { seq: number; at: string; type: "reopen"; reason: string };
