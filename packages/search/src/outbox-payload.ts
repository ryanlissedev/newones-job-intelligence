import type { AanvraagLifecycle } from "@ji/domain";

export interface OutboxEventPayload {
  bron_id?: string;
  bron_referentie?: string;
  content_hash?: string;
  parser_version?: string;
  status?: AanvraagLifecycle;
}

const lifecycleValues = new Set<AanvraagLifecycle>([
  "active",
  "closed",
  "stale",
  "unknown",
]);

export const readOutboxStatus = (
  payload: OutboxEventPayload
): AanvraagLifecycle | null => {
  const { status } = payload;
  if (status === undefined) {
    return null;
  }

  return lifecycleValues.has(status) ? status : null;
};
