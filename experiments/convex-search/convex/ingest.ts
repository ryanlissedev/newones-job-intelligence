import { v } from "convex/values";

import { mutation, query } from "./_generated/server";

const documentValidator = v.object({
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
});

export const upsertBatch = mutation({
  args: { documents: v.array(documentValidator) },
  handler: async (ctx, args) => {
    let created = 0;
    let updated = 0;
    for (const document of args.documents) {
      // oxlint-disable-next-line no-await-in-loop -- Convex db ops are sequential within a mutation
      const existing = await ctx.db
        .query("aanvragen")
        .withIndex("by_document_id", (q) =>
          q.eq("documentId", document.documentId)
        )
        .unique();
      if (existing) {
        // oxlint-disable-next-line no-await-in-loop -- Convex db ops are sequential within a mutation
        await ctx.db.replace(existing._id, document);
        updated += 1;
      } else {
        // oxlint-disable-next-line no-await-in-loop -- Convex db ops are sequential within a mutation
        await ctx.db.insert("aanvragen", document);
        created += 1;
      }
    }
    return { created, updated };
  },
});

/**
 * Batched delete: a whole-table `.collect()` + delete dies on Convex's
 * per-function limits once the table is big (measured: 16MiB bytes-read
 * limit at ~2.5k of our documents). Callers loop until done.
 */
export const clearBatch = mutation({
  args: { limit: v.number() },
  handler: async (ctx, args) => {
    const rows = await ctx.db.query("aanvragen").take(args.limit);
    for (const row of rows) {
      // oxlint-disable-next-line no-await-in-loop -- Convex db ops are sequential within a mutation
      await ctx.db.delete(row._id);
    }
    return { deleted: rows.length, done: rows.length < args.limit };
  },
});

/**
 * Counting by `.collect()` loads every document's full bytes into the
 * function — measured to die on the 16MiB read limit at a few thousand of
 * our documents. There is no cheap server-side count in Convex without
 * maintaining a counter document or using the sharded-counter component;
 * this stays as the naive form deliberately so the cost is measurable.
 */
export const countAll = query({
  args: {},
  handler: async (ctx) => {
    const rows = await ctx.db.query("aanvragen").collect();
    return { count: rows.length };
  },
});
