import { parse } from "node-html-parser";
import type { EvidenceLevel } from "../domain.js";
import type { FactData, FoundLink, ObservedDish } from "../graph/types.js";
import { parseDietCodes } from "../vendor/allergenInference.js";
import { parseAllergenMatrix, plausibleMatrix } from "../vendor/allergenMatrix.js";
import { parseMenuHtml, parseMenuText, type RawMenu } from "../vendor/parseMenu.js";

/** Social, delivery, booking and review sites: never the venue's own information. */
const THIRD_PARTY =
  /(^|\.)(instagram|facebook|tiktok|twitter|x|youtube|ubereats|doordash|menulog|deliveroo|ordereats|opentable|sevenrooms|resy|quandoo|tripadvisor|google|yelp|zomato|linktr)\.[a-z.]+$/i;
const MENU_WORDS = /\b(menus?|food|eat|dining|kitchen|allergens?|allergy|dietary|nutrition)\b/i;
export const GUIDE_WORDS = /allergen|allergy|dietary|nutrition|coeliac|celiac/i;
const NOT_FOOD = /\b(drinks?|wines?|wine list|beverages?|cocktails?|spirits|functions?|events?|whats on|gift ?cards?|vouchers?|careers?)\b/i;
const FOOD = /\b(food|eat|dining|kitchen|breakfast|brunch|lunch|dinner|a la carte|bistro|pizza|dessert)\b/i;
const SECOND_LEVEL = new Set(["com", "net", "org", "edu", "gov", "co", "asn", "id"]);

/** The registrable domain, e.g. `www.grilld.com.au` → `grilld.com.au`. */
export function siteDomain(url: string): string {
  const labels = new URL(url).hostname.toLowerCase().split(".");
  const n = labels.length >= 3 && labels.at(-1)!.length === 2 && SECOND_LEVEL.has(labels.at(-2)!) ? 3 : 2;
  return labels.slice(-n).join(".");
}

export const pageText = (html: string) =>
  html
    .replace(/<(script|style|noscript)\b[\s\S]*?<\/\1>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();

/**
 * Links on a page that probably lead to a menu or allergen guide. Pages must be
 * on the venue's own site; PDFs may be on a CDN, since chains often host them there.
 */
export function menuLinks(html: string, pageUrl: string, limit = 8): FoundLink[] {
  const own = siteDomain(pageUrl);
  const found = new Map<string, FoundLink & { score: number }>();
  for (const m of html.matchAll(/<a\b[^>]*\bhref\s*=\s*["']([^"'#][^"']*)["'][^>]*>([\s\S]*?)<\/a>/gi)) {
    let url: URL;
    try {
      url = new URL(m[1].replace(/&amp;/g, "&"), pageUrl);
    } catch {
      continue;
    }
    if (url.protocol !== "https:" || THIRD_PARTY.test(url.hostname)) continue;
    const text = m[2].replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
    const path = decodeURIComponent(url.pathname);
    const pdf = /\.pdf$/i.test(path);
    if (!pdf && siteDomain(url.href) !== own) continue;
    const label = `${text} ${path.replace(/[-_/+.]/g, " ")}`;
    const words = label.replace(/[-_/+.%0-9]+/g, " ");
    if (!MENU_WORDS.test(label) || (NOT_FOOD.test(words) && !FOOD.test(words) && !GUIDE_WORDS.test(words))) continue;
    const guide = GUIDE_WORDS.test(label);
    const score = (guide ? 4 : 0) + (pdf ? 2 : 0) + (/\bmenus?\b/i.test(label) ? 1 : 0);
    url.hash = "";
    const prev = found.get(url.href);
    if (!prev || prev.score < score) found.set(url.href, { url: url.href, label: text.slice(0, 80), pdf, guide, score });
  }
  return [...found.values()]
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map(({ score: _score, ...link }) => link);
}

/** Rows of every HTML table, for allergen guides published as web pages. */
export function htmlTables(html: string): string[][][] {
  return parse(html)
    .querySelectorAll("table")
    .map((t) => t.querySelectorAll("tr").map((tr) => tr.querySelectorAll("th,td").map((c) => c.textContent.replace(/\s+/g, " ").trim())))
    .filter((rows) => rows.length >= 3);
}

const labelledCount = (menu: RawMenu) => menu.items.filter((i) => i.claims?.length || parseDietCodes(i.name).claims.length).length;

function dishes(menu: RawMenu): ObservedDish[] {
  return menu.items.map((i) => ({
    name: i.name,
    section: i.category,
    ...(i.description && { description: i.description }),
    ...(i.price && { price: i.price }),
    ...(i.claims?.length && { claims: i.claims }),
    ...(i.allergens && { allergens: i.allergens }),
  }));
}

/** A real menu has enough dishes with prices or diet labels; navigation and event lists don't. */
export function looksLikeMenu(menu: RawMenu, minDishes = 5): boolean {
  if (menu.items.length < minDishes) return false;
  if (menu.method === "allergen-matrix") return true;
  return menu.items.filter((i) => i.price).length >= minDishes || labelledCount(menu) >= 3;
}

function sourceRead(url: string, format: "html" | "pdf" | "text", menu: RawMenu, notes: string[] = []): FactData {
  const labelled = labelledCount(menu);
  const level: EvidenceLevel = menu.method === "allergen-matrix" ? "allergen-guide" : labelled >= 3 ? "labelled-menu" : "description-only";
  return { type: "source-read", url, format, method: menu.method, level, dishes: dishes(menu), labelled, notes };
}

/** What an HTML page tells us: an allergen table, a menu, links to follow, or nothing useful. */
export function readHtml(url: string, html: string, linkLimit?: number): FactData[] {
  const facts: FactData[] = [];
  for (const rows of htmlTables(html)) {
    if (!plausibleMatrix(rows)) continue;
    try {
      facts.push(sourceRead(url, "html", parseAllergenMatrix(rows), ["Read from an allergen table on the page"]));
      break;
    } catch {
      // Not an allergen table after all.
    }
  }
  if (!facts.length) {
    const menu = parseMenuHtml(html);
    if (looksLikeMenu(menu)) facts.push(sourceRead(url, "html", menu));
  }
  const links = menuLinks(html, url, linkLimit);
  if (links.length) facts.push({ type: "links-found", from: url, links });
  if (!facts.some((f) => f.type === "source-read")) {
    const text = pageText(html);
    facts.push({
      type: "not-useful",
      url,
      format: "html",
      reason: "No menu or allergen table found on the page",
      textLength: text.length,
      mentionsAllergens: GUIDE_WORDS.test(text),
    });
  }
  return facts;
}

export interface PdfReader {
  rows(bytes: Uint8Array): Promise<string[][]>;
  text(bytes: Uint8Array): Promise<string>;
}

/** What a PDF tells us: an allergen matrix, a menu, or nothing a parser can read. */
export async function readPdf(url: string, bytes: Uint8Array, pdf: PdfReader): Promise<FactData[]> {
  const rows = await pdf.rows(bytes).catch(() => [] as string[][]);
  if (rows.length && plausibleMatrix(rows)) {
    try {
      return [sourceRead(url, "pdf", parseAllergenMatrix(rows), ["Columns recovered from PDF text positions; check the dish list"])];
    } catch {
      // Fall through to reading it as a menu.
    }
  }
  const text = await pdf.text(bytes).catch(() => "");
  const menu = parseMenuText(text);
  if (looksLikeMenu(menu)) return [sourceRead(url, "pdf", menu)];
  return [
    {
      type: "not-useful",
      url,
      format: "pdf",
      reason: text.trim() ? "The parsers couldn't read a menu or allergen table from this PDF" : "The PDF has no text layer (probably scanned)",
      textLength: text.length,
      mentionsAllergens: GUIDE_WORDS.test(text),
    },
  ];
}

const PARKED =
  /\b(domain (name )?(is )?for sale|buy this domain|this domain (has expired|may be for sale)|parked (free|domain)|account (has been )?suspended|website (is )?(coming soon|under construction))\b/i;
const AUSTRALIAN = /\b(australia|nsw|vic|qld|tas|act|wa|sa|nt)\s+\d{4}\b|\baustralia\b|\+61\s?\d|\(0[2378]\)\s?\d{4}|\b1[38]00\s?\d{3}\s?\d{3}\b/i;

/**
 * Whether a home page is the venue's current site: no redirect to another
 * site, not parked or suspended, and, when a country is required, an .au
 * domain or an Australian address or phone number.
 */
export function checkSite(website: string, finalUrl: string, html: string, country?: "au"): string | undefined {
  if (siteDomain(finalUrl) !== siteDomain(website)) return `redirected to ${new URL(finalUrl).hostname}`;
  const text = pageText(html);
  if (PARKED.test(text)) return "the domain is parked, suspended or for sale";
  if (country === "au" && !/\.au$/i.test(new URL(finalUrl).hostname) && !AUSTRALIAN.test(text)) {
    return "no Australian address or phone number on the home page";
  }
  return undefined;
}
