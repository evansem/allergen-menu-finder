import type { ExplorationGraph } from "./graph.js";
import type { GraphNode } from "./types.js";

const label = (n: GraphNode) =>
  n.kind === "goal" ? `GOAL find allergen information for ${n.venue.name} (target: ${n.target})` : n.kind === "hint" ? `HINT ${n.text}` : n.statement;

/** The graph as an indented tree from the goal, with each hypothesis's status and score inputs. */
export function renderTree(graph: ExplorationGraph): string {
  const lines: string[] = [];
  const seen = new Set<string>();
  const walk = (id: string, indent: string) => {
    const n = graph.nodes.get(id)!;
    if (seen.has(id)) {
      lines.push(`${indent}↳ (see ${id})`);
      return;
    }
    seen.add(id);
    let line = `${indent}${n.kind === "fact" ? "• " : n.kind === "hypothesis" ? "? " : ""}${label(n)}`;
    if (n.kind === "hypothesis") {
      const why = graph.statusReason.get(n.id);
      line += `  [${graph.status.get(n.id)}${why ? `: ${why}` : ""}; prior ${n.prior}, expects ${n.expected}, by ${n.proposedBy}]`;
    }
    lines.push(line);
    for (const e of graph.edges.filter((x) => x.from === id && x.type !== "steers")) walk(e.to, `${indent}  `);
  };
  walk(graph.goal.id, "");
  for (const h of graph.hints()) {
    const steered = graph.edges.filter((e) => e.from === h.id).length;
    lines.push(`HINT (${h.author}) ${h.text}${steered ? `  [steered ${steered} hypothesis(es)]` : ""}`);
  }
  if (graph.completed) lines.push(`COMPLETE ${graph.completed.reason}`);
  return lines.join("\n");
}

/** The graph as a Mermaid flowchart, for pull requests and review notes. */
export function renderMermaid(graph: ExplorationGraph): string {
  const esc = (s: string) => s.replace(/["<>]/g, "'").slice(0, 90);
  const lines = ["flowchart TD"];
  for (const n of graph.nodes.values()) {
    const text = esc(label(n));
    if (n.kind === "goal") lines.push(`  ${n.id}[["${text}"]]`);
    else if (n.kind === "hypothesis") lines.push(`  ${n.id}{{"${text} (${graph.status.get(n.id)})"}}`);
    else if (n.kind === "fact") lines.push(`  ${n.id}["${text}"]`);
    else lines.push(`  ${n.id}>"${text}"]`);
  }
  for (const e of graph.edges) lines.push(`  ${e.from} -->|${e.type}| ${e.to}`);
  return lines.join("\n");
}
