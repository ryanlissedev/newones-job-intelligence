import { describe, expect, it } from "bun:test";

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import type { ListedSnapshotView } from "./contracts";
import { ExportsTable, ExportsView } from "./exports-list";
import { SNAPSHOT_FIXTURES } from "./fixtures";

const row = (
  overrides: Partial<ListedSnapshotView> = {}
): ListedSnapshotView => ({
  actorId: "recruiter-1",
  approval: null,
  createdAt: "2026-09-25T09:15:00.000Z",
  export: null,
  id: "00000000-0000-4000-8000-0000000000aa",
  query: "Azure AND data",
  resultCount: 3,
  status: "pending",
  ...overrides,
});

const render = (element: Parameters<typeof renderToStaticMarkup>[0]) =>
  renderToStaticMarkup(element);

describe("ExportsView render states (CTP-652)", () => {
  it("renders the empty state", () => {
    const markup = render(
      createElement(ExportsView, {
        error: null,
        items: [],
        loading: false,
        nextCursor: null,
        onLoadMore: () => {},
      })
    );
    expect(markup).toContain("Nog geen snapshots");
  });

  it("renders rows with status badges, approval expiry and export status", () => {
    const items = SNAPSHOT_FIXTURES.map((item): ListedSnapshotView => ({
      actorId: item.actorId,
      approval: item.approval,
      createdAt: item.createdAt,
      export: item.export,
      id: item.id,
      query: item.query,
      resultCount: item.resultCount,
      status: item.status,
    }));
    const markup = render(createElement(ExportsTable, { items }));
    expect(markup).toContain("In afwachting");
    expect(markup).toContain("Goedgekeurd");
    expect(markup).toContain("Geëxporteerd");
    expect(markup).toContain("created · 4 id&#x27;s");
    expect(markup).toContain('href="/snapshots/fixture-snapshot-pending"');
  });

  it("truncates long queries and renders a dash for a null query", () => {
    const longQuery = `Azure AND ${"long ".repeat(30)}`;
    const markup = render(
      createElement(ExportsTable, {
        items: [row({ query: longQuery }), row({ id: "other", query: null })],
      })
    );
    expect(markup).toContain("…");
    expect(markup).not.toContain(longQuery);
    expect(markup).toContain("—");
  });

  it("shows Meer laden only when a next cursor exists", () => {
    const withCursor = render(
      createElement(ExportsView, {
        error: null,
        items: [row()],
        loading: false,
        nextCursor: "cursor-2",
        onLoadMore: () => {},
      })
    );
    expect(withCursor).toContain("Meer laden");

    const withoutCursor = render(
      createElement(ExportsView, {
        error: null,
        items: [row()],
        loading: false,
        nextCursor: null,
        onLoadMore: () => {},
      })
    );
    expect(withoutCursor).not.toContain("Meer laden");
  });

  it("renders the API failure message verbatim", () => {
    const markup = render(
      createElement(ExportsView, {
        error: "Snapshots zijn niet beschikbaar",
        items: [],
        loading: false,
        nextCursor: null,
        onLoadMore: () => {},
      })
    );
    expect(markup).toContain("Snapshots zijn niet beschikbaar");
  });
});
