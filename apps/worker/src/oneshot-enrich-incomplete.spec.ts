import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";

import {
  EnrichOneshotConfigError,
  enrichOneshotPayloadFromEnv,
} from "./oneshot-enrich-incomplete";

const workerRoot = path.resolve(import.meta.dirname, "..");

describe("enrich oneshot env payload", () => {
  it("keeps the Trigger defaults when nothing is set: dry run, no LLM, batch 25", () => {
    expect(enrichOneshotPayloadFromEnv({})).toEqual({
      applyStoredProposals: false,
      batchSize: 25,
      dryRun: true,
      enableLlmResidual: false,
    });
  });

  it("treats empty strings as unset so a blank Coolify variable stays a dry run", () => {
    expect(
      enrichOneshotPayloadFromEnv({
        ENRICH_BATCH_SIZE: "",
        ENRICH_DRY_RUN: " ",
      }).dryRun
    ).toBe(true);
  });

  it("reads explicit overrides", () => {
    expect(
      enrichOneshotPayloadFromEnv({
        ENRICH_APPLY_STORED_PROPOSALS: "1",
        ENRICH_BATCH_SIZE: "50",
        ENRICH_DRY_RUN: "FALSE",
        ENRICH_ENABLE_LLM_RESIDUAL: "no",
      })
    ).toEqual({
      applyStoredProposals: true,
      batchSize: 50,
      dryRun: false,
      enableLlmResidual: false,
    });
  });

  it("fails closed on a typo instead of guessing", () => {
    expect(() =>
      enrichOneshotPayloadFromEnv({ ENRICH_DRY_RUN: "flase" })
    ).toThrow(EnrichOneshotConfigError);
    expect(() =>
      enrichOneshotPayloadFromEnv({ ENRICH_BATCH_SIZE: "25abc" })
    ).toThrow(EnrichOneshotConfigError);
    expect(() =>
      enrichOneshotPayloadFromEnv({ ENRICH_BATCH_SIZE: "0" })
    ).toThrow(EnrichOneshotConfigError);
    expect(() =>
      enrichOneshotPayloadFromEnv({ ENRICH_BATCH_SIZE: "501" })
    ).toThrow(EnrichOneshotConfigError);
  });
});

describe("enrich oneshot wiring", () => {
  it("runs the same function as the Trigger task", () => {
    const taskSource = readFileSync(
      path.join(workerRoot, "src/tasks/enrich-incomplete.ts"),
      "utf-8"
    );
    const scriptSource = readFileSync(
      path.join(workerRoot, "scripts/oneshot-enrich-incomplete.ts"),
      "utf-8"
    );
    expect(taskSource).toContain(
      'import { runEnrichIncomplete } from "../enrich-incomplete-run";'
    );
    expect(taskSource).toContain(
      "run: (payload) => runEnrichIncomplete(payload)"
    );
    expect(scriptSource).toContain(
      'import { runEnrichIncomplete } from "../src/enrich-incomplete-run";'
    );
    // The oneshot must stay runnable in the poller image without the Trigger SDK.
    const runSource = readFileSync(
      path.join(workerRoot, "src/enrich-incomplete-run.ts"),
      "utf-8"
    );
    expect(runSource).not.toContain("@trigger.dev");
    expect(scriptSource).not.toContain("@trigger.dev");
  });

  it("exits 2 on an invalid config before opening a database connection", () => {
    const result = Bun.spawnSync({
      cmd: [process.execPath, "scripts/oneshot-enrich-incomplete.ts"],
      cwd: workerRoot,
      env: {
        ...process.env,
        DATABASE_URL: "postgresql://nobody@127.0.0.1:1/never",
        ENRICH_DRY_RUN: "maybe",
      },
    });
    expect(result.exitCode).toBe(2);
    // SAFETY: the oneshot prints exactly one JSON log line with a string `status` before exiting 2.
    const line = JSON.parse(result.stdout.toString().trim()) as {
      readonly status: string;
    };
    expect(line.status).toBe("config_invalid");
  });

  it("the Coolify wrapper holds a flock and points at the oneshot script", () => {
    const wrapper = readFileSync(
      path.join(workerRoot, "scripts/scheduled-oneshot-enrich-incomplete.sh"),
      "utf-8"
    );
    expect(wrapper).toContain("flock -n 9");
    expect(wrapper).toContain(
      "apps/worker/scripts/oneshot-enrich-incomplete.ts"
    );
  });
});
