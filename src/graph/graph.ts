import { randomUUID } from "node:crypto";
import { evidenceRank } from "../domain.js";
import type {
  Action,
  Edge,
  FactNode,
  GoalNode,
  GraphEvent,
  GraphNode,
  HintNode,
  HypothesisNode,
  HypothesisStatus,
} from "./types.js";

/** Allowed hypothesis status changes. Supported, refuted and abandoned are final. */
const TRANSITIONS: Record<HypothesisStatus, HypothesisStatus[]> = {
  open: ["claimed", "abandoned"],
  claimed: ["supported", "refuted", "abandoned", "open"],
  supported: [],
  refuted: [],
  abandoned: [],
};

/** A stable key for an action, so the same test is never proposed twice. */
export function actionKey(a: Action): string {
  const url = new URL(a.url);
  url.hash = "";
  return `${a.type} ${url.href}${a.attempt ? ` #${a.attempt}` : ""}`;
}

export const newId = (prefix: string) => `${prefix}_${randomUUID().replace(/-/g, "").slice(0, 12)}`;

/**
 * The exploration graph. It only keeps the graph consistent: every change is an
 * event, checked before it is applied, so a log replayed from disk always
 * yields the same graph. Planning and exploring live elsewhere.
 */
export class ExplorationGraph {
  readonly nodes = new Map<string, GraphNode>();
  readonly edges: Edge[] = [];
  readonly status = new Map<string, HypothesisStatus>();
  readonly events: GraphEvent[] = [];
  /** Why a hypothesis reached its status, for review. */
  readonly statusReason = new Map<string, string>();
  completed?: { reason: string; factId?: string };
  private keys = new Map<string, string>();
  private listeners: Array<(e: GraphEvent) => void> = [];

  static replay(events: GraphEvent[]): ExplorationGraph {
    const g = new ExplorationGraph();
    for (const e of events) g.apply(e);
    return g;
  }

  onEvent(listener: (e: GraphEvent) => void) {
    this.listeners.push(listener);
  }

  get goal(): GoalNode {
    const goal = [...this.nodes.values()].find((n): n is GoalNode => n.kind === "goal");
    if (!goal) throw new Error("The graph has no goal");
    return goal;
  }

  hypotheses(status?: HypothesisStatus): HypothesisNode[] {
    return [...this.nodes.values()].filter(
      (n): n is HypothesisNode => n.kind === "hypothesis" && (!status || this.status.get(n.id) === status),
    );
  }

  facts(): FactNode[] {
    return [...this.nodes.values()].filter((n): n is FactNode => n.kind === "fact");
  }

  hints(): HintNode[] {
    return [...this.nodes.values()].filter((n): n is HintNode => n.kind === "hint");
  }

  hasAction(a: Action): boolean {
    return this.keys.has(actionKey(a));
  }

  parents(id: string): GraphNode[] {
    return this.edges.filter((e) => e.to === id).map((e) => this.nodes.get(e.from)!);
  }

  children(id: string): GraphNode[] {
    return this.edges.filter((e) => e.from === id).map((e) => this.nodes.get(e.to)!);
  }

  /** The hypothesis a fact was observed for, if any. */
  testedBy(factId: string): HypothesisNode | undefined {
    const e = this.edges.find((x) => x.to === factId && x.type === "tests");
    return e && (this.nodes.get(e.from) as HypothesisNode);
  }

  /** The best source read so far: highest evidence level, then most labelled dishes, then most dishes. */
  bestSource(): FactNode | undefined {
    let best: FactNode | undefined;
    const score = (f: FactNode) =>
      f.data.type === "source-read" ? evidenceRank(f.data.level) * 1e6 + f.data.labelled * 1e3 + f.data.dishes.length : -1;
    for (const f of this.facts()) if (f.data.type === "source-read" && (!best || score(f) > score(best))) best = f;
    return best;
  }

  /** The path of nodes from the goal to `id`, following the edges that created each node. */
  lineage(id: string): GraphNode[] {
    const path: GraphNode[] = [];
    const seen = new Set<string>();
    let current: GraphNode | undefined = this.nodes.get(id);
    while (current && !seen.has(current.id)) {
      seen.add(current.id);
      path.unshift(current);
      const inbound = this.edges.find((e) => e.to === current!.id && e.type !== "steers");
      current = inbound && this.nodes.get(inbound.from);
    }
    return path;
  }

  // Writes. Each builds an event and applies it.

  addNode<T extends GraphNode>(node: T): T {
    this.emit({ type: "node", node });
    return node;
  }

  addEdge(from: string, to: string, type: Edge["type"]) {
    this.emit({ type: "edge", edge: { from, to, type } });
  }

  setStatus(id: string, status: HypothesisStatus, opts: { worker?: string; reason?: string } = {}) {
    this.emit({ type: "status", id, status, ...opts });
  }

  /** Claims an open hypothesis for a worker; false when another worker got it first. */
  claim(id: string, worker: string): boolean {
    if (this.status.get(id) !== "open") return false;
    this.setStatus(id, "claimed", { worker });
    return true;
  }

  complete(reason: string, factId?: string) {
    this.emit({ type: "complete", reason, factId });
  }

  /** Continues a finished exploration, for example after a person adds a hint. */
  reopen(reason: string) {
    this.emit({ type: "reopen", reason });
  }

  private emit(partial: DistributiveOmit<GraphEvent, "seq" | "at">) {
    const event = { ...partial, seq: this.events.length + 1, at: new Date().toISOString() } as GraphEvent;
    this.apply(event);
    for (const l of this.listeners) l(event);
  }

  private apply(e: GraphEvent) {
    if (e.seq !== this.events.length + 1) throw new Error(`Event ${e.seq} out of order`);
    switch (e.type) {
      case "node": {
        const n = e.node;
        if (this.nodes.has(n.id)) throw new Error(`Duplicate node ${n.id}`);
        if (n.kind === "goal" && [...this.nodes.values()].some((x) => x.kind === "goal")) throw new Error("A graph has one goal");
        if (n.kind !== "goal" && !this.nodes.size) throw new Error("The goal must be the first node");
        if (n.kind === "hypothesis") {
          const key = actionKey(n.action);
          if (this.keys.has(key)) throw new Error(`Hypothesis already exists for ${key}`);
          if (!(n.prior >= 0 && n.prior <= 1)) throw new Error("Prior must be between 0 and 1");
          this.keys.set(key, n.id);
          this.status.set(n.id, "open");
        }
        this.nodes.set(n.id, n);
        break;
      }
      case "edge": {
        const from = this.nodes.get(e.edge.from);
        const to = this.nodes.get(e.edge.to);
        if (!from || !to) throw new Error("Edges must join existing nodes");
        const ok =
          (e.edge.type === "derives" && (from.kind === "goal" || from.kind === "fact") && to.kind === "hypothesis") ||
          (e.edge.type === "tests" && from.kind === "hypothesis" && to.kind === "fact") ||
          (e.edge.type === "steers" && from.kind === "hint" && to.kind === "hypothesis");
        if (!ok) throw new Error(`A ${e.edge.type} edge can't join ${from.kind} to ${to.kind}`);
        this.edges.push(e.edge);
        break;
      }
      case "status": {
        const current = this.status.get(e.id);
        if (!current) throw new Error(`No hypothesis ${e.id}`);
        if (!TRANSITIONS[current].includes(e.status)) throw new Error(`Can't move ${e.id} from ${current} to ${e.status}`);
        this.status.set(e.id, e.status);
        if (e.reason) this.statusReason.set(e.id, e.reason);
        break;
      }
      case "complete":
        if (this.completed) throw new Error("The exploration is already complete");
        this.completed = { reason: e.reason, factId: e.factId };
        break;
      case "reopen":
        if (!this.completed) throw new Error("The exploration isn't complete");
        this.completed = undefined;
        break;
    }
    this.events.push(e);
  }
}

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
