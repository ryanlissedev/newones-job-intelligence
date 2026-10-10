import { timeCriticalPathPhase } from "@ji/performance";
import { and, eq, isNull } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";

import type * as schema from "./schema";
import { aanvraag, aanvraagVersie, outboxEvent } from "./schema/curated";

type Db = PostgresJsDatabase<typeof schema>;

type JsonPrimitive = boolean | null | number | string;
type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

export interface WriteAanvraagVersionInput {
  aanvraagId: string;
  contentHash: string;
  eventType: string;
  outboxPayload: Record<string, JsonValue>;
  rawPayloadRef: string;
  scrapeRunId: string;
  snapshot: Record<string, JsonValue>;
  versie: number;
}

export const writeAanvraagVersion = (
  db: Db,
  input: WriteAanvraagVersionInput
): Promise<{ outboxEventId: string; versieId: string }> => {
  const closedAt = new Date();

  return timeCriticalPathPhase("db-transaction", () =>
    db.transaction(async (tx) => {
      await tx
        .update(aanvraagVersie)
        .set({ geldigTot: closedAt })
        .where(
          and(
            eq(aanvraagVersie.aanvraagId, input.aanvraagId),
            isNull(aanvraagVersie.geldigTot)
          )
        );

      const [versieRow] = await tx
        .insert(aanvraagVersie)
        .values({
          aanvraagId: input.aanvraagId,
          contentHash: input.contentHash,
          geldigVan: closedAt,
          rawPayloadRef: input.rawPayloadRef,
          scrapeRunId: input.scrapeRunId,
          snapshot: input.snapshot,
          versie: input.versie,
        })
        .returning({ id: aanvraagVersie.id });

      if (!versieRow) {
        throw new Error("Failed to insert aanvraag_versie row");
      }

      const [outboxRow] = await tx
        .insert(outboxEvent)
        .values({
          aggregateId: input.aanvraagId,
          aggregateType: "aanvraag",
          eventType: input.eventType,
          payload: input.outboxPayload,
        })
        .returning({ id: outboxEvent.id });

      if (!outboxRow) {
        throw new Error("Failed to insert outbox_event row");
      }

      await tx
        .update(aanvraag)
        .set({
          contentHash: input.contentHash,
          rawPayloadRef: input.rawPayloadRef,
          scrapeRunId: input.scrapeRunId,
          versie: input.versie,
        })
        .where(eq(aanvraag.id, input.aanvraagId));

      return {
        outboxEventId: outboxRow.id,
        versieId: versieRow.id,
      };
    })
  );
};
