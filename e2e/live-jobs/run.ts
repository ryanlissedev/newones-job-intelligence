import { preflightLiveJobsRun } from "./run-preflight";
import type { LiveJobsRunMode } from "./run-preflight";

const [requestedMode] = process.argv.slice(2);

const configPathByMode = {
  anonymous: "playwright.live-anonymous.config.ts",
  session: "playwright.live.config.ts",
  writes: "playwright.live-writes.config.ts",
} as const;

const isLiveJobsRunMode = (
  value: string | undefined
): value is LiveJobsRunMode =>
  value === "anonymous" || value === "session" || value === "writes";

if (!isLiveJobsRunMode(requestedMode)) {
  throw new Error("Usage: bun e2e/live-jobs/run.ts <session|anonymous|writes>");
}

const run = async (): Promise<number> => {
  await preflightLiveJobsRun(requestedMode);

  const result = Bun.spawnSync({
    cmd: [
      "./node_modules/.bin/playwright",
      "test",
      `--config=${configPathByMode[requestedMode]}`,
    ],
    stderr: "inherit",
    stdout: "inherit",
  });

  return result.exitCode ?? 1;
};

process.exit(await run());
