import { createHash } from "node:crypto";

// performance-record.schema.json's dataset-digest field requires
// <algorithm>:<digest> (scripts/performance/record.ts's DATASET_DIGEST_PATTERN),
// not a bare hex digest — record.ts's validator rejects (and readRecords /
// bun run perf:report throws on) anything else.
export const sha256Digest = (content: string): string =>
  `sha256:${createHash("sha256").update(content).digest("hex")}`;
