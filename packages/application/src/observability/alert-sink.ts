import type { AlertEvidence, AlertRecord } from "../registry/stores/types";
import { SOURCE_SILENCE_RUNBOOK_PATH } from "./silence";

/**
 * CTP-653: delivery of a persisted alert to the operator channel. `stage`
 * distinguishes the first routing of a freshly created alert ("opened") from
 * the escalator's re-notification ("escalated"); `runbook` is the repo path
 * the operator follows, e.g. `SOURCE_SILENCE_RUNBOOK_PATH`.
 */
export interface AlertNotification {
  readonly alertId: string;
  readonly bronId: string;
  readonly kind: string;
  readonly message: string;
  readonly dedupeKey: string;
  readonly createdAt: Date;
  readonly runbook: string;
  readonly stage: "opened" | "escalated";
  readonly evidence: AlertEvidence;
}

export interface AlertSink {
  deliver: (notification: AlertNotification) => Promise<void>;
}

/** One builder for both stages so "opened" and "escalated" notifications
 * cannot drift apart. */
export const toAlertNotification = (
  alert: AlertRecord,
  stage: AlertNotification["stage"]
): AlertNotification => ({
  alertId: alert.id,
  bronId: alert.bronId,
  createdAt: alert.createdAt,
  dedupeKey: alert.dedupeKey,
  evidence: alert.evidence,
  kind: alert.kind,
  message: alert.message,
  runbook: SOURCE_SILENCE_RUNBOOK_PATH,
  stage,
});

export const defaultOnDeliveryFailure = (
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- the failure callback contract is `unknown` by design: sinks may throw anything.
  error: unknown,
  notification: AlertNotification
): void => {
  process.stderr.write(
    `${JSON.stringify({
      alertId: notification.alertId,
      dedupeKey: notification.dedupeKey,
      error: error instanceof Error ? error.message : String(error),
      event: "alert_delivery_failed",
    })}\n`
  );
};

/** Post-commit delivery of a freshly persisted alert. The caller hands over
 * the committed `AlertRecord` (loaded outside the transaction), so the
 * operator is never paged about a row that rolled back. Delivery errors are
 * swallowed into `onFailure` — alert routing must never fail a poll. */
export const deliverOpenedAlert = async (
  sink: AlertSink,
  alert: AlertRecord,
  onFailure: (
    // oxlint-disable-next-line anti-slop/no-unknown-parameters -- callers receive the raw thrown value; narrowing happens inside their handler.
    error: unknown,
    notification: AlertNotification
  ) => void = defaultOnDeliveryFailure
): Promise<void> => {
  const notification = toAlertNotification(alert, "opened");
  try {
    await sink.deliver(notification);
  } catch (error) {
    onFailure(error, notification);
  }
};

export class AlertDeliveryError extends Error {
  readonly status?: number;

  constructor(message: string, options?: { status?: number }) {
    super(message);
    this.name = "AlertDeliveryError";
    this.status = options?.status;
  }
}

const notificationText = (notification: AlertNotification): string =>
  `[JI] ${notification.stage === "escalated" ? "ESCALATIE" : "ALERT"} ${
    notification.kind
  } bron ${notification.bronId}: ${notification.message} (runbook ${
    notification.runbook
  })`;

/** Bun's `fetch` carries a `preconnect` static; tests and callers only need
 * the request/response surface. */
export type AlertFetch = (url: string, init: RequestInit) => Promise<Response>;

/** Posts each notification as `{text, alert}` — Slack incoming webhooks read
 * `text`, anything else can consume the structured `alert` payload. */
export const createWebhookAlertSink = (input: {
  url: string;
  fetchImpl?: AlertFetch;
  timeoutMs?: number;
}): AlertSink => {
  const fetchImpl = input.fetchImpl ?? fetch;
  const timeoutMs = input.timeoutMs ?? 5000;
  return {
    deliver: async (notification) => {
      const body = JSON.stringify({
        alert: {
          ...notification,
          createdAt: notification.createdAt.toISOString(),
        },
        text: notificationText(notification),
      });
      let response: Response;
      try {
        response = await fetchImpl(input.url, {
          body,
          headers: { "content-type": "application/json" },
          method: "POST",
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (error) {
        throw new AlertDeliveryError(
          `alert webhook delivery failed: ${
            error instanceof Error ? error.message : String(error)
          }`
        );
      }
      if (!response.ok) {
        throw new AlertDeliveryError(
          `alert webhook responded HTTP ${response.status}`,
          { status: response.status }
        );
      }
    },
  };
};

/** Fallback when no webhook is configured: one JSON line on stderr, matching
 * the poller's `silence_alert_auto_resolved` log shape. Never throws — alert
 * routing must never fail a poll. */
export const createStderrAlertSink = (
  stream: { write: (chunk: string) => boolean } = process.stderr
): AlertSink => ({
  deliver: (notification) => {
    stream.write(
      `${JSON.stringify({
        alertId: notification.alertId,
        bronId: notification.bronId,
        dedupeKey: notification.dedupeKey,
        event: "alert_unrouted",
        kind: notification.kind,
        message: notification.message,
        runbook: notification.runbook,
        stage: notification.stage,
      })}\n`
    );
    return Promise.resolve();
  },
});
