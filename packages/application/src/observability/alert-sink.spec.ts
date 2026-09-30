import { describe, expect, it } from "bun:test";

import type { AlertRecord } from "../registry/stores/types";
import {
  AlertDeliveryError,
  createStderrAlertSink,
  createWebhookAlertSink,
  deliverOpenedAlert,
} from "./alert-sink";
import type { AlertFetch, AlertNotification, AlertSink } from "./alert-sink";

const notification: AlertNotification = {
  alertId: "alert-1",
  bronId: "00000000-0000-4000-8000-000000000010",
  createdAt: new Date("2026-09-25T12:00:00.000Z"),
  dedupeKey: "bron.stil:00000000-0000-4000-8000-000000000010",
  evidence: { current_new: 0 },
  kind: "bron.stil",
  message: "Bron TenderNed heeft een succesvolle run zonder nieuwe records.",
  runbook: "docs/runbooks/source-silence.md",
  stage: "opened",
};

const failingFetch: AlertFetch = () =>
  Promise.resolve(new Response("nope", { status: 500 }));

const throwingFetch: AlertFetch = () => {
  throw new Error("socket hangup");
};

const okFetch = (
  capture: (url: string, init: RequestInit) => void
): AlertFetch => {
  const impl: AlertFetch = (url, init) => {
    capture(url, init);
    return Promise.resolve(new Response("ok", { status: 200 }));
  };
  return impl;
};

describe("createWebhookAlertSink", () => {
  it("POSTs {text, alert} as JSON to the configured URL", async () => {
    const requests: { url: string; init: RequestInit }[] = [];
    const sink = createWebhookAlertSink({
      fetchImpl: okFetch((url, init) => {
        requests.push({ init, url });
      }),
      url: "https://hooks.example.test/services/aaa",
    });

    await sink.deliver(notification);

    const [request] = requests;
    if (request === undefined) {
      throw new Error("webhook fetch was not called");
    }
    const { url, init } = request;
    expect(url).toBe("https://hooks.example.test/services/aaa");
    expect(init.method).toBe("POST");
    expect(new Headers(init.headers).get("content-type")).toBe(
      "application/json"
    );
    // SAFETY: the sink's own JSON.stringify shape is under test here.
    const body = JSON.parse(String(init.body)) as {
      alert: { alertId: string; createdAt: string; stage: string };
      text: string;
    };
    expect(body.text).toBe(
      "[JI] ALERT bron.stil bron 00000000-0000-4000-8000-000000000010: Bron TenderNed heeft een succesvolle run zonder nieuwe records. (runbook docs/runbooks/source-silence.md)"
    );
    expect(body.alert.alertId).toBe("alert-1");
    expect(body.alert.createdAt).toBe("2026-09-25T12:00:00.000Z");
    expect(body.alert.stage).toBe("opened");
  });

  it("uses ESCALATIE in the text for escalated notifications", async () => {
    let text = "";
    const sink = createWebhookAlertSink({
      fetchImpl: okFetch((_url, init) => {
        // SAFETY: the sink's own JSON.stringify shape is under test here.
        const parsed = JSON.parse(String(init.body)) as { text: string };
        ({ text } = parsed);
      }),
      url: "https://hooks.example.test/services/aaa",
    });
    await sink.deliver({ ...notification, stage: "escalated" });
    expect(text).toContain("[JI] ESCALATIE");
  });

  it("rejects with AlertDeliveryError carrying the status on HTTP 500", async () => {
    const sink = createWebhookAlertSink({
      fetchImpl: failingFetch,
      url: "https://hooks.example.test/services/aaa",
    });
    let thrown: unknown;
    try {
      await sink.deliver(notification);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(AlertDeliveryError);
    if (thrown instanceof AlertDeliveryError) {
      expect(thrown.status).toBe(500);
    }
  });

  it("rejects with AlertDeliveryError when fetch itself throws", async () => {
    const sink = createWebhookAlertSink({
      fetchImpl: throwingFetch,
      url: "https://hooks.example.test/services/aaa",
    });
    let thrown: unknown;
    try {
      await sink.deliver(notification);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(AlertDeliveryError);
    if (thrown instanceof AlertDeliveryError) {
      expect(thrown.status).toBeUndefined();
    }
  });
});

const committedAlert: AlertRecord = {
  ackedAt: null,
  ackedBy: null,
  bronId: notification.bronId,
  createdAt: notification.createdAt,
  dedupeKey: notification.dedupeKey,
  evidence: notification.evidence,
  id: notification.alertId,
  kind: notification.kind,
  message: notification.message,
};

describe("deliverOpenedAlert", () => {
  it("delivers exactly one 'opened' notification built from the committed row", async () => {
    const delivered: AlertNotification[] = [];
    const sink: AlertSink = {
      deliver: (alert) => {
        delivered.push(alert);
        return Promise.resolve();
      },
    };
    await deliverOpenedAlert(sink, committedAlert);
    expect(delivered).toHaveLength(1);
    expect(delivered[0]?.stage).toBe("opened");
    expect(delivered[0]?.alertId).toBe("alert-1");
    expect(delivered[0]?.runbook).toBe("docs/runbooks/source-silence.md");
  });

  it("a throwing sink calls onFailure once and never rethrows", async () => {
    const failures: { error: unknown; notification: AlertNotification }[] = [];
    const sink: AlertSink = {
      deliver: () => Promise.reject(new Error("webhook down")),
    };
    await deliverOpenedAlert(sink, committedAlert, (error, failure) => {
      failures.push({ error, notification: failure });
    });
    expect(failures).toHaveLength(1);
    expect(failures[0]?.error).toBeInstanceOf(Error);
    expect(failures[0]?.notification.alertId).toBe("alert-1");
  });
});

describe("createStderrAlertSink", () => {
  it("writes one alert_unrouted JSON line and never throws", async () => {
    const chunks: string[] = [];
    const sink = createStderrAlertSink({
      write: (chunk: string) => {
        chunks.push(chunk);
        return true;
      },
    });
    await sink.deliver(notification);
    expect(chunks).toHaveLength(1);
    // SAFETY: the sink writes a single JSON object line; the asserted keys
    // are the contract under test.
    const line = JSON.parse(chunks[0] ?? "") as {
      alertId: string;
      event: string;
    };
    expect(line.event).toBe("alert_unrouted");
    expect(line.alertId).toBe("alert-1");
  });
});
