import { describe, expect, it } from "bun:test";

import type { BronId } from "@ji/domain";
import {
  ABANDON_RUN_AFTER_MS_DEFAULT,
  resolvePollRunStaleAfterMs,
} from "@ji/env/poller";

import {
  buildPollPayload,
  formatOneshotList,
  isSoftOrHashFailure,
  parseOneshotArgs,
  selectOneshotTargets,
  sliceARegistryCount,
  summarizeOneshotRun,
} from "./oneshot-slice-a-polls";
import type { SliceABronDefinition } from "./slice-a-bronnen";

const bron = (
  slug: SliceABronDefinition["bronSlug"],
  id: string
): SliceABronDefinition => ({
  // SAFETY: test fixture UUIDs only.
  bronId: id as BronId,
  bronSlug: slug,
  naam: slug,
});

const pollableFixture: SliceABronDefinition[] = [
  bron("tenderned", "11111111-1111-1111-1111-111111111111"),
  bron("inhuurdesk", "22222222-2222-2222-2222-222222222222"),
];

describe("poll-run stale threshold", () => {
  it("shares the poller default without validating unrelated poller env", () => {
    expect(resolvePollRunStaleAfterMs()).toBe(ABANDON_RUN_AFTER_MS_DEFAULT);
    expect(resolvePollRunStaleAfterMs("")).toBe(ABANDON_RUN_AFTER_MS_DEFAULT);
    expect(resolvePollRunStaleAfterMs("90000")).toBe(90_000);
    expect(() => resolvePollRunStaleAfterMs("0")).toThrow(
      "must be a positive whole number"
    );
  });
});

describe("parseOneshotArgs", () => {
  it("defaults to list / dry-run with no fan-out filter", () => {
    expect(parseOneshotArgs([])).toEqual({
      bronSlug: null,
      limit: null,
      mode: "list",
    });
    expect(parseOneshotArgs(["--dry-run"])).toEqual({
      bronSlug: null,
      limit: null,
      mode: "list",
    });
    expect(parseOneshotArgs(["--list"])).toEqual({
      bronSlug: null,
      limit: null,
      mode: "list",
    });
  });

  it("requires --run for execute mode and accepts --bron / --limit", () => {
    expect(
      parseOneshotArgs(["--run", "--bron", "tenderned", "--limit", "1"])
    ).toEqual({
      bronSlug: "tenderned",
      limit: 1,
      mode: "run",
    });
    expect(parseOneshotArgs(["--run", "--bron", "all"])).toEqual({
      bronSlug: null,
      limit: null,
      mode: "run",
    });
  });

  it("rejects unknown flags and invalid limits", () => {
    expect(() => parseOneshotArgs(["--explode"])).toThrow(/Usage:/u);
    expect(() => parseOneshotArgs(["--limit", "0"])).toThrow(
      /positive integer/u
    );
    expect(() => parseOneshotArgs(["--bron", "not-a-bron"])).toThrow(/Usage:/u);
  });
});

describe("selectOneshotTargets", () => {
  it("fans out to all pollable by default and filters by slug / limit", () => {
    expect(
      selectOneshotTargets(pollableFixture, {
        bronSlug: null,
        limit: null,
        mode: "list",
      })
    ).toHaveLength(2);
    expect(
      selectOneshotTargets(pollableFixture, {
        bronSlug: "tenderned",
        limit: null,
        mode: "run",
      }).map((row) => row.bronSlug)
    ).toEqual(["tenderned"]);
    expect(
      selectOneshotTargets(pollableFixture, {
        bronSlug: null,
        limit: 1,
        mode: "run",
      })
    ).toHaveLength(1);
  });

  it("returns empty when an explicit slug is not pollable (no seed)", () => {
    const [onlyTenderned] = pollableFixture;
    expect(onlyTenderned).toBeDefined();
    expect(
      selectOneshotTargets(onlyTenderned ? [onlyTenderned] : [], {
        bronSlug: "inhuurdesk",
        limit: null,
        mode: "run",
      })
    ).toEqual([]);
  });
});

describe("formatOneshotList / buildPollPayload", () => {
  it("shapes list output and builds a poll-bron payload", () => {
    const [first] = pollableFixture;
    expect(first).toBeDefined();
    if (!first) {
      expect.unreachable();
    }
    const listed = formatOneshotList(pollableFixture, [first]);
    expect(listed).toEqual({
      mode: "list",
      pollable: 2,
      targets: [
        {
          bronId: "11111111-1111-1111-1111-111111111111",
          bronSlug: "tenderned",
          naam: "tenderned",
        },
      ],
    });
    const payload = buildPollPayload(
      first,
      "33333333-3333-3333-3333-333333333333"
    );
    expect(payload).toEqual({
      bronId: "11111111-1111-1111-1111-111111111111",
      bronSlug: "tenderned",
      scrapeRunId: "33333333-3333-3333-3333-333333333333",
    });
  });
});

describe("isSoftOrHashFailure / summarizeOneshotRun (CTP-489)", () => {
  it("classifies soft/hash vs hard failures", () => {
    expect(isSoftOrHashFailure("content hash drift")).toBe(true);
    expect(isSoftOrHashFailure("429 rate limit")).toBe(true);
    expect(isSoftOrHashFailure("fetch failed")).toBe(true);
    expect(isSoftOrHashFailure("PROVENANCE_MISMATCH identity")).toBe(false);
  });

  it("aggregates JSON summary totals and hardFail", () => {
    const summary = summarizeOneshotRun({
      finishedAt: "2026-09-08T14:00:00.000Z",
      hardFail: true,
      results: [
        {
          bronSlug: "tenderned",
          metrics: {
            changed: 1,
            error: 0,
            found: 3,
            new: 2,
            rejected: 0,
            unchanged: 0,
          },
          nieuw: 2,
          scrapeRunId: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
          status: "succeeded",
          writtenRecords: 2,
        },
        {
          bronSlug: "inhuurdesk",
          error: "boom",
          soft: false,
          status: "failed",
        },
        {
          bronSlug: "bluetrail",
          skippedReason: "already_running",
          status: "skipped",
        },
      ],
      startedAt: "2026-09-08T13:00:00.000Z",
      targets: 3,
    });
    expect(summary.succeeded).toBe(1);
    expect(summary.failed).toBe(1);
    expect(summary.skipped).toBe(1);
    expect(summary.softFailed).toBe(0);
    expect(summary.hardFail).toBe(true);
    expect(summary.totals).toEqual({
      changed: 1,
      error: 0,
      found: 3,
      nieuw: 2,
      rejected: 0,
      unchanged: 0,
      writtenRecords: 2,
    });
  });
});

describe("slice-a-pollable / schedule contract (CTP-488/489)", () => {
  it("keeps the on-box poller on the shared listPollable helper", async () => {
    const source = await Bun.file(
      new URL("poller/schedule.ts", import.meta.url)
    ).text();
    expect(source).toContain("listPollableSliceABronnen");
    expect(source).toContain('POLL_TIME_ZONE = "Europe/Amsterdam"');
    expect(source.includes('from "@trigger.dev/sdk"')).toBe(false);
    expect(sliceARegistryCount()).toBeGreaterThan(0);
  });

  it("documents oneshot CLI as offline runPollBron wrapper", async () => {
    const source = await Bun.file(
      new URL("../scripts/oneshot-slice-a-polls.ts", import.meta.url)
    ).text();
    expect(source).toContain("runBronIngestPipeline");
    expect(source).toContain("runPollBronOnce");
    expect(source).toContain("isSoftOrHashFailure");
    expect(source).toContain("summarizeOneshotRun");
    expect(source.includes('from "@trigger.dev/sdk"')).toBe(false);
  });

  it("ships flock Coolify/cron wrapper for scheduled oneshot ticks", async () => {
    const wrapper = await Bun.file(
      new URL("../scripts/scheduled-oneshot-slice-a-polls.sh", import.meta.url)
    ).text();
    expect(wrapper).toContain("flock -n");
    expect(wrapper).toContain("oneshot-slice-a-polls.ts");
    expect(wrapper).toContain("--run --bron all");
    expect(wrapper).toContain("lock_held");
    expect(wrapper).toContain("CTP-489");
  });
});
