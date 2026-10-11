import { existsSync } from "node:fs";
import path from "node:path";

import { createAuthStub } from "./auth-stub";

const port = Number(process.env.PORT ?? "3001");
const authPort = Number(process.env.E2E_FIXTURES_AUTH_PORT ?? "3310");
const repoRoot = path.resolve(import.meta.dir, "../../../");
const webRoot = path.resolve(repoRoot, "apps/web");
const buildDir = path.resolve(webRoot, ".next-e2e-fixtures");

if (!existsSync(path.resolve(buildDir, "BUILD_ID"))) {
  throw new Error(
    "Fixture web build is missing; run scripts/e2e/fixtures-build.sh"
  );
}

const authStub = createAuthStub(authPort);
const child = Bun.spawn(["bun", "x", "next", "start", "--port", String(port)], {
  cwd: webRoot,
  env: {
    ...process.env,
    // The stub password stays in this process; Next never needs it.
    E2E_FIXTURES_STUB_PASSWORD: "",
    INTERNAL_SERVER_URL: `http://127.0.0.1:${authPort}`,
    JI_WEB_DIST_DIR: ".next-e2e-fixtures",
    LANG: "nl_NL.UTF-8",
    NEXT_PUBLIC_SERVER_URL: `http://127.0.0.1:${authPort}`,
    NEXT_PUBLIC_USE_FIXTURES: "1",
    TZ: "Europe/Amsterdam",
  },
  stderr: "inherit",
  stdout: "inherit",
});

let shuttingDown = false;
const shutdown = (signal: NodeJS.Signals): void => {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;
  child.kill(signal);
};

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

const exitCode = await child.exited;
authStub.close();
process.exit(exitCode);
