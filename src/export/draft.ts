import { TAG_LABELS, type Ingredient, type IngredientTag } from "../domain.js";
import type { ExplorationGraph } from "../graph/graph.js";
import type { FactNode, GraphNode, ObservedDish } from "../graph/types.js";
import { inferAllergens, parseDietCodes } from "../vendor/allergenInference.js";

/**
 * The best source in a run, as a What Can I Eat? import draft (the body of
 * `POST /api/v1/admin/restaurants`, `importDraftSchema` there). Every dish is
 * unverified until the restaurant confirms it; the draft says so in its notes.
 */
export interface DraftMeal {
  name: string;
  description?: string;
  category: string;
  price?: string;
  ingredients: Ingredient[];
  contains: IngredientTag[];
  mayContain: IngredientTag[];
  mayContainExcept: IngredientTag[];
  claims: string[];
  extraction: {
    sourceUrl?: string;
    extractedAt: string;
    confidence: "low" | "medium" | "high";
    notes: string[];
    coveredTags?: IngredientTag[];
  };
}

export interface Draft {
  name: string;
  address?: string;
  website?: string;
  categories: string[];
  source: { url?: string; importedAt: string };
  meals: DraftMeal[];
}

/** How each part of the draft was reached, for the reviewer: goal → hypotheses → facts. */
export interface Provenance {
  runFinished?: string;
  source?: { factId: string; url: string; contentHash?: string; fetchedAt?: string; level: string; method: string };
  path: Array<{ id: string; kind: GraphNode["kind"]; statement: string }>;
  quotes: Record<string, string[]>;
}

function meal(d: ObservedDish, sourceUrl: string, method: string, level: string, now: string): DraftMeal {
  const inferred = inferAllergens(d.name, d.description ?? "", d.claims ?? []);
  const notes = [`Allergen information from ${sourceUrl}`, `Evidence: ${level.replace(/-/g, " ")}, read by ${method}`];
  let ingredients = inferred.ingredients;
  let confidence = inferred.confidence;
  if (d.allergens?.covered.length) {
    // The guide is authoritative for the allergens it has columns for; keyword guesses add the rest.
    const covered = new Set(d.allergens.covered);
    const contains = new Set(d.allergens.contains);
    ingredients = d.allergens.contains.map((t) => ({ name: `${TAG_LABELS[t]} (allergen guide)`, contains: [t], removable: false }));
    for (const ing of inferred.ingredients) {
      const extra = ing.contains.filter((t) => !contains.has(t));
      if (!extra.length) continue;
      const clash = extra.filter((t) => covered.has(t));
      if (clash.length) notes.push(`Name mentions "${ing.name}" but the guide doesn't list ${clash.map((t) => TAG_LABELS[t]).join(", ")}; check this`);
      ingredients.push({ name: ing.name, contains: extra, removable: false });
    }
    confidence = "high";
    notes.push("Allergens taken from the restaurant's published allergen guide");
  } else if (d.allergens?.contains.length) {
    // Stated allergens without a full guide: add them, never remove anything.
    const have = new Set(ingredients.flatMap((i) => i.contains));
    const extra = d.allergens.contains.filter((t) => !have.has(t));
    if (extra.length) ingredients = [...ingredients, { name: "Stated by the source", contains: extra, removable: false }];
  }
  notes.push(...inferred.notes);
  return {
    name: (parseDietCodes(d.name).rest || d.name).slice(0, 120),
    ...(d.description && { description: d.description.slice(0, 500) }),
    category: (d.section || "Menu").slice(0, 60),
    ...(d.price && { price: d.price.slice(0, 20) }),
    ingredients: ingredients.slice(0, 40),
    contains: [],
    mayContain: d.allergens?.mayContain ?? [],
    mayContainExcept: [],
    claims: inferred.claims,
    extraction: {
      sourceUrl,
      extractedAt: now,
      confidence,
      notes: [...new Set(notes)].slice(0, 20).map((n) => n.slice(0, 300)),
      ...(d.allergens?.covered.length && { coveredTags: d.allergens.covered }),
    },
  };
}

export function exportDraft(graph: ExplorationGraph): { draft?: Draft; provenance: Provenance } {
  const best: FactNode | undefined = graph.bestSource();
  const finished = graph.events.findLast((e) => e.type === "complete")?.at;
  if (!best || best.data.type !== "source-read") return { provenance: { runFinished: finished, path: [], quotes: {} } };
  const d = best.data;
  const now = new Date().toISOString();
  const goal = graph.goal;
  const meals = d.dishes.slice(0, 500).map((x) => meal(x, d.url, d.method, d.level, now));
  const categories = [...new Set(meals.map((m) => m.category))].slice(0, 30);
  const quotes: Record<string, string[]> = {};
  for (const x of d.dishes) if (x.quotes?.length) quotes[x.name] = x.quotes;
  return {
    draft: {
      name: goal.venue.name.slice(0, 100),
      ...(goal.venue.address && { address: goal.venue.address }),
      ...(goal.venue.website && { website: goal.venue.website }),
      categories,
      source: { url: d.url, importedAt: now },
      meals,
    },
    provenance: {
      runFinished: finished,
      source: { factId: best.id, url: d.url, contentHash: best.evidence?.contentHash, fetchedAt: best.evidence?.fetchedAt, level: d.level, method: d.method },
      path: graph.lineage(best.id).map((n) => ({ id: n.id, kind: n.kind, statement: "statement" in n ? n.statement : n.kind === "goal" ? `Find allergen information for ${n.venue.name}` : n.text })),
      quotes,
    },
  };
}
