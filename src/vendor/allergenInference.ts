import type { IngredientTag } from "../domain.js";
import type { Ingredient } from "../domain.js";

/**
 * Keyword dictionary used to guess ingredients and allergens from menu text.
 * It is deliberately biased towards flagging: a false "contains egg" costs a
 * diner one option, a missed one could make them ill. Everything it produces is
 * marked unverified until the restaurant confirms it.
 */
const KEYWORDS: Array<[string[], IngredientTag[]]> = [
  // Meat
  [["beef", "steak", "sirloin", "ribeye", "rib eye", "eye fillet", "brisket", "veal", "wagyu", "mince", "meatball", "meatballs", "bolognese", "burger patty"], ["meat"]],
  [["chicken", "duck", "turkey", "quail", "poultry"], ["meat"]],
  [["pork", "bacon", "ham", "prosciutto", "pancetta", "chorizo", "salami", "pepperoni", "sausage", "lardons", "pulled pork", "belly", "guanciale", "nduja"], ["meat"]],
  [["lamb", "venison", "goat", "rabbit", "mutton", "hogget"], ["meat"]],
  [["gravy", "jus", "bone broth", "chicken stock", "beef stock"], ["meat"]],
  // Fish & seafood
  [["fish", "salmon", "tuna", "snapper", "tarakihi", "terakihi", "hoki", "gurnard", "cod", "hake", "trout", "kingfish", "anchovy", "anchovies", "sardine", "sardines", "mackerel", "whitebait", "bonito", "fish sauce", "caesar dressing", "worcestershire"], ["fish"]],
  [["prawn", "prawns", "shrimp", "crab", "lobster", "crayfish", "scampi", "langoustine"], ["crustaceans"]],
  [["mussel", "mussels", "oyster", "oysters", "squid", "calamari", "octopus", "scallop", "scallops", "clam", "clams", "paua", "pipi", "pipis", "tuatua", "oyster sauce"], ["molluscs"]],
  // Dairy
  [["cheese", "cheddar", "parmesan", "parmigiano", "pecorino", "mozzarella", "burrata", "feta", "halloumi", "ricotta", "mascarpone", "brie", "camembert", "gorgonzola", "blue cheese", "goat cheese", "goats cheese", "gruyere", "provolone", "paneer", "labneh", "cream cheese"], ["milk"]],
  [["cream", "butter", "buttermilk", "milk", "yoghurt", "yogurt", "creme fraiche", "crème fraîche", "sour cream", "ghee", "ice cream", "gelato", "custard", "bechamel", "béchamel", "alfredo", "tzatziki", "raita", "beurre blanc", "cheesecake"], ["milk"]],
  // Egg
  [["egg", "eggs", "aioli", "mayo", "mayonnaise", "hollandaise", "bearnaise", "béarnaise", "meringue", "pavlova", "carbonara", "frittata", "omelette", "quiche", "tiramisu", "remoulade", "marie rose", "thousand island", "tartare sauce", "tartar sauce"], ["egg"]],
  [["custard", "brioche", "egg noodles", "fresh pasta", "pasta fresca"], ["egg"]],
  // Gluten
  [["bread", "sourdough", "toast", "bun", "brioche", "focaccia", "ciabatta", "baguette", "pita", "pitta", "naan", "roti", "flatbread", "croutons", "crouton", "crostini", "bruschetta", "cracker", "crackers", "pangrattato", "pan catalan", "pan de coca", "gnocco fritto", "wrap", "tortilla", "bagel", "croissant", "crumpet", "bao", "bao bun"], ["gluten"]],
  [["pasta", "spaghetti", "linguine", "fettuccine", "tagliatelle", "pappardelle", "penne", "rigatoni", "lasagne", "lasagna", "ravioli", "tortellini", "gnocchi", "macaroni", "orzo", "couscous", "cous cous", "tortelli", "paccheri", "tagliolini", "orecchiette", "bucatini", "agnolotti", "cavatelli", "casarecce", "pici", "gnudi", "fregola", "farro", "noodles", "udon", "ramen", "dumplings", "gyoza", "wonton"], ["gluten"]],
  [["flour", "batter", "battered", "beer battered", "tempura", "crumbed", "breaded", "panko", "schnitzel", "parma", "parmigiana", "arancini", "croquette", "croquettes", "croqueta", "nuggets", "katsu", "spring roll", "spring rolls", "fritter", "fritters", "financier", "financiers", "madeleine", "madeleines", "pastry", "pie", "tart", "pizza", "calzone", "pancake", "pancakes", "waffle", "waffles", "cake", "brownie", "biscuit", "cookie", "crumble", "scone", "muffin", "donut", "doughnut", "churros", "roux", "seitan", "barley", "rye", "spelt", "semolina", "bulgur", "freekeh", "malt", "beer", "soy sauce", "teriyaki", "hoisin"], ["gluten"]],
  // Soy
  [["soy", "soya", "tofu", "tempeh", "edamame", "miso", "tamari", "soy sauce", "teriyaki", "hoisin", "soy milk"], ["soy"]],
  // Nuts
  [["peanut", "peanuts", "peanut butter", "satay", "groundnut"], ["peanuts"]],
  [["almond", "almonds", "walnut", "walnuts", "cashew", "cashews", "pistachio", "pistachios", "hazelnut", "hazelnuts", "pecan", "pecans", "macadamia", "pine nut", "pine nuts", "brazil nut", "praline", "frangipane", "marzipan", "nutella", "frangelico", "amaretto", "pesto", "romesco", "dukkah", "baklava", "nut", "nuts"], ["tree-nuts"]],
  [["pesto"], ["milk"]],
  // Seeds & others
  [["sesame", "tahini", "hummus", "houmous", "baba ganoush", "dukkah", "furikake", "za'atar", "zaatar", "halva"], ["sesame"]],
  [["mustard", "dijon", "wholegrain mustard", "honey mustard"], ["mustard"]],
  [["celery", "celeriac", "celery salt"], ["celery"]],
  [["lupin", "lupini"], ["lupin"]],
  [["wine", "red wine", "white wine", "port", "sherry", "balsamic", "dried apricot", "dried fruit", "raisins", "sultanas", "prosecco", "champagne"], ["sulphites"]],
  [["honey", "honeycomb", "manuka"], ["honey"]],
  [["gelatine", "gelatin", "panna cotta", "marshmallow", "jelly"], ["gelatine"]],
  [["wine", "beer", "cider", "rum", "whisky", "whiskey", "brandy", "vodka", "gin", "tequila", "liqueur", "amaretto", "frangelico", "cointreau", "kahlua", "baileys", "prosecco", "champagne", "sherry", "port", "sake", "mirin", "spritz", "negroni", "margarita"], ["alcohol"]],
];

/** Words before a keyword that cancel some of its tags ("vegan mayo", "gluten free bun", "oat milk"). */
const QUALIFIERS: Array<[RegExp, IngredientTag[]]> = [
  [/\b(vegan|plant[- ]based|dairy[- ]free|non[- ]dairy)\s*$/i, ["milk", "egg", "meat", "fish", "honey", "gelatine"]],
  [/\b(oat|soy|soya|almond|coconut|rice|cashew)\s*$/i, ["milk"]],
  [/\b(gluten[- ]free|gf|wheat[- ]free|rice|corn|buckwheat|chickpea)\s*$/i, ["gluten"]],
  [/\begg[- ]free\s*$/i, ["egg"]],
  [/\b(nut[- ]free)\s*$/i, ["tree-nuts", "peanuts"]],
  [/\b(alcohol[- ]free|non[- ]alcoholic|zero|0%)\s*$/i, ["alcohol"]],
  [/\b(beyond|impossible|meat[- ]free|mock|faux|vegetarian|veggie)\s*$/i, ["meat", "fish"]],
];

/** Phrases that mean an allergen-bearing component can be swapped on request. */
const OPTION_PATTERNS: Array<[RegExp, IngredientTag[]]> = [
  [/\b(gfo|gf option|gf available|gluten[- ]free (option|available|on request|bread available|base available)|can be (made )?(gf|gluten[- ]free))\b/i, ["gluten"]],
  [/\b(dfo|df option|df available|dairy[- ]free (option|available|on request)|can be (made )?(df|dairy[- ]free))\b/i, ["milk"]],
  [/\b(vgo|vegan option|vegan available|can be (made )?vegan)\b/i, ["milk", "egg", "honey", "meat", "fish"]],
  [/\b(vo|vegetarian option|can be (made )?vegetarian)\b/i, ["meat", "fish"]],
  [/\b(nfo|nut[- ]free option|can be (made )?nut[- ]free)\b/i, ["tree-nuts", "peanuts"]],
];

/** Dietary codes printed on menus, e.g. "Halloumi salad (V, GF)". */
const CODE_CLAIMS: Record<string, string> = {
  v: "vegetarian",
  veg: "vegetarian",
  vegetarian: "vegetarian",
  vg: "vegan",
  ve: "vegan",
  vegan: "vegan",
  gf: "gluten-free",
  "gluten free": "gluten-free",
  df: "dairy-free",
  "dairy free": "dairy-free",
  nf: "tree-nut-free",
  "nut free": "tree-nut-free",
  ef: "egg-free",
  "egg free": "egg-free",
};

const CLAIM_REMOVES: Record<string, IngredientTag[]> = {
  vegetarian: ["meat", "fish", "crustaceans", "molluscs", "gelatine"],
  vegan: ["meat", "fish", "crustaceans", "molluscs", "gelatine", "milk", "egg", "honey"],
  "gluten-free": ["gluten"],
  "dairy-free": ["milk"],
  "tree-nut-free": ["tree-nuts", "peanuts"],
  "egg-free": ["egg"],
};

export interface Inference {
  ingredients: Ingredient[];
  claims: string[];
  confidence: "low" | "medium" | "high";
  notes: string[];
}

function escape(s: string) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const COMPILED = KEYWORDS.flatMap(([words, tags]) =>
  words.map((w) => ({ word: w, tags, re: new RegExp(`(^|[^\\p{L}])(${escape(w)})(?=$|[^\\p{L}])`, "giu") })),
);

const CODE = String.raw`(?:vg|ve|veg|v|gfo|gf|dfo|df|nf|nfo|ef|vgo|vo|vegan|vegetarian|gluten[- ]free|dairy[- ]free|nut[- ]free|egg[- ]free)\*?`;
const CODE_LIST = new RegExp(String.raw`^\s*${CODE}(?:\s*[,/|.&]?\s*${CODE})*\s*$`, "i");
const TRAILING_CODES = new RegExp(String.raw`(?:^|\s)((?:vg|ve|v|gfo|gf|dfo|df|nf|nfo|ef|vgo|vo)\*?(?:[\s,/|.]+(?:vg|ve|v|gfo|gf|dfo|df|nf|nfo|ef|vgo|vo)\*?)*)\s*$`, "i");

/** Pulls dietary codes like "(V, GF)", "[vegan]" or a trailing "GF DF" off a dish name. */
export function parseDietCodes(text: string): { claims: string[]; options: string[]; rest: string } {
  const claims = new Set<string>();
  const options = new Set<string>();
  const groups: string[] = [];
  let rest = text.replace(/\s*[([]([^)\]]{1,40})[)\]]/g, (whole, inner: string) => {
    if (!CODE_LIST.test(inner)) return whole;
    groups.push(inner);
    return "";
  });
  const trailing = rest.match(TRAILING_CODES);
  if (trailing && trailing.index! > 0) {
    groups.push(trailing[1]);
    rest = rest.slice(0, trailing.index);
  }
  for (const g of groups) {
    for (const raw of g.split(/[\s,/|.&]+/)) {
      const code = raw.replace("*", "").toLowerCase().replace(/[- ]/g, " ");
      if (!code) continue;
      if (/^(gfo|dfo|nfo|vgo|vo)$/.test(code)) options.add(code);
      else if (CODE_CLAIMS[code]) claims.add(CODE_CLAIMS[code]);
    }
  }
  // Multi-word codes ("gluten free") are split above; re-join them.
  for (const g of groups) {
    for (const m of g.matchAll(/(gluten|dairy|nut|egg)[- ]free/gi)) claims.add(CODE_CLAIMS[`${m[1].toLowerCase()} free`]);
  }
  return { claims: [...claims], options: [...options], rest: rest.replace(/\s+[-–,]\s*$/, "").trim() };
}

export function inferAllergens(name: string, description = "", extraClaims: string[] = []): Inference {
  const notes: string[] = [];
  const { claims: codeClaims, options, rest } = parseDietCodes(name);
  const descCodes = parseDietCodes(description);
  const claims = new Set([...codeClaims, ...descCodes.claims, ...extraClaims]);
  const text = `${rest} ${description}`;

  const found = new Map<string, Set<IngredientTag>>();
  for (const { word, tags, re } of COMPILED) {
    re.lastIndex = 0;
    for (const m of text.matchAll(re)) {
      const before = text.slice(0, (m.index ?? 0) + m[1].length);
      const cancelled = new Set<IngredientTag>();
      let qualifier = "";
      for (const [q, removes] of QUALIFIERS) {
        const hit = before.match(q);
        if (!hit) continue;
        qualifier = hit[0].trim();
        removes.forEach((t) => cancelled.add(t));
      }
      const kept = tags.filter((t) => !cancelled.has(t));
      if (cancelled.size && kept.length < tags.length) notes.push(`"${qualifier} ${word}" treated as a substitute`);
      if (!kept.length) continue;
      const key = word.toLowerCase();
      const set = found.get(key) ?? new Set();
      kept.forEach((t) => set.add(t));
      found.set(key, set);
    }
  }

  // Drop words fully covered by a longer match ("soy sauce" vs "soy", "ice cream" vs "cream").
  const keys = [...found.keys()];
  for (const k of keys) {
    const longer = keys.find((o) => o !== k && o.includes(k) && [...found.get(k)!].every((t) => found.get(o)!.has(t)));
    if (longer) found.delete(k);
  }

  // A printed claim beats a keyword guess, but we keep a note so the reviewer sees the conflict.
  for (const claim of claims) {
    const removes = CLAIM_REMOVES[claim] ?? [];
    for (const [word, tags] of found) {
      const clash = [...tags].filter((t) => removes.includes(t));
      if (!clash.length) continue;
      notes.push(`Menu marks dish as ${claim} but mentions "${word}"; check this ingredient`);
      clash.forEach((t) => tags.delete(t));
      if (!tags.size) found.delete(word);
    }
  }

  const optionText = `${name} ${description}`;
  const removableTags = new Set<IngredientTag>();
  for (const [re, tags] of OPTION_PATTERNS) if (re.test(optionText)) tags.forEach((t) => removableTags.add(t));
  for (const code of options) {
    const pattern = OPTION_PATTERNS.find(([re]) => re.test(code));
    pattern?.[1].forEach((t) => removableTags.add(t));
  }

  const ingredients: Ingredient[] = [...found].map(([word, tags]) => {
    const contains = [...tags];
    return { name: word, contains, removable: contains.every((t) => removableTags.has(t)) };
  });
  if (removableTags.size) notes.push("Menu offers an alternative on request; review which ingredient is swapped");

  const hasDescription = description.trim().length > 0;
  const confidence: Inference["confidence"] =
    claims.size > 0 && hasDescription ? "high" : !hasDescription && ingredients.length === 0 && claims.size === 0 ? "low" : "medium";
  if (confidence === "low") notes.push("Too little detail on the menu to identify ingredients");

  return { ingredients, claims: [...claims], confidence, notes: [...new Set(notes)] };
}
