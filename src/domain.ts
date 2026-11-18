/**
 * Allergen and diet vocabulary. Kept identical to What Can I Eat?
 * (src/lib/domain/dietary.ts there) so exported drafts import without mapping.
 */
export const INGREDIENT_TAGS = [
  "gluten",
  "crustaceans",
  "molluscs",
  "egg",
  "fish",
  "peanuts",
  "tree-nuts",
  "milk",
  "soy",
  "sesame",
  "lupin",
  "sulphites",
  "mustard",
  "celery",
  "meat",
  "honey",
  "gelatine",
  "alcohol",
] as const;

export type IngredientTag = (typeof INGREDIENT_TAGS)[number];

export const DIET_IDS = [
  "vegetarian",
  "vegan",
  "pescatarian",
  "alcohol-free",
  "gluten-free",
  "dairy-free",
  "egg-free",
  "peanut-free",
  "tree-nut-free",
  "shellfish-free",
  "fish-free",
  "soy-free",
  "sesame-free",
  "mustard-free",
  "celery-free",
  "lupin-free",
  "sulphite-free",
] as const;

export type DietId = (typeof DIET_IDS)[number];

export interface Ingredient {
  name: string;
  contains: IngredientTag[];
  /** The kitchen can leave this out or swap it on request. */
  removable: boolean;
}

/**
 * How strong a source of dietary information is, weakest first. The same
 * levels as What Can I Eat?'s docs/DATA_SOURCING.md.
 */
export const EVIDENCE_LEVELS = ["none", "description-only", "labelled-menu", "allergen-guide"] as const;
export type EvidenceLevel = (typeof EVIDENCE_LEVELS)[number];

export const evidenceRank = (level: EvidenceLevel) => EVIDENCE_LEVELS.indexOf(level);

export const TAG_LABELS: Record<IngredientTag, string> = {
  gluten: "Gluten",
  crustaceans: "Crustaceans",
  molluscs: "Molluscs",
  egg: "Egg",
  fish: "Fish",
  peanuts: "Peanuts",
  "tree-nuts": "Tree nuts",
  milk: "Milk",
  soy: "Soy",
  sesame: "Sesame",
  lupin: "Lupin",
  sulphites: "Sulphites",
  mustard: "Mustard",
  celery: "Celery",
  meat: "Meat",
  honey: "Honey",
  gelatine: "Gelatine",
  alcohol: "Alcohol",
};
