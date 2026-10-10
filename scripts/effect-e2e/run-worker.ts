import { writeFile } from "node:fs/promises";

import { runDrainOutboxEffect } from "../../apps/worker/src/effect/task-bodies";

const requiredFlags = [
  "JI_EFFECT_DB",
  "JI_EFFECT_SERVER",
  "JI_EFFECT_WORKER",
  "PERF_EFFECT_SPANS",
] as const;
const flags = Object.fromEntries(
  requiredFlags.map((name) => [name, process.env[name] ?? null])
);
if (requiredFlags.some((name) => flags[name] !== "1")) {
  throw new Error("Worker process did not receive every Effect E2E flag.");
}

const result = await runDrainOutboxEffect({ batchSize: 100 });
const expectedCanaryId = process.env.EFFECT_E2E_EXPECTED_CANARY_ID;
if (
  expectedCanaryId &&
  !(result.processedIds ?? []).includes(expectedCanaryId)
) {
  throw new Error("Worker did not process the seeded canary outbox event.");
}
const output = {
  durability: "not-proven-trigger" as const,
  effectWorkerFlag: process.env.JI_EFFECT_WORKER === "1",
  flags,
  result,
  status: "passed" as const,
};

const outputPath = process.env.EFFECT_E2E_WORKER_ARTIFACT;
if (outputPath) {
  await writeFile(outputPath, `${JSON.stringify(output, null, 2)}\n`);
}
process.stdout.write(`${JSON.stringify(output)}\n`);
