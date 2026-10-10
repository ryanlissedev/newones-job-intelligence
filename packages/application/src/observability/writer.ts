import type { AlertStore, BronHealthStore } from "../registry/stores/types";
import type { SilenceAlertWriter } from "./silence";

export const createSilenceAlertWriter = (stores: {
  alerts: AlertStore;
  bronHealth: BronHealthStore;
  upsertBronHealth?: SilenceAlertWriter["upsertBronHealth"];
}): SilenceAlertWriter => ({
  findOpenByDedupeKey: async (dedupeKey) => {
    const alert = await stores.alerts.findOpenByDedupeKey(dedupeKey);
    return alert ? { id: alert.id } : null;
  },
  upsertBronHealth: async (input) => {
    if (stores.upsertBronHealth) {
      await stores.upsertBronHealth(input);
      return;
    }
    const existing = await stores.bronHealth.getByBronId(input.bronId);
    await stores.bronHealth.upsert({
      bronId: input.bronId,
      circuitStatus: existing?.circuitStatus ?? "closed",
      lastRunAt: input.lastRunAt,
      lastRunStatus: input.lastRunStatus,
      silenceAlertOpen: input.silenceAlertOpen,
    });
  },
  writeAlert: async (input) => {
    const alert = await stores.alerts.create({
      bronId: input.bronId,
      dedupeKey: input.dedupeKey,
      evidence: input.evidence,
      kind: input.kind,
      message: input.message,
    });
    return { created: true, id: alert.id };
  },
});
