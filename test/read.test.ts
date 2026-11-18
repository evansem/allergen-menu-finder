import { describe, expect, it } from "vitest";
import { checkSite, menuLinks, readHtml } from "../src/explorers/read.js";
import { quoteFound, verifyExtraction, type Extraction } from "../src/llm/extract.js";

describe("menuLinks", () => {
  it("keeps the venue's own menu pages and off-site PDFs, best first", () => {
    const html = `
      <a href="/menu">Menu</a>
      <a href="https://cdn.other.com/guide.pdf">Allergen information</a>
      <a href="https://another-site.com/menu">Partner menu</a>
      <a href="/drinks">Drinks</a>
      <a href="https://www.ubereats.com/store/x">Order on Uber Eats</a>
      <a href="http://www.cafe.com.au/food">Food (http)</a>`;
    const links = menuLinks(html, "https://www.cafe.com.au/");
    expect(links.map((l) => l.url)).toEqual(["https://cdn.other.com/guide.pdf", "https://www.cafe.com.au/menu"]);
    expect(links[0]).toMatchObject({ pdf: true, guide: true });
  });
});

describe("readHtml", () => {
  it("reads an allergen table published as a web page", () => {
    const rows = [
      ["Item", "Gluten", "Milk", "Egg", "Soy"],
      ["Burger", "Y", "Y", "", "Y"],
      ["Chips", "", "", "", ""],
      ["Salad", "", "", "Y", "M"],
      ["Shake", "", "Y", "", ""],
    ];
    const html = `<table>${rows.map((r) => `<tr>${r.map((c) => `<td>${c}</td>`).join("")}</tr>`).join("")}</table>`;
    const [fact] = readHtml("https://a.com.au/allergens", html);
    expect(fact).toMatchObject({ type: "source-read", level: "allergen-guide", method: "allergen-matrix" });
  });

  it("says when a page has nothing to read", () => {
    const facts = readHtml("https://a.com.au/about", "<p>We love allergen-aware cooking.</p>");
    expect(facts).toEqual([expect.objectContaining({ type: "not-useful", mentionsAllergens: true })]);
  });
});

describe("checkSite", () => {
  it("rejects parked domains and non-Australian sites when asked", () => {
    expect(checkSite("https://a.com/", "https://a.com/", "This domain is for sale")).toMatch(/parked/);
    expect(checkSite("https://a.com/", "https://a.com/", "Hello", "au")).toMatch(/Australian/);
    expect(checkSite("https://a.com/", "https://a.com/", "Melbourne VIC 3000", "au")).toBeUndefined();
    expect(checkSite("https://a.com.au/", "https://a.com.au/", "Hello", "au")).toBeUndefined();
  });
});

describe("verifyExtraction", () => {
  it("normalises quotes, dashes and spacing", () => {
    expect(quoteFound("Fish ‘n’ chips – $12", "fish 'n' chips - $12")).toBe(true);
    expect(quoteFound("ab", "ab")).toBe(false);
  });

  it("only counts guide columns whose headers are in the source", () => {
    const x: Extraction = {
      kind: "allergen-guide",
      dietKey: [],
      guideColumns: [
        { header: "Gluten", tags: ["gluten"] },
        { header: "Sesame", tags: ["sesame"] },
      ],
      dishes: [{ name: "Burger", section: "Mains", description: null, price: null, claims: [], contains: ["gluten"], mayContain: [], quote: "Burger Y" }],
    };
    const fact = verifyExtraction("https://a.com.au/g.pdf", "pdf", x, "Item Gluten Milk\nBurger Y Y");
    expect(fact).toMatchObject({ type: "source-read", level: "allergen-guide" });
    if (fact.type !== "source-read") throw new Error();
    expect(fact.dishes[0].allergens!.covered).toEqual(["gluten"]);
    expect(fact.notes.join(" ")).toMatch(/Sesame/);
  });
});
