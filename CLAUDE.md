# allergen-menu-finder

Explores a restaurant's own website as a hypothesis and evidence graph to find its published allergen information, and exports an import draft for What Can I Eat? (github.com/evansem/what-can-i-eat). Design: docs/DESIGN.md.

## Way of working

- Pull requests target `dev`. Never merge into `main`.
- Commit messages and pull request titles start with an upper case letter; the rest is lower case except acronyms and names.
- `npm run lint` and `npm test` must pass. Tests never touch the network: use fixture sites and fake fetchers.
- Never commit secrets or `runs/` output.

## Rules the code must keep

- The graph is append-only. Facts never change, and hypotheses only move through the allowed statuses. Add a new event type rather than editing old events.
- Every URL an explorer fetches must come from the goal, a hint, or a link found on a page in the graph. The LLM never chooses URLs.
- LLM output only proposes data. A dish is kept only with a quote found in the source. A diet claim or an allergen guide column (anything that makes a dish look safer) is kept only when the source supports it. Allergens a dish contains may always be added.
- Fetching goes through `PoliteFetcher` and `safeFetch`: https only, private addresses refused at connection time, robots.txt honoured unless `--ignore-robots`, a delay per host, and a request budget per run.
- `src/vendor/` holds parsers copied from What Can I Eat? (`src/lib/extraction/` there). Keep them in step with that repository when they change.

## Layout

```
src/graph/       node and edge types, the consistent graph, run store (JSONL), tree and Mermaid views
src/planner/     rule-based planner and hypothesis scoring
src/explorers/   actions: check-site, read-page, read-pdf, llm-extract
src/engine/      the plan, claim, explore loop
src/llm/         Claude extraction with quote checks
src/net/         safe fetch, robots.txt, polite fetcher
src/export/      What Can I Eat? import draft and provenance
src/vendor/      menu, allergen matrix and PDF parsers from What Can I Eat?
test/            unit and end-to-end tests with fixture sites
```
