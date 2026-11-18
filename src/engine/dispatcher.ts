import { newId, type ExplorationGraph } from "../graph/graph.js";
import type { FactNode, HypothesisNode } from "../graph/types.js";
import { BudgetExhausted } from "../net/fetcher.js";
import { explore, type ExploreContext } from "../explorers/explore.js";
import { planFromRules, score, type PlannerOptions } from "../planner/rules.js";

export interface RunOptions extends PlannerOptions {
  /** Most hypotheses tested in this run. */
  maxSteps: number;
  /** Workers testing hypotheses at the same time (each host is still read one request at a time). */
  concurrency: number;
  log?: (line: string) => void;
}

export interface RunSummary {
  steps: number;
  reason: string;
  best?: FactNode;
}

/** Writes the planner's proposals and skips into the graph. */
function applyPlan(graph: ExplorationGraph, opts: PlannerOptions) {
  const plan = planFromRules(graph, opts);
  for (const p of plan.proposals) {
    const h = graph.addNode<HypothesisNode>({
      kind: "hypothesis",
      id: newId("hyp"),
      createdAt: new Date().toISOString(),
      statement: p.statement,
      action: p.action,
      prior: p.prior,
      expected: p.expected,
      proposedBy: p.proposedBy,
    });
    for (const from of p.derivedFrom) graph.addEdge(from, h.id, "derives");
    for (const hint of p.steeredBy ?? []) graph.addEdge(hint, h.id, "steers");
  }
  for (const a of plan.abandon) {
    graph.addEdge(a.hintId, a.id, "steers");
    graph.setStatus(a.id, "abandoned", { reason: "a hint said to skip it" });
  }
  return plan;
}

/**
 * The exploration loop: plan (read the graph, propose hypotheses or declare the
 * goal met), pick the best open hypotheses, test them, write what was observed,
 * and repeat until the goal is met, nothing is left to try, or the budget runs out.
 */
export async function run(graph: ExplorationGraph, ctx: ExploreContext, opts: RunOptions): Promise<RunSummary> {
  const log = opts.log ?? (() => {});
  let steps = 0;
  let workerSeq = 0;

  const finish = (reason: string): RunSummary => {
    const best = graph.bestSource();
    graph.complete(reason, best?.id);
    log(`Done: ${reason}`);
    return { steps, reason, best };
  };

  if (graph.completed) {
    const lastComplete = graph.events.findLast((e) => e.type === "complete")!;
    const newHints = graph.hints().filter((h) => h.createdAt > lastComplete.at);
    if (!newHints.length) return { steps, reason: graph.completed.reason, best: graph.bestSource() };
    graph.reopen(`${newHints.length} new hint(s)`);
  }

  // Hypotheses a previous run claimed but never finished go back to open.
  for (const h of graph.hypotheses("claimed")) graph.setStatus(h.id, "open", { reason: "released after an interrupted run" });

  while (true) {
    const plan = applyPlan(graph, opts);
    if (plan.complete) return finish(plan.complete.reason);

    const open = graph.hypotheses("open").sort((a, b) => score(b) - score(a));
    if (!open.length) return finish(graph.bestSource() ? "nothing left to try; kept the best source found" : "nothing left to try; no source found");
    if (steps >= opts.maxSteps) return finish(`step budget of ${opts.maxSteps} used up`);

    const batch = open.slice(0, Math.min(opts.concurrency, opts.maxSteps - steps));
    let budgetHit = false;
    await Promise.all(
      batch.map(async (h) => {
        const worker = `worker-${++workerSeq}`;
        if (!graph.claim(h.id, worker)) return;
        steps++;
        log(`Testing: ${h.statement} [${h.action.type} ${h.action.url}]`);
        try {
          const result = await explore(h.action, ctx);
          for (const o of result.observations) {
            const fact = graph.addNode<FactNode>({
              kind: "fact",
              id: newId("fact"),
              createdAt: new Date().toISOString(),
              statement: o.statement,
              data: o.data,
              ...(o.evidence && { evidence: o.evidence }),
            });
            graph.addEdge(h.id, fact.id, "tests");
            log(`  Fact: ${o.statement}`);
          }
          graph.setStatus(h.id, result.outcome, { worker, reason: result.reason });
        } catch (e) {
          if (!(e instanceof BudgetExhausted)) throw e;
          budgetHit = true;
          graph.setStatus(h.id, "open", { reason: "request budget used up" });
        }
      }),
    );
    if (budgetHit) return finish("request budget used up");
  }
}
