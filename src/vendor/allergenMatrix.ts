import type { IngredientTag } from "../domain.js";
import { UserError } from "../errors.js";
import type { RawMenu, RawMenuItem } from "./parseMenu.js";

/**
 * Allergen matrices ("allergen guides") are the most reliable source a chain
 * publishes: one row per item, one column per allergen, a mark per cell. This
 * module turns such a table (from a CSV, or rows recovered from a PDF) into menu
 * items with explicit allergen data instead of keyword guesses.
 */

export interface MatrixAllergens {
  contains: IngredientTag[];
  mayContain: IngredientTag[];
  /** Tags the guide has a column for, so a blank cell means "not present". */
  covered: IngredientTag[];
}

type ColumnMeaning = { tags: IngredientTag[] } | { diet: string };

/** Header text → meaning. First match wins, so specific patterns come first. */
const HEADER_PATTERNS: Array<[RegExp, ColumnMeaning]> = [
  [/gluten[- ]?(free|friendly)|coeliac|celiac/i, { diet: "gluten-free" }],
  [/dairy[- ]?free/i, { diet: "dairy-free" }],
  [/vegan/i, { diet: "vegan" }],
  [/vegetarian|^veg$/i, { diet: "vegetarian" }],
  [/fish\s*(?:\/|&|and)\s*shellfish/i, { tags: ["fish", "crustaceans", "molluscs"] }],
  [/shellfish/i, { tags: ["crustaceans", "molluscs"] }],
  [/crustace/i, { tags: ["crustaceans"] }],
  [/mollus/i, { tags: ["molluscs"] }],
  [/fish/i, { tags: ["fish"] }],
  [/gluten|wheat|barley|\brye\b|\boats?\b|spelt/i, { tags: ["gluten"] }],
  [/egg/i, { tags: ["egg"] }],
  [/milk|dairy|lactose/i, { tags: ["milk"] }],
  [/soy/i, { tags: ["soy"] }],
  [/peanut/i, { tags: ["peanuts"] }],
  [/tree\s*nut|^nuts?$|almond|brazil|cashew|hazelnut|macadamia|pecan|pine\s*nut|pistachio|walnut/i, { tags: ["tree-nuts"] }],
  [/sesame/i, { tags: ["sesame"] }],
  [/lupin/i, { tags: ["lupin"] }],
  [/sulph|sulf/i, { tags: ["sulphites"] }],
  [/mustard/i, { tags: ["mustard"] }],
  [/celery|celeriac/i, { tags: ["celery"] }],
];

export function columnMeaning(header: string): ColumnMeaning | undefined {
  const h = header.replace(/\s+/g, " ").trim();
  if (!h) return undefined;
  return HEADER_PATTERNS.find(([re]) => re.test(h))?.[1];
}

export type Mark = "contains" | "may" | "none";

const CONTAINS_MARKS = new Set(["y", "yes", "p", "present", "x", "c", "contains", "true", "1", "✓", "✔", "●", "•", "■", "◆"]);
const MAY_MARKS = new Set(["m", "mc", "t", "tr", "trace", "traces", "may", "may contain", "may contain traces", "~", "?", "◐", "○"]);
const NONE_MARKS = new Set(["", "n", "no", "-", "–", "—", "0", "false", "none", "nil"]);

/**
 * Reads one cell. Anything unrecognised counts as "contains": a guide that marks
 * a cell is saying something about it, and over-flagging is the safe mistake.
 */
export function readMark(cell: string): Mark {
  const trimmed = cell.replace(/\s+/g, " ").trim().toLowerCase();
  // Guides that tick "contains" use a lone asterisk for traces.
  if (/^\*+$/.test(trimmed)) return "may";
  const c = trimmed.replace(/\*+$/, "");
  if (NONE_MARKS.has(c)) return "none";
  if (MAY_MARKS.has(c) || /^may\b|trace/.test(c)) return "may";
  if (CONTAINS_MARKS.has(c)) return "contains";
  return "contains";
}

/** A diet column marks suitability, so only an explicit yes counts. */
function readDietMark(cell: string): boolean {
  const c = cell.trim().toLowerCase();
  return ["y", "yes", "✓", "✔", "●", "•", "true", "1", "suitable"].includes(c);
}

export interface MatrixOptions {
  /** Tags the guide states are absent from the whole menu ("No crustacea, sulphites or lupin present"). */
  absent?: IngredientTag[];
  /** Section heading used until the table names one. */
  defaultCategory?: string;
}

interface Layout {
  item: number;
  category?: number;
  columns: Array<{ index: number; meaning: ColumnMeaning; header: string }>;
}

function findLayout(rows: string[][]): { layout: Layout; headerRow: number } | undefined {
  for (let r = 0; r < Math.min(rows.length, 20); r++) {
    const cells = rows[r];
    const columns = cells
      .map((header, index) => ({ index, header, meaning: columnMeaning(header) }))
      .filter((c): c is Layout["columns"][number] => c.meaning !== undefined);
    if (columns.filter((c) => "tags" in c.meaning).length < 3) continue;
    const first = Math.min(...columns.map((c) => c.index));
    const leading = cells.slice(0, first).map((c) => c.trim().toLowerCase());
    const category = leading.findIndex((c) => /^(category|section|menu|type)$/.test(c));
    const named = leading.findIndex((c, i) => i !== category && /item|product|name|dish|ingredient|menu/.test(c));
    const item = named >= 0 ? named : category === 0 ? 1 : 0;
    if (item >= first) continue;
    return { layout: { item, category: category >= 0 ? category : undefined, columns }, headerRow: r };
  }
  return undefined;
}

/**
 * Whether rows recovered from a PDF really are an allergen guide, not a menu or
 * wine list whose text happens to mention three allergens: the allergen headers
 * are short column titles and nearly every filled cell under them is a mark
 * (a tick, dot, letter or "may contain"), not words.
 */
export function plausibleMatrix(rows: string[][]): boolean {
  const found = findLayout(rows);
  if (!found) return false;
  const { layout, headerRow } = found;
  if (layout.columns.some((c) => c.header.replace(/\s+/g, " ").trim().length > 30)) return false;
  const cells = rows
    .slice(headerRow + 1)
    .filter((r) => (r[layout.item] ?? "").trim() && !findLayout([r]))
    .flatMap((r) => layout.columns.map((c) => (r[c.index] ?? "").trim().toLowerCase()))
    .filter(Boolean);
  if (cells.length < 5) return false;
  const marks = cells.filter((c) => c.length <= 3 || CONTAINS_MARKS.has(c) || MAY_MARKS.has(c) || NONE_MARKS.has(c) || /may contain|trace/.test(c));
  return marks.length / cells.length >= 0.9;
}

/**
 * Parses a table whose header row names allergen columns. A row with an item
 * name and no marks at all, in a table without a category column, is read as a
 * section heading (how most PDF guides group their rows).
 */
export function parseAllergenMatrix(rows: string[][], opts: MatrixOptions = {}): RawMenu {
  const found = findLayout(rows);
  if (!found) throw new UserError("Couldn't find an allergen header row (expected columns such as Gluten, Egg, Milk)");
  const { layout, headerRow } = found;
  const covered = new Set<IngredientTag>(opts.absent ?? []);
  for (const c of layout.columns) if ("tags" in c.meaning) c.meaning.tags.forEach((t) => covered.add(t));

  const items: RawMenuItem[] = [];
  let category = opts.defaultCategory ?? "Menu";
  for (const cells of rows.slice(headerRow + 1)) {
    const name = (cells[layout.item] ?? "").replace(/\s+/g, " ").trim();
    if (!name) continue;
    // Repeated header rows (one per PDF page) are not items.
    if (findLayout([cells])) continue;
    const marks = layout.columns.map((c) => cells[c.index] ?? "");
    if (layout.category !== undefined) category = cells[layout.category]?.trim() || category;
    else if (marks.every((m) => !m.trim()) && name === name.toUpperCase() && /[A-Z]/.test(name) && name.length <= 40) {
      category = name;
      continue;
    }

    const contains = new Set<IngredientTag>();
    const mayContain = new Set<IngredientTag>();
    const claims = new Set<string>();
    layout.columns.forEach((c, i) => {
      if ("diet" in c.meaning) {
        if (readDietMark(marks[i])) claims.add(c.meaning.diet);
        return;
      }
      const mark = readMark(marks[i]);
      if (mark === "contains") c.meaning.tags.forEach((t) => contains.add(t));
      else if (mark === "may") c.meaning.tags.forEach((t) => mayContain.add(t));
    });
    for (const t of contains) mayContain.delete(t);

    items.push({
      name,
      category,
      claims: [...claims],
      allergens: { contains: [...contains], mayContain: [...mayContain], covered: [...covered] },
    });
  }
  return { items, method: "allergen-matrix" };
}

/** Minimal RFC 4180 reader: quoted fields, doubled quotes, CRLF. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') {
        field += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else field += ch;
    } else if (ch === '"' && field === "") quoted = true;
    else if (ch === ",") {
      row.push(field);
      field = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      row.push(field);
      if (row.some((c) => c.trim())) rows.push(row);
      row = [];
      field = "";
    } else field += ch;
  }
  row.push(field);
  if (row.some((c) => c.trim())) rows.push(row);
  return rows;
}
