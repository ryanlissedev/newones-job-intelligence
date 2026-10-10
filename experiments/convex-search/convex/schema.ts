import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

/**
 * Mirror of ManticoreIndexedDocument (packages/search/src/manticore/json.ts).
 *
 * Convex constraint discovered at schema time: a search index has exactly ONE
 * searchField. Manticore searches @(titel,beschrijving); to approximate that
 * we denormalise both into `zoektekst` at ingest. That means titel loses any
 * field-level ranking boost and the document stores the text twice.
 */
export default defineSchema({
  aanvragen: defineTable({
    beschrijving: v.string(),
    bronId: v.string(),
    contracttype: v.string(),
    documentId: v.string(),
    laatstGezienOp: v.number(),
    locatieLand: v.string(),
    status: v.string(),
    tariefMax: v.number(),
    tariefMin: v.number(),
    titel: v.string(),
    zoektekst: v.string(),
  })
    .index("by_document_id", ["documentId"])
    .searchIndex("search_zoektekst", {
      filterFields: ["bronId", "contracttype", "locatieLand", "status"],
      searchField: "zoektekst",
    }),
});
