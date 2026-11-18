import { columnMeaning } from "./allergenMatrix.js";

/**
 * Recovers the rows of an allergen matrix from a PDF.
 *
 * Plain text extraction drops empty cells, so "Y Y" under twelve allergen
 * columns can't be placed. This reads each piece of text with its position and
 * assigns marks to the column whose header sits above them. Only used by the
 * command line tools, never on the server.
 */

interface Piece {
  text: string;
  x: number;
  y: number;
  size: number;
}

interface Line {
  y: number;
  size: number;
  pieces: Piece[];
}

interface Column {
  center: number;
  header: string;
}

interface Layout {
  columns: Column[];
  /** Text left of this x is the item name. */
  nameEdge: number;
  halfGap: number;
}

async function pagesOf(data: Uint8Array): Promise<Piece[][]> {
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  // pdf.js detaches the buffer it is given, so it gets a copy.
  const task = pdfjs.getDocument({ data: data.slice(), disableFontFace: true, useSystemFonts: false });
  const doc = await task.promise;
  const pages: Piece[][] = [];
  for (let n = 1; n <= doc.numPages; n++) {
    const page = await doc.getPage(n);
    const content = await page.getTextContent();
    const pieces: Piece[] = [];
    for (const item of content.items) {
      if (!("str" in item) || !item.str.trim()) continue;
      const [a, b, , d, e, f] = item.transform as number[];
      const rotated = Math.abs(b) > Math.abs(a);
      const size = Math.hypot(a, b) || Math.abs(d) || 10;
      // Upright text is centred on its width; rotated (column header) text sits on its baseline.
      const x = rotated ? e - size / 2 : e + item.width / 2;
      pieces.push({ text: item.str.replace(/\s+/g, " ").trim(), x, y: f, size });
    }
    pages.push(pieces);
  }
  await task.destroy();
  return pages;
}

function toLines(pieces: Piece[]): Line[] {
  const sorted = [...pieces].sort((p, q) => q.y - p.y || p.x - q.x);
  const lines: Line[] = [];
  for (const p of sorted) {
    const line = lines[lines.length - 1];
    if (line && Math.abs(line.y - p.y) <= Math.min(line.size, p.size) * 0.45) line.pieces.push(p);
    else lines.push({ y: p.y, size: p.size, pieces: [p] });
  }
  lines.forEach((l) => l.pieces.sort((p, q) => p.x - q.x));
  return lines;
}

const isAllergenHeader = (text: string) => {
  const m = columnMeaning(text);
  return !!m && "tags" in m;
};

/** Finds the header line and merges header text that wraps onto the lines around it. */
function findLayout(lines: Line[]): { layout: Layout; headerEnd: number } | undefined {
  let best = -1;
  let bestCount = 2;
  lines.forEach((l, i) => {
    const count = l.pieces.filter((p) => isAllergenHeader(p.text)).length;
    if (count > bestCount) [best, bestCount] = [i, count];
  });
  if (best < 0) return undefined;

  const anchors = lines[best].pieces.filter((p) => columnMeaning(p.text));
  const gaps = anchors.slice(1).map((p, i) => p.x - anchors[i].x).sort((a, b) => a - b);
  const halfGap = (gaps[Math.floor(gaps.length / 2)] ?? 20) / 2;

  // Wrapped headers ("TREE" over "NUTS") sit within a couple of lines of the anchor line.
  const band = [best];
  for (const step of [-1, 1]) {
    for (let i = best + step; i >= 0 && i < lines.length && Math.abs(lines[i].y - lines[best].y) < lines[best].size * 2.6; i += step) {
      // A line with text in the name area, or with marks, is already a table row.
      const underHeaders = lines[i].pieces.every((p) => p.text.length > 2 && anchors.some((a) => Math.abs(a.x - p.x) < halfGap * 0.9));
      if (!underHeaders) break;
      band.push(i);
    }
  }
  const headerPieces = band.flatMap((i) => lines[i].pieces.map((p) => ({ ...p, line: i })));
  const columns: Column[] = anchors.map((a) => {
    const parts = headerPieces.filter((p) => Math.abs(p.x - a.x) < halfGap * 0.9).sort((p, q) => p.line - q.line);
    return { center: a.x, header: parts.map((p) => p.text).join(" ") };
  });
  for (const p of headerPieces) {
    if (p.x <= anchors[0].x - halfGap) continue;
    if (columns.some((c) => Math.abs(c.center - p.x) < halfGap * 0.9)) continue;
    // A header that names no allergen on its own (e.g. "MSG", "Halal") still owns its column.
    if (p.line === best) columns.push({ center: p.x, header: p.text });
  }
  columns.sort((a, b) => a.center - b.center);
  return { layout: { columns, nameEdge: columns[0].center - halfGap, halfGap }, headerEnd: Math.max(...band) };
}

function rowOf(line: Line, layout: Layout): { name: string; cells: string[] } {
  const name: string[] = [];
  const cells = layout.columns.map(() => [] as string[]);
  for (const p of line.pieces) {
    if (p.x < layout.nameEdge) {
      name.push(p.text);
      continue;
    }
    let nearest = 0;
    layout.columns.forEach((c, i) => {
      if (Math.abs(c.center - p.x) < Math.abs(layout.columns[nearest].center - p.x)) nearest = i;
    });
    if (Math.abs(layout.columns[nearest].center - p.x) <= layout.halfGap * 1.2) cells[nearest].push(p.text);
    else name.push(p.text);
  }
  return { name: name.join(" "), cells: cells.map((c) => c.join(" ")) };
}

/**
 * Returns a table: a header row ("Item", then each column header) followed by
 * one row per PDF line. Pages without their own header reuse the last one.
 */
export async function pdfMatrixRows(data: Uint8Array): Promise<string[][]> {
  const rows: string[][] = [];
  let layout: Layout | undefined;
  for (const pieces of await pagesOf(data)) {
    const lines = toLines(pieces);
    const found = findLayout(lines);
    if (found) layout = found.layout;
    if (!layout) continue;
    if (!rows.length) rows.push(["Item", ...layout.columns.map((c) => c.header)]);
    let previous: { line: Line; row: string[] } | undefined;
    for (const line of lines.slice(found ? found.headerEnd + 1 : 0)) {
      const { name, cells } = rowOf(line, layout);
      if (!name && cells.every((c) => !c)) continue;
      // Item names that wrap onto a tightly spaced next line belong to the row above.
      const tight = previous && previous.line.y - line.y < Math.min(previous.line.size, line.size) * 1.15;
      if (previous && tight && name && cells.every((c) => !c)) {
        previous.row[0] = `${previous.row[0]} ${name}`.trim();
        continue;
      }
      const row = [name, ...cells];
      rows.push(row);
      previous = { line, row };
    }
  }
  return rows;
}

/** All text in reading order, for PDF menus that are lists of dishes rather than tables. */
export async function pdfText(data: Uint8Array): Promise<string> {
  const pages = await pagesOf(data);
  return pages.map((pieces) => toLines(pieces).map((l) => l.pieces.map((p) => p.text).join(" ")).join("\n")).join("\n\n");
}
