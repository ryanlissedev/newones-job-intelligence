import { describe, expect, it } from "bun:test";

import type { AlertRecord, AlertStore } from "../registry/stores/types";
import type { AlertNotification, AlertSink } from "./alert-sink";
import { createAlertEscalator } from "./escalation";

const HOUR_MS = 3_600_000;
const NOW = new Date("2026-09-25T12:00:00.000Z");

const alertRecord = (id: string, ageMs: number): AlertRecord => ({
  ackedAt: null,
  ackedBy: null,
  bronId: "00000000-0000-4000-8000-000000000010",
  createdAt: new Date(NOW.getTime() - ageMs),
  dedupeKey: `bron.stil:${id}`,
  evidence: {},
  id,
  kind: "bron.stil",
  message: `alert ${id}`,
});

const fakeAlertStore = (records: AlertRecord[]): AlertStore => ({
  ack: () => Promise.resolve(null),
  create: () => Promise.reject(new Error("not used")),
  findOpenByDedupeKey: () => Promise.resolve(null),
  getById: (id) =>
    Promise.resolve(records.find((record) => record.id === id) ?? null),
  listOpen: () =>
    Promise.resolve(records.filter((record) => record.ackedAt === null)),
});

const recordingSink = (delivered: AlertNotification[]): AlertSink => ({
  deliver: (notification) => {
    delivered.push(notification);
    return Promise.resolve();
  },
});

describe("createAlertEscalator (CTP-653)", () => {
  it("delivers only alerts older than afterMs, once", async () => {
    const delivered: AlertNotification[] = [];
    const escalator = createAlertEscalator({
      afterMs: 4 * HOUR_MS,
      alerts: fakeAlertStore([
        alertRecord("old", 5 * HOUR_MS),
        alertRecord("fresh", HOUR_MS),
      ]),
      now: () => NOW,
      sink: recordingSink(delivered),
    });

    const first = await escalator.run();
    expect(first.escalated).toEqual(["old"]);
    expect(delivered).toHaveLength(1);
    expect(delivered[0]?.stage).toBe("escalated");
    expect(delivered[0]?.alertId).toBe("old");

    const second = await escalator.run();
    expect(second.escalated).toEqual([]);
    expect(delivered).toHaveLength(1);
  });

  it("retries an alert whose delivery failed on the previous run", async () => {
    const delivered: AlertNotification[] = [];
    let failNext = true;
    const escalator = createAlertEscalator({
      afterMs: 4 * HOUR_MS,
      alerts: fakeAlertStore([alertRecord("old", 5 * HOUR_MS)]),
      now: () => NOW,
      sink: {
        deliver: (notification) => {
          if (failNext) {
            failNext = false;
            return Promise.reject(new Error("webhook down"));
          }
          delivered.push(notification);
          return Promise.resolve();
        },
      },
    });

    await expect(escalator.run()).rejects.toThrow("webhook down");
    const retry = await escalator.run();
    expect(retry.escalated).toEqual(["old"]);
    expect(delivered).toHaveLength(1);
  });
});
