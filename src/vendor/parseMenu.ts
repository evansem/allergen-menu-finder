import { parse, type HTMLElement } from "node-html-parser";
import type { MatrixAllergens } from "./allergenMatrix.js";

export interface RawMenuItem {
  name: string;
  description?: string;
  price?: string;
  category: string;
  /** Diet claims found in structured data (schema.org suitableForDiet). */
  claims?: string[];
  /** Explicit allergen data from a published allergen guide. */
  allergens?: MatrixAllergens;
}

export interface RawMenu {
  restaurantName?: string;
  address?: string;
  cuisine?: string;
  latitude?: number;
  longitude?: number;
  items: RawMenuItem[];
  method: "json-ld" | "html-heuristic" | "text" | "allergen-matrix";
}

const DEFAULT_CATEGORY = "Menu";
const BARE_PRICE_RE = /^\s*(?:(?:NZ|AU|US)?[$£€]\s?)?\d{1,3}(?:[.,]\d{1,2})?\s*$/;
const PRICE_RE = /(?:^|\s)((?:NZ|AU|US)?[$£€]\s?\d{1,3}(?:[.,]\d{1,2})?|\d{1,3}[.,]\d{2}|\d{1,3}(?=\s*$))\s*$/;

const SCHEMA_DIETS: Record<string, string> = {
  VegetarianDiet: "vegetarian",
  VeganDiet: "vegan",
  GlutenFreeDiet: "gluten-free",
};

// ---------------------------------------------------------------------------
// 1. schema.org JSON-LD (many website builders and ordering platforms emit it)
// ---------------------------------------------------------------------------

type Json = Record<string, unknown>;

function asArray<T>(v: T | T[] | undefined): T[] {
  return v === undefined ? [] : Array.isArray(v) ? v : [v];
}

function typeOf(node: Json): string[] {
  return asArray(node["@type"] as string | string[]).map(String);
}

function text(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() ? v.trim() : undefined;
}

function walkJson(node: unknown, visit: (n: Json) => void) {
  if (Array.isArray(node)) node.forEach((n) => walkJson(n, visit));
  else if (node && typeof node === "object") {
    visit(node as Json);
    Object.values(node as Json).forEach((v) => walkJson(v, visit));
  }
}

function menuItemsFromSection(section: Json, category: string, out: RawMenuItem[]) {
  const name = text(section.name) ?? category;
  for (const item of asArray(section.hasMenuItem as Json | Json[])) {
    const itemName = text(item.name);
    if (!itemName) continue;
    const offers = asArray(item.offers as Json | Json[])[0];
    const price = offers ? text(String(offers.price ?? "")) : undefined;
    const claims = asArray(item.suitableForDiet as string | string[])
      .map((d) => SCHEMA_DIETS[String(d).split("/").pop() ?? ""])
      .filter(Boolean);
    out.push({ name: itemName, description: text(item.description), price, category: name, claims });
  }
  for (const sub of asArray(section.hasMenuSection as Json | Json[])) menuItemsFromSection(sub, name, out);
}

export function parseJsonLd(html: string): RawMenu | undefined {
  const root = parse(html);
  const items: RawMenuItem[] = [];
  const result: RawMenu = { items, method: "json-ld" };

  for (const script of root.querySelectorAll('script[type="application/ld+json"]')) {
    let data: unknown;
    try {
      data = JSON.parse(script.textContent);
    } catch {
      continue;
    }
    walkJson(data, (node) => {
      const types = typeOf(node);
      if (types.some((t) => ["Restaurant", "FoodEstablishment", "CafeOrCoffeeShop", "BarOrPub"].includes(t))) {
        result.restaurantName ??= text(node.name);
        result.cuisine ??= asArray(node.servesCuisine as string | string[]).join(", ") || undefined;
        const addr = node.address as Json | string | undefined;
        if (typeof addr === "string") result.address ??= addr;
        else if (addr) {
          result.address ??= [addr.streetAddress, addr.addressLocality].filter(Boolean).join(", ") || undefined;
        }
        const geo = node.geo as Json | undefined;
        if (geo) {
          result.latitude ??= Number(geo.latitude) || undefined;
          result.longitude ??= Number(geo.longitude) || undefined;
        }
      }
      if (types.includes("Menu")) menuItemsFromSection(node, DEFAULT_CATEGORY, items);
    });
  }
  // A Restaurant node can embed the Menu; dedupe in case both were visited.
  const seen = new Set<string>();
  result.items = items.filter((i) => {
    const key = `${i.category}|${i.name}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  return result.items.length ? result : undefined;
}

// ---------------------------------------------------------------------------
// 2. Text heuristics, used for plain HTML pages and pasted / PDF-exported text
// ---------------------------------------------------------------------------

interface Line {
  text: string;
  heading: boolean;
}

const BLOCK_TAGS = new Set(["H1", "H2", "H3", "H4", "H5", "H6", "P", "LI", "DT", "DD", "TD", "TH", "DIV", "SPAN", "STRONG", "B", "EM", "SECTION", "ARTICLE"]);
const SKIP_TAGS = new Set(["SCRIPT", "STYLE", "NOSCRIPT", "NAV", "FOOTER", "HEADER", "FORM", "BUTTON", "SVG", "IFRAME", "SELECT"]);

/** Text of an element with a space between children, so <span>Name</span><span>$12</span> stays readable. */
function spacedText(node: HTMLElement): string {
  if (!node.childNodes?.length) return node.textContent;
  return node.childNodes.map((c) => ((c as HTMLElement).tagName ? spacedText(c as HTMLElement) : c.textContent)).join(" ");
}

function clean(s: string): string {
  return s.replace(/&amp;/g, "&").replace(/&nbsp;/g, " ").replace(/\s+/g, " ").trim();
}

/** Flattens HTML into lines, keeping headings, and treating an element as a line when it has no block children. */
function htmlToLines(root: HTMLElement): Line[] {
  const lines: Line[] = [];
  const visit = (el: HTMLElement) => {
    if (SKIP_TAGS.has(el.tagName)) return;
    const blockChildren = el.childNodes.filter(
      (c): c is HTMLElement => (c as HTMLElement).tagName !== undefined && BLOCK_TAGS.has((c as HTMLElement).tagName) && !["SPAN", "STRONG", "B", "EM"].includes((c as HTMLElement).tagName),
    );
    if (blockChildren.length === 0 || /^H[1-6]$/.test(el.tagName)) {
      const t = clean(spacedText(el));
      if (t) {
        lines.push({ text: t, heading: /^H[1-6]$/.test(el.tagName) });
      }
      return;
    }
    el.childNodes.forEach((c) => {
      if ((c as HTMLElement).tagName) visit(c as HTMLElement);
      else {
        const t = clean(c.textContent);
        if (t) lines.push({ text: t, heading: false });
      }
    });
  };
  visit(root.querySelector("main") ?? root.querySelector("body") ?? root);
  return lines;
}

function looksLikeHeading(line: string): boolean {
  if (PRICE_RE.test(line) || line.length > 40) return false;
  const letters = line.replace(/[^A-Za-z]/g, "");
  return letters.length >= 3 && letters === letters.toUpperCase();
}

function linesToItems(lines: Line[]): RawMenuItem[] {
  const items: RawMenuItem[] = [];
  let category = DEFAULT_CATEGORY;
  let last: RawMenuItem | undefined;

  for (let i = 0; i < lines.length; i++) {
    const { text: line, heading } = lines[i];
    if (line.length > 400) continue;
    const priceMatch = line.match(PRICE_RE);

    if (priceMatch) {
      const name = clean(line.slice(0, priceMatch.index).replace(/[.·…\-–|]+\s*$/, ""));
      if (name.length >= 2 && name.length <= 120) {
        // "Name — description $18": split on a dash or the first full stop if the name is long.
        const split = name.match(/^(.{2,60}?)\s+[–—-]\s+(.+)$/) ?? (name.length > 60 ? name.match(/^(.{2,60}?)[.:]\s+(.+)$/) : null);
        last = {
          name: split ? split[1] : name,
          description: split ? split[2] : undefined,
          price: priceMatch[1].trim(),
          category,
        };
        items.push(last);
        continue;
      }
      // A bare price on its own line belongs to the previous unpriced name.
      if (!name && last && !last.price) {
        last.price = priceMatch[1].trim();
        continue;
      }
    }

    const next = lines[i + 1]?.text;
    // Name on one line (often an <h3>), price on the next.
    if (next && BARE_PRICE_RE.test(next) && line.length <= 80) {
      last = { name: line, category, price: next.trim() };
      items.push(last);
      i++;
      continue;
    }

    if (heading || looksLikeHeading(line)) {
      category = line.replace(/:$/, "");
      last = undefined;
      continue;
    }

    if (last && !last.description && line.length > 10 && !PRICE_RE.test(line)) {
      last.description = line;
    }
  }

  return items.filter((it) => !/^(menu|price|order|book|reservations?)$/i.test(it.name));
}

export function parseMenuHtml(html: string): RawMenu {
  const structured = parseJsonLd(html);
  if (structured) return structured;

  const root = parse(html);
  const title = clean(root.querySelector('meta[property="og:site_name"]')?.getAttribute("content") ?? root.querySelector("title")?.textContent ?? "");
  return {
    restaurantName: title.split(/\s[|–—-]\s/)[0] || undefined,
    items: linesToItems(htmlToLines(root)),
    method: "html-heuristic",
  };
}

const FIELD_SEPARATOR = /\s+[—–|]\s+/;

/** "- Name (V) — description — $12": an explicit item line, so unpriced dishes are kept too. */
function explicitItem(line: string, category: string): RawMenuItem | undefined {
  const parts = line.replace(/^[-*]\s+/, "").split(FIELD_SEPARATOR).map((p) => p.trim()).filter(Boolean);
  if (!parts.length || parts[0].length > 120) return undefined;
  const last = parts.length > 1 ? parts[parts.length - 1] : undefined;
  const price = last && (BARE_PRICE_RE.test(last) || /^(?:[$£€]\s?)?\d{1,3}(?:[.,]\d{1,2})?\s*(?:ea|pp|p\/p)?$/i.test(last)) ? last : undefined;
  const rest = price ? parts.slice(1, -1) : parts.slice(1);
  return { name: parts[0], description: rest.join(" — ") || undefined, price, category };
}

/**
 * For menus copied from PDFs, photos (after OCR) or delivery apps. Lines that
 * start with "#" are section headings; lines that start with "- " are one dish
 * each, with fields separated by " — ".
 */
export function parseMenuText(text: string): RawMenu {
  const lines = text
    .split(/\r?\n/)
    .map((l) => clean(l))
    .filter(Boolean);
  if (lines.some((l) => /^[-*]\s/.test(l))) {
    const items: RawMenuItem[] = [];
    let category = DEFAULT_CATEGORY;
    for (const l of lines) {
      if (/^#+\s/.test(l)) category = l.replace(/^#+\s*/, "");
      else if (/^[-*]\s/.test(l)) {
        const item = explicitItem(l, category);
        if (item) items.push(item);
      }
    }
    return { items, method: "text" };
  }
  return {
    items: linesToItems(lines.map((l) => ({ text: l.replace(/^#+\s*/, ""), heading: /^#+\s/.test(l) }))),
    method: "text",
  };
}
