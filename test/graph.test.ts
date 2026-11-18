import { describe, expect, it } from "vitest";
import { ExplorationGraph } from "../src/graph/graph.js";
import type { GoalNode, HypothesisNode } from "../src/graph/types.js";

const goal: GoalNode = { kind: "goal", id: "goal_1", createdAt: "t", venue: { name: "Cafe" }, target: "allergen-guide" };
const hyp = (id: string, url: string): HypothesisNode => ({
  kind: "hypothesis",
  id,
  createdAt: "t",
  statement: "s",
  action: { type: "read-page", url, depth: 1 },
  prior: 0.5,
  expected: "labelled-menu",
  proposedBy: "rules",
});

describe("ExplorationGraph", () => {
  it("starts with one goal and refuses a second", () => {
    const g = new ExplorationGraph();
    expect(() => g.addNode(hyp("h", "https://a.au/"))).toThrow(/goal must be the first/);
    g.addNode(goal);
    expect(() => g.addNode({ ...goal, id: "goal_2" })).toThrow(/one goal/);
  });

  it("never proposes the same action twice", () => {
    const g = new ExplorationGraph();
    g.addNode(goal);
    g.addNode(hyp("h1", "https://a.au/menu"));
    expect(() => g.addNode(hyp("h2", "https://a.au/menu#top"))).toThrow(/already exists/);
  });

  it("only allows valid status changes and single claims", () => {
    const g = new ExplorationGraph();
    g.addNode(goal);
    g.addNode(hyp("h1", "https://a.au/menu"));
    expect(g.claim("h1", "w1")).toBe(true);
    expect(g.claim("h1", "w2")).toBe(false);
    g.setStatus("h1", "refuted");
    expect(() => g.setStatus("h1", "open")).toThrow(/Can't move/);
  });

  it("checks edge kinds", () => {
    const g = new ExplorationGraph();
    g.addNode(goal);
    g.addNode(hyp("h1", "https://a.au/menu"));
    g.addEdge("goal_1", "h1", "derives");
    expect(() => g.addEdge("h1", "goal_1", "tests")).toThrow(/can't join/);
    expect(() => g.addEdge("goal_1", "nope", "derives")).toThrow(/existing nodes/);
  });

  it("rebuilds the same graph from its event log", () => {
    const g = new ExplorationGraph();
    g.addNode(goal);
    g.addNode(hyp("h1", "https://a.au/menu"));
    g.addEdge("goal_1", "h1", "derives");
    g.claim("h1", "w1");
    g.setStatus("h1", "supported", { reason: "ok" });
    g.complete("done");
    const copy = ExplorationGraph.replay(JSON.parse(JSON.stringify(g.events)));
    expect([...copy.nodes.keys()]).toEqual([...g.nodes.keys()]);
    expect(copy.status.get("h1")).toBe("supported");
    expect(copy.completed?.reason).toBe("done");
    expect(() => ExplorationGraph.replay(g.events.slice(1))).toThrow(/out of order/);
  });
});
