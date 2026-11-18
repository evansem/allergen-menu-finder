# allergen-menu-finder

Finds the allergen information a restaurant publishes on its own website, and records how it was found.

Each run is an exploration of one venue's site. The run is kept as a graph of hypotheses ("the PDF linked as 'Allergens' is an allergen matrix") and the facts that tested them. The output is an import draft for [What Can I Eat?](https://github.com/evansem/what-can-i-eat) plus a provenance file, so a reviewer can see why every dish is there. Nothing it finds is treated as verified. The restaurant confirms its own dishes after it claims the listing.

The approach borrows the idea of a shared fact and intent graph from [Cairn](https://github.com/oritera/Cairn), applied to a much narrower problem. No Cairn code is used. See [docs/DESIGN.md](docs/DESIGN.md).

## Quick start

Requires Node.js 24.

```bash
npm install
npm run amf -- explore --name "Kōwhai Kitchen" --website https://www.example.com.au/
npm run amf -- show kowhai-kitchen            # the graph as a tree
npm run amf -- export kowhai-kitchen          # runs/kowhai-kitchen/draft.json and provenance.json
```

If the run missed something, steer it with a hint and resume:

```bash
npm run amf -- hint kowhai-kitchen try https://www.example.com.au/allergens
npm run amf -- hint kowhai-kitchen skip /catering
npm run amf -- hint kowhai-kitchen website https://www.the-real-site.com.au/
npm run amf -- resume kowhai-kitchen
```

`npm run amf -- --help` lists every option. The main ones:

| Option | Default | Meaning |
| --- | --- | --- |
| `--target` | `allergen-guide` | Stop once a source at this evidence level is found (`allergen-guide`, `labelled-menu`, `description-only`). |
| `--max-steps` | 25 | Hypotheses tested per run. |
| `--max-requests` | 40 | Web requests per run, including robots.txt reads. |
| `--depth` | 2 | Link levels followed from the home page. |
| `--country` | `au` | Require the site to look Australian (an `.au` domain, or an Australian address or phone number). `any` turns this off. |
| `--llm` | off | Let Claude read sources the parsers can't, such as PDF menus. Needs `ANTHROPIC_API_KEY` (see `.env.example`). |
| `--ignore-robots` | off | Skip robots.txt. Use only with the site owner's permission. |

## How a run works

1. **Plan.** The planner reads the whole graph and proposes hypotheses: check the website, follow a link that looks like a menu or allergen guide, or ask the LLM to read a source the parsers couldn't. It also decides when the goal is met.
2. **Pick.** Open hypotheses are ranked by prior × the evidence they could yield ÷ cost, with a penalty for each link level away from the home page.
3. **Explore.** A worker claims a hypothesis, runs its action and writes what it saw as facts, each with the URL, fetch time and a SHA-256 of the content. The hypothesis becomes supported or refuted.
4. **Repeat** until the target evidence level is reached, nothing is left to try, or the budget runs out.

Every change goes to `runs/<id>/events.jsonl`, an append-only log the graph is rebuilt from. An interrupted run resumes where it stopped.

## Safety rules

- **Only https.** Private and special-purpose addresses are refused on every redirect hop, and the check happens at connection time so DNS rebinding can't get around it. Bodies are capped at 10 MB after decompression.
- **Polite crawling.** robots.txt is honoured by default (RFC 9309: a 5xx means stay out). Each host gets one request at a time, 1.5 s apart, and each run has a request budget. Requests carry a user agent that names this project.
- **Only the venue's own site.** Pages on other domains are never followed. Social, delivery, booking and review sites are skipped. PDFs may be hosted on a CDN.
- **The LLM proposes and code checks.** Scraped text goes to the model as untrusted data, and the model can only return data in a fixed schema. It has no tools and can't add URLs. Every dish must carry a quote, and code checks that the quote appears word for word in the source. A diet claim stands only if the menu's own key or wording supports it. Allergens the model says a dish contains are always kept, because adding allergens is the safe direction.
- **More allergens, not fewer.** Keyword inference (vendored from What Can I Eat?) still adds allergens the source doesn't cover, and the export notes any clash for the reviewer.

## Development

```bash
npm run lint    # type-check
npm test        # unit and end-to-end tests against fixture sites (no network)
```

Pull requests target `dev`.
