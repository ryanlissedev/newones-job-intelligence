import { describe, expect, test } from "bun:test";

import { Effect, Exit } from "effect";

import {
  createCriticalPathSession,
  withCriticalPathSession,
} from "../critical-path";
import { CRITICAL_PATH_LABELS } from "../labels";
import {
  annotateCriticalPathSpan,
  criticalPathSpanName,
  isEffectPerformanceSpansEnabled,
  sanitizeCriticalPathSpanAttributes,
  sanitizeLooseCriticalPathSpanAttributes,
  withCriticalPathSpan,
} from "./index";

describe("@ji/performance/effect spans", () => {
  test("span names are exactly the ADR critical-path labels", () => {
    for (const label of CRITICAL_PATH_LABELS) {
      expect(criticalPathSpanName(label)).toBe(label);
    }
  });

  test("sanitizeLooseCriticalPathSpanAttributes drops PII and unknown keys", () => {
    const sanitized = sanitizeLooseCriticalPathSpanAttributes({
      email: "person@example.com",
      "item-count": 12,
      label: "search-parser",
      query: "azure AND engineer",
      "queryset-digest":
        "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      "raw-sql": "SELECT * FROM users WHERE email = 'x'",
      unknown: "nope",
      "vacancy-id": "vac-123",
    });
    expect(sanitized).toEqual({
      "item-count": 12,
      label: "search-parser",
      "queryset-digest":
        "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    });
    expect(JSON.stringify(sanitized)).not.toMatch(
      /email|vacancy|SELECT|azure|person@/iu
    );
  });

  test("sanitizeCriticalPathSpanAttributes rejects PII-like values on allowlisted keys", () => {
    const sanitized = sanitizeCriticalPathSpanAttributes({
      label: "search-parser",
      toolchain: "person@example.com",
    });
    expect(sanitized).toEqual({
      label: "search-parser",
    });
  });

  test("flag defaults OFF (prod Effect OFF)", () => {
    const previous = process.env.PERF_EFFECT_SPANS;
    delete process.env.PERF_EFFECT_SPANS;
    try {
      expect(isEffectPerformanceSpansEnabled()).toBe(false);
    } finally {
      if (previous === undefined) {
        delete process.env.PERF_EFFECT_SPANS;
      } else {
        process.env.PERF_EFFECT_SPANS = previous;
      }
    }
  });

  test("withCriticalPathSpan is a no-op when flag is OFF", async () => {
    const previous = process.env.PERF_EFFECT_SPANS;
    delete process.env.PERF_EFFECT_SPANS;
    try {
      const program = withCriticalPathSpan(
        Effect.succeed("ok"),
        "search-parser"
      );
      const result = await Effect.runPromise(program);
      expect(result).toBe("ok");
    } finally {
      if (previous === undefined) {
        delete process.env.PERF_EFFECT_SPANS;
      } else {
        process.env.PERF_EFFECT_SPANS = previous;
      }
    }
  });

  test("withCriticalPathSpan bridges to native session when enabled", async () => {
    const previousSpans = process.env.PERF_EFFECT_SPANS;
    const previousPath = process.env.PERF_CRITICAL_PATH;
    process.env.PERF_EFFECT_SPANS = "1";
    process.env.PERF_CRITICAL_PATH = "1";
    try {
      const session = createCriticalPathSession();
      const program = withCriticalPathSpan(Effect.succeed(42), "db-query", {
        attributes: {
          "item-count": 3,
          "query-identity": "pg-queryid:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        },
      });
      const value = await withCriticalPathSession(session, () =>
        Effect.runPromise(program)
      );
      expect(value).toBe(42);
      const records = await session.flush();
      expect(records.length).toBe(1);
      expect(records[0]?.label).toBe("db-query");
      expect(records[0]?.measurement.boundary).toBe("db-query");
      expect(JSON.stringify(records)).not.toMatch(
        /leak@|email|password|vacancy/iu
      );
    } finally {
      if (previousSpans === undefined) {
        delete process.env.PERF_EFFECT_SPANS;
      } else {
        process.env.PERF_EFFECT_SPANS = previousSpans;
      }
      if (previousPath === undefined) {
        delete process.env.PERF_CRITICAL_PATH;
      } else {
        process.env.PERF_CRITICAL_PATH = previousPath;
      }
    }
  });

  test("annotateCriticalPathSpan keeps digest attributes when enabled", async () => {
    const previous = process.env.PERF_EFFECT_SPANS;
    process.env.PERF_EFFECT_SPANS = "1";
    try {
      const program = annotateCriticalPathSpan(Effect.succeed("x"), {
        "queryset-digest":
          "sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
      });
      const exit = await Effect.runPromiseExit(program);
      expect(Exit.isSuccess(exit)).toBe(true);
    } finally {
      if (previous === undefined) {
        delete process.env.PERF_EFFECT_SPANS;
      } else {
        process.env.PERF_EFFECT_SPANS = previous;
      }
    }
  });
});
