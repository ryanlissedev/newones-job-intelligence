import type { AlertStore } from "../registry/stores/types";
import { toAlertNotification } from "./alert-sink";
import type { AlertSink } from "./alert-sink";

/**
 * CTP-653: re-notifies open alerts that have been unacked longer than
 * `afterMs`. The already-escalated id set is process-local, so a poller
 * restart may re-escalate an open alert once; that is accepted for this
 * slice because the alert table has no mutable column besides `acked_at`
 * (ADR-0010) and a migration is out of scope here.
 */
export const createAlertEscalator = (input: {
  alerts: AlertStore;
  sink: AlertSink;
  afterMs: number;
  now?: () => Date;
}) => {
  const now = input.now ?? (() => new Date());
  const escalated = new Set<string>();
  return {
    run: async () => {
      const open = await input.alerts.listOpen();
      const delivered: string[] = [];
      for (const alert of open) {
        if (escalated.has(alert.id)) {
          continue;
        }
        if (now().getTime() - alert.createdAt.getTime() < input.afterMs) {
          continue;
        }
        // A failed delivery leaves the id out of the set, so the next run
        // retries instead of silently dropping the escalation.
        // oxlint-disable-next-line eslint/no-await-in-loop -- sequential on purpose: one webhook POST at a time, and a failure must stop the run rather than mark the rest escalated.
        await input.sink.deliver(toAlertNotification(alert, "escalated"));
        escalated.add(alert.id);
        delivered.push(alert.id);
      }
      return { escalated: delivered };
    },
  };
};
