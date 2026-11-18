import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ExplorationGraph } from "./graph.js";
import type { GraphEvent } from "./types.js";

/**
 * A run is one exploration, stored as `runs/<id>/events.jsonl`: one event per
 * line, only ever appended. The log is the record of what was tried, what was
 * seen and why; the graph is rebuilt from it.
 */
export class RunStore {
  constructor(readonly root = "runs") {}

  dir(runId: string) {
    if (!/^[a-z0-9-]{1,80}$/.test(runId)) throw new Error(`Invalid run id "${runId}"`);
    return join(this.root, runId);
  }

  exists(runId: string) {
    return existsSync(join(this.dir(runId), "events.jsonl"));
  }

  /** Starts a new run and keeps its log up to date as the graph changes. */
  create(runId: string, graph: ExplorationGraph) {
    if (this.exists(runId)) throw new Error(`Run ${runId} already exists`);
    mkdirSync(this.dir(runId), { recursive: true });
    writeFileSync(join(this.dir(runId), "events.jsonl"), graph.events.map((e) => `${JSON.stringify(e)}\n`).join(""));
    this.follow(runId, graph);
  }

  /** Loads a run's graph and keeps appending its new events. */
  open(runId: string): ExplorationGraph {
    const graph = ExplorationGraph.replay(this.read(runId));
    this.follow(runId, graph);
    return graph;
  }

  read(runId: string): GraphEvent[] {
    const text = readFileSync(join(this.dir(runId), "events.jsonl"), "utf8");
    return text
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as GraphEvent);
  }

  writeFile(runId: string, name: string, content: string) {
    writeFileSync(join(this.dir(runId), name), content);
  }

  private follow(runId: string, graph: ExplorationGraph) {
    const file = join(this.dir(runId), "events.jsonl");
    graph.onEvent((e) => appendFileSync(file, `${JSON.stringify(e)}\n`));
  }
}
