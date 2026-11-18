# Vendored parsers

Copied from What Can I Eat? (`src/lib/extraction/` in github.com/evansem/what-can-i-eat), with import paths adjusted:

- `parseMenu.ts`: schema.org Menu JSON-LD and heuristic HTML and text menu parsing
- `allergenMatrix.ts`: allergen guide tables (items against allergen columns)
- `allergenInference.ts`: keyword allergen inference and diet codes
- `pdfTable.ts`: table rows and text from PDFs, by text position

`src/net/safeFetch.ts` started from `fetchMenuPage.ts` there. Fixes in either repository should be copied to the other.
