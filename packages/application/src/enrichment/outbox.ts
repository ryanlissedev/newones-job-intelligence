import type { EnrichmentField } from "./types";

export const ENRICHMENT_OUTBOX_EVENT_TYPE = "aanvraag.enriched" as const;

export interface EnrichmentOutboxPayload {
  readonly field_count: number;
  readonly fields: readonly EnrichmentField[];
}

export interface EnrichmentOutboxInsertInput {
  readonly aggregateId: string;
  readonly aggregateType: "aanvraag";
  readonly eventType: typeof ENRICHMENT_OUTBOX_EVENT_TYPE;
  readonly payload: EnrichmentOutboxPayload;
}

export interface EnrichmentOutboxPort {
  readonly insertOutboxEvent: (
    input: EnrichmentOutboxInsertInput
  ) => Promise<{ readonly id: string }>;
}

export interface EnrichmentOutboxInput {
  readonly aanvraagId: string;
  readonly dryRun: boolean;
  readonly fields: readonly EnrichmentField[];
}

export interface EnrichmentOutboxResult {
  readonly enqueued: boolean;
  readonly eventId: string | null;
  readonly eventType: typeof ENRICHMENT_OUTBOX_EVENT_TYPE;
}

export interface EnrichmentOutboxStubResult {
  readonly enqueued: boolean;
  readonly eventType: typeof ENRICHMENT_OUTBOX_EVENT_TYPE;
}

/** Persist a thin aanvraag.enriched outbox row when dry-run is off and fields landed. */
export const enqueueEnrichmentOutbox = async (
  port: EnrichmentOutboxPort,
  input: EnrichmentOutboxInput
): Promise<EnrichmentOutboxResult> => {
  if (input.dryRun || input.fields.length === 0) {
    return {
      enqueued: false,
      eventId: null,
      eventType: ENRICHMENT_OUTBOX_EVENT_TYPE,
    };
  }

  const inserted = await port.insertOutboxEvent({
    aggregateId: input.aanvraagId,
    aggregateType: "aanvraag",
    eventType: ENRICHMENT_OUTBOX_EVENT_TYPE,
    payload: {
      field_count: input.fields.length,
      fields: [...input.fields],
    },
  });

  return {
    enqueued: true,
    eventId: inserted.id,
    eventType: ENRICHMENT_OUTBOX_EVENT_TYPE,
  };
};

/** Slice 1 sync stub — prefer enqueueEnrichmentOutbox with a port. */
export const enqueueEnrichmentOutboxStub = (input: {
  readonly aanvraagId: string;
  readonly dryRun: boolean;
  readonly fieldCount: number;
}): EnrichmentOutboxStubResult => ({
  enqueued: !input.dryRun && input.fieldCount > 0,
  eventType: ENRICHMENT_OUTBOX_EVENT_TYPE,
});
