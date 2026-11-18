# Design

## Why a graph

The What Can I Eat? importer is a fixed pipeline: read the home page, follow up to two levels of menu-looking links, keep the best page. That works for simple sites but fails in ways that are hard to review:

- When it picks the wrong page, nothing records which other pages it considered or why it rejected them.
- A person who knows where the allergen guide is can't tell it, short of editing a manifest.
- Each new source type (a PDF the table parser can't read, an allergen table in HTML, a menu only an LLM can read) means another branch in the pipeline.

Here exploration is a search over hypotheses, recorded as a graph. The idea comes from [Cairn](https://github.com/oritera/Cairn), which coordinates agents through a shared board of facts (confirmed findings), intents (directions not yet explored) and hints (human judgement). Cairn is a general problem solver whose workers are coding agents. This project keeps the board idea and drops the rest. The planner and explorers are small, deterministic functions, and an LLM is used for one narrow job: reading a source.

No Cairn code is used. Cairn is AGPL-3.0, and this project only reuses the concept.

## Model

| Node | Meaning | Changes? |
| --- | --- | --- |
| `goal` | One venue, and the evidence level to stop at. | Never; one per graph. |
| `hypothesis` | A testable guess, with the action that tests it, a prior, and the evidence level it could yield. | Only its status: `open` → `claimed` → `supported` / `refuted`, or `abandoned`. |
| `fact` | What an action observed: a verified site, links found, a source read (dishes, evidence level, method), or why a page wasn't useful. Carries URL, fetch time and content hash. | Never. |
| `hint` | A person's steer: `try <url>`, `skip <text>`, `website <url>`, or a note. | Never. |

| Edge | From → to | Meaning |
| --- | --- | --- |
| `derives` | goal or fact → hypothesis | The hypothesis was proposed because of it. |
| `tests` | hypothesis → fact | The fact is what testing the hypothesis observed. |
| `steers` | hint → hypothesis | The hint created the hypothesis or abandoned it. |

The graph (`src/graph/graph.ts`) only keeps itself consistent. Every write is an event, checked before it's applied: one goal, first; edges only between the right kinds; no duplicate actions; only allowed status changes; a hypothesis can be claimed only once. Replaying the log in `runs/<id>/events.jsonl` rebuilds the same graph, so a run is resumable and auditable.

## Roles

- **Planner** (`src/planner/rules.ts`) reads the whole graph and returns proposals, skips and whether the goal is met. It holds no state of its own: running it twice proposes nothing new, because every action already in the graph is skipped. This is Cairn's "Reason" step.
- **Explorers** (`src/explorers/`) run one action and return observations. This is Cairn's "Explore" step. Actions:
  - `check-site`: the home page loads, wasn't redirected to another site, isn't parked, and (with `--country au`) looks Australian. It is also read for links and a menu.
  - `read-page` / `read-pdf`: an allergen table (HTML `<table>`, or a PDF table recovered by text position), else a menu (schema.org JSON-LD or the heuristic parser), plus menu links to follow.
  - `llm-extract`: Claude reads a source the parsers gave up on, then the output is checked against quotes (`src/llm/extract.ts`).
- **Dispatcher** (`src/engine/dispatcher.ts`) loops plan → pick → claim → explore → write. It runs a small number of workers in parallel. They coordinate only through claims on the graph, and each host is still read one request at a time.

## Scoring

`score = prior × (1 + rank(expected)) ÷ cost(action) ÷ (1 + 0.25 × depth)`

The ranks run from `none` = 0 to `allergen-guide` = 3. The costs are: check-site 1, read-page 1, read-pdf 1.5, llm-extract 4. A PDF linked as "Allergens" therefore beats a page linked as "Menu", and the LLM is asked only when nothing cheaper is left that could do better.

## Evidence levels

These are the same levels as What Can I Eat?'s `docs/DATA_SOURCING.md`:

- `allergen-guide`: a table of items against allergens. A blank cell counts as "not present" only for the allergens the guide has columns for.
- `labelled-menu`: at least three dishes carry diet codes.
- `description-only`: allergens can only be inferred from names and descriptions.

## Export

`amf export <run>` writes:

- `draft.json`: the best source's dishes, in the shape of What Can I Eat?'s import draft (`importDraftSchema`). Each dish is unverified and notes its source URL, evidence level and method.
- `provenance.json`: the content hash and fetch time of the source, the path from goal to source through the graph, and the supporting quotes for LLM-read dishes.

## Not built yet

- **Website discovery.** A goal without a website relies on a `website` hint. OpenStreetMap and council-directory lookups (as in What Can I Eat?) would become `find-website` hypotheses.
- **Refresh.** A later run could re-fetch a run's source and compare the content hash, sending only changed dishes back for review.
- **JavaScript-rendered menus.** A `render-page` action with a headless browser.
- **Scanned PDFs and menu photos.** These can't be quote-checked against a text layer. They need OCR first, or a lower evidence ceiling.
- **LLM planner.** Free-text `note` hints are recorded for reviewers, but nothing reads them yet. An LLM planner could read them and the graph, then propose hypotheses limited to URLs already seen.
- **Batch runs and a review queue** feeding What Can I Eat?'s admin import.
