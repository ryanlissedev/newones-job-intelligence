import { describe, expect, it } from "bun:test";

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import type { SnapshotDetailView } from "./contracts";
import type { SnapshotDetailViewProps } from "./snapshot-detail";

process.env.NEXT_PUBLIC_SERVER_URL ??= "http://server.test";

const { SnapshotDetailView: View } = await import("./snapshot-detail");

const SNAPSHOT: SnapshotDetailView = {
  approval: null,
  createdAt: "2026-09-25T08:00:00.000Z",
  freshness: { searchAppliedSequence: "42", searchGeneration: 3 },
  id: "00000000-0000-4000-8000-0000000000aa",
  provenance: { parserVersion: "v2", schemaVersion: "slice-a-v1" },
  queryDigest: "a".repeat(64),
  resultIds: ["job-1", "job-2"],
  savedSearchId: null,
  scope: "active",
  selectionDigest: "b".repeat(64),
};

const baseProps = (
  overrides: Partial<SnapshotDetailViewProps>
): SnapshotDetailViewProps => ({
  approval: { kind: "none" },
  approvalNotice: null,
  defaultExpiry: "2026-10-02T09:00",
  exportLoad: {
    kind: "ready",
    status: {
      attempts: [],
      liveConfirmationAvailable: false,
      snapshotId: SNAPSHOT.id,
      status: "no_attempt",
    },
  },
  exportNotice: null,
  isApproving: false,
  isExporting: false,
  onApprove: () => {},
  onExport: () => {},
  snapshot: SNAPSHOT,
  ...overrides,
});

describe("snapshot detail render (CTP-652)", () => {
  it("renders the header facts for a snapshot without approval", () => {
    const markup = renderToStaticMarkup(createElement(View, baseProps({})));
    expect(markup).toContain(SNAPSHOT.queryDigest);
    expect(markup).toContain(SNAPSHOT.selectionDigest);
    expect(markup).toContain("Geselecteerde opdrachten");
    expect(markup).toContain(">2<");
    expect(markup).toContain("Nog geen goedkeuring");
    // Export stays gated until a valid approval exists.
    expect(markup).toContain("Export vereist een geldige goedkeuring");
    expect(markup).toContain("Nog geen exportpogingen");
    // The approve form is offered (motivatie + expiry).
    expect(markup).toContain('name="motivatie"');
    expect(markup).toContain('name="expiresAt"');
  });

  it("renders a valid approval with motivatie and enables export", () => {
    const markup = renderToStaticMarkup(
      createElement(
        View,
        baseProps({
          approval: {
            approval: {
              actorId: "approver-1",
              createdAt: "2026-09-25T09:00:00.000Z",
              expiresAt: "2026-10-02T09:00:00.000Z",
              id: "approval-1",
              motivatie: "Klant akkoord op de selectie",
              resultIds: ["job-1", "job-2"],
              snapshotId: SNAPSHOT.id,
              valid: true,
            },
            kind: "ready",
          },
        })
      )
    );
    expect(markup).toContain("Klant akkoord op de selectie");
    expect(markup).toContain("geldig");
    expect(markup).toContain("Commit de goedgekeurde selectie naar Spott");
    expect(markup).not.toContain('name="motivatie"');
  });

  it("renders export attempts with status, external id and receipt", () => {
    const markup = renderToStaticMarkup(
      createElement(
        View,
        baseProps({
          approval: {
            approval: {
              actorId: "approver-1",
              createdAt: "2026-09-25T09:00:00.000Z",
              expiresAt: "2026-10-02T09:00:00.000Z",
              id: "approval-1",
              motivatie: "ok",
              resultIds: ["job-1", "job-2"],
              snapshotId: SNAPSHOT.id,
              valid: true,
            },
            kind: "ready",
          },
          exportLoad: {
            kind: "ready",
            status: {
              attempts: [
                {
                  canonicalVacancyId: "job-1",
                  createdAt: "2026-09-25T09:05:00.000Z",
                  errorMessage: null,
                  externalId: "spott-42",
                  id: "attempt-1",
                  idempotencyKey: "key-1",
                  receipt: {
                    id: "receipt-1",
                    responseHash: "c".repeat(64),
                  },
                  status: "attempted",
                },
              ],
              liveConfirmationAvailable: false,
              snapshotId: SNAPSHOT.id,
              status: "attempted",
            },
          },
        })
      )
    );
    expect(markup).toContain("spott-42");
    expect(markup).toContain("receipt-1");
    expect(markup).toContain("attempted");
  });

  it("renders the permission copy when approval reads are denied", () => {
    const markup = renderToStaticMarkup(
      createElement(
        View,
        baseProps({
          approval: { kind: "denied" },
          exportLoad: { kind: "denied" },
        })
      )
    );
    expect(markup).toContain("Geen goedkeuringsrecht");
    expect(markup).toContain("Geen exportrecht");
  });
});
