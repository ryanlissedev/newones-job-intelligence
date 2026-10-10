import { describe, expect, it } from "bun:test";

import { isDatasetDigest } from "../../scripts/performance/record";
import { sha256Digest } from "./digest";

describe("sha256Digest", () => {
  it("emits a schema-valid dataset digest (<algorithm>:<digest>)", () => {
    const digest = sha256Digest("hello");
    expect(digest).toMatch(/^sha256:[0-9a-f]{64}$/u);
    // The real performance-record schema validator (record.ts's
    // DATASET_DIGEST_PATTERN / PerformanceSchemaError) — not a
    // reimplementation of its regex — must accept this format.
    expect(isDatasetDigest(digest)).toBe(true);
  });
});
