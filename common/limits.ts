// Dependency-free so the browser bundle can import it without pulling in zod.
// Saved searches render their matching documents as a table. Each one is capped
// at this many rows, in the query sent to OpenSearch, in the companion, and in the PDF.
export const SEARCH_ROW_LIMIT = 1000;
