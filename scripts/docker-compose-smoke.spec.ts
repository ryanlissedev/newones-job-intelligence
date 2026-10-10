import { describe, expect, it } from "bun:test";
import {
  chmod,
  copyFile,
  mkdtemp,
  mkdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const script = await Bun.file(
  new URL("docker-compose-smoke.sh", import.meta.url)
).text();
const scriptPath = path.join(import.meta.dir, "docker-compose-smoke.sh");
const smokeComposeOverridePath = path.join(
  import.meta.dir,
  "../docker-compose.smoke.yml"
);
const ensureVolumeScriptPath = path.join(
  import.meta.dir,
  "../tools/postgres/ensure-volume.sh"
);
const composeCommand = ['"', "$", "{compose_command[@]}", '"'].join("");

const positionOf = (fragment: string): number => {
  const position = script.indexOf(fragment);
  if (position === -1) {
    throw new Error(`docker-compose smoke script is missing: ${fragment}`);
  }
  return position;
};

const expectInOrder = (...fragments: readonly string[]): void => {
  let previous = -1;
  for (const fragment of fragments) {
    const position = positionOf(fragment);
    expect(position).toBeGreaterThan(previous);
    previous = position;
  }
};

// The script scrubs ambient variables from every Compose invocation with
// `env -i`, so test knobs must be baked into the mock rather than passed as
// environment variables (mcp-edge-smoke.spec.ts uses the same pattern).
const mockDocker = (
  logPath: string,
  envLogPath: string,
  reconcileExit: number,
  cleanupExit: number,
  storageInitExit: number
): string => `#!/usr/bin/env bash
set -u
printf 'docker %s\\n' "$*" >> '${logPath}'
env > '${envLogPath}'
if [[ "$*" == *"config --format json"* ]]; then
  printf '%s\\n' '{"volumes":{"postgres_data":{"name":"mock-postgres-volume"}}}'
  exit 0
fi
if [[ "$*" == *" ps -aq"* ]]; then
  exit 0
fi
if [[ "$*" == *" ps"* ]]; then
  printf '%s\\n' 'mock compose ps'
  exit 0
fi
if [[ "$*" == *"logs --no-color --tail 80 server projector"* ]]; then
  printf '%s\\n' 'mock server/projector logs'
  exit 0
fi
if [[ "$*" == *"volume inspect"* ]]; then
  exit 1
fi
if [[ "$*" == *"port manticore 9308"* ]]; then
  printf '%s\\n' '127.0.0.1:9308'
  exit 0
fi
if [[ "$*" == *"reconcile-projection.ts"* ]]; then
  exit ${reconcileExit}
fi
if [[ "$*" == *"run --rm --no-deps raw-storage-minio-init"* ]]; then
  exit ${storageInitExit}
fi
if [[ "$*" == *"--profile projector"* && "$*" == *" down"* ]]; then
  exit ${cleanupExit}
fi
exit 0
`;

const mockBun = `#!/usr/bin/env bash
set -u
if [[ "\${1:-}" == "-e" ]]; then
  program="\${2:-}"
  if [[ "$program" == *"config.volumes.postgres_data.name"* ]]; then
    printf 'bun -e config\\n' >> "\${MOCK_LOG:?}"
    cat >/dev/null
    printf '%s\\n' 'mock-postgres-volume'
    exit 0
  fi
  if [[ "$program" == *"searchProjection"* ]]; then
    printf 'bun -e readiness\\n' >> "\${MOCK_LOG:?}"
    cat >/dev/null
    exit 0
  fi
  printf 'bun -e unknown\\n' >> "\${MOCK_LOG:?}"
  cat >/dev/null
  exit 0
fi
printf 'bun %s\\n' "$*" >> "\${MOCK_LOG:?}"
exit 0
`;

const mockCurl = `#!/usr/bin/env bash
set -u
printf 'curl %s\\n' "$*" >> "\${MOCK_LOG:?}"
if [[ "$*" == *"--write-out"* ]]; then
  printf '307'
  exit 0
fi
if [[ "$*" == *"readyz"* && "$*" != *"--fail"* ]]; then
  printf '%s\\n' '{"components":{"searchProjection":{"status":"ok","lagEvents":0}}}'
fi
exit 0
`;

interface SmokeRun {
  commands: string[];
  dockerEnv: string;
  exitCode: number;
  stderr: string;
  stdout: string;
}

const expectCommandsInOrder = (
  commands: readonly string[],
  ...expected: readonly string[]
): void => {
  let previous = -1;
  for (const command of expected) {
    const position = commands.indexOf(command);
    expect(position).toBeGreaterThan(previous);
    previous = position;
  }
};

const writeExecutable = async (
  filePath: string,
  contents: string
): Promise<void> => {
  await writeFile(filePath, contents);
  await chmod(filePath, 0o755);
};

const runSmokeWithMocks = async (
  reconcileExit = 0,
  cleanupExit = 0,
  rawStorage = false,
  storageInitExit = 0,
  extraEnv: Record<string, string> = {},
  composeEnv?: { contents: string; name: string }
): Promise<SmokeRun> => {
  const workspace = await mkdtemp(
    path.join(tmpdir(), "ji-docker-compose-smoke-")
  );
  const binDirectory = path.join(workspace, "bin");
  const logPath = path.join(workspace, "commands.log");
  const envLogPath = path.join(workspace, "docker-env.log");
  try {
    await mkdir(path.join(workspace, "apps/server"), { recursive: true });
    await mkdir(path.join(workspace, "tools/postgres"), { recursive: true });
    await mkdir(binDirectory);
    await writeFile(
      path.join(workspace, ".env"),
      "COMPOSE_PROJECT_NAME=smoke\n"
    );
    if (composeEnv) {
      await writeFile(
        path.join(workspace, composeEnv.name),
        composeEnv.contents
      );
    }
    await writeFile(path.join(workspace, "apps/server/.env"), "TEST=1\n");
    await writeFile(logPath, "");
    await copyFile(
      ensureVolumeScriptPath,
      path.join(workspace, "tools/postgres/ensure-volume.sh")
    );
    await copyFile(
      smokeComposeOverridePath,
      path.join(workspace, "docker-compose.smoke.yml")
    );
    await writeExecutable(
      path.join(binDirectory, "docker"),
      mockDocker(
        logPath,
        envLogPath,
        reconcileExit,
        cleanupExit,
        storageInitExit
      )
    );
    await writeExecutable(path.join(binDirectory, "bun"), mockBun);
    await writeExecutable(path.join(binDirectory, "curl"), mockCurl);

    const child = Bun.spawn(["bash", scriptPath], {
      cwd: workspace,
      env: {
        ...process.env,
        ...extraEnv,
        MOCK_LOG: logPath,
        PATH: `${binDirectory}:${process.env.PATH ?? "/usr/bin:/bin"}`,
        SMOKE_RAW_STORAGE: rawStorage ? "1" : "0",
      },
      stderr: "pipe",
      stdout: "pipe",
    });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    const rawCommands = await Bun.file(logPath).text();
    const commands = rawCommands.trim().split("\n").filter(Boolean);
    const dockerEnv = await Bun.file(envLogPath)
      .text()
      .catch(() => "");
    return { commands, dockerEnv, exitCode, stderr, stdout };
  } finally {
    await rm(workspace, { force: true, recursive: true });
  }
};

describe("docker-compose smoke orchestration", () => {
  it("bootstraps the search generation before the healthchecked app stack", () => {
    expectInOrder(
      `${composeCommand} --profile projector build`,
      `${composeCommand} up -d --wait postgres manticore redis`,
      "bun run db:migrate",
      `${composeCommand} run --rm --no-deps server \\\n  bun /app/tools/manticore/start-search-generation.ts --apply`,
      `${composeCommand} --profile projector up -d --no-build projector`,
      `${composeCommand} up -d --no-build --wait server web`
    );
  });

  it("drains and reconciles only after the projector generation is ready", () => {
    expectInOrder(
      `${composeCommand} --profile projector up -d --no-build projector`,
      "wait_for_projection_drain",
      `${composeCommand} --profile projector stop projector`,
      `${composeCommand} run --rm --no-deps server \\\n  bun /app/tools/search/reconcile-projection.ts --fail-on-drift`,
      "curl --fail --silent --show-error --retry 10 --retry-delay 2 http://localhost:3000/readyz >/dev/null"
    );
    expect(script).toContain(
      'projection?.status === "ok" && projection.lagEvents === 0'
    );
    expect(script).toContain("local readiness_attempts=60");
    expect(script).toContain("sleep 2");
  });

  it("does not turn the opt-in projector into a default Compose service", () => {
    expect(script).not.toContain(
      `${composeCommand} --profile projector up -d --no-build\n`
    );
    expect(script).toContain(
      `${composeCommand} --profile projector up -d --no-build projector`
    );
  });

  it("keeps compose run invocations portable across Compose versions", () => {
    expect(script).not.toContain(
      `${composeCommand} run --rm --no-deps --no-build`
    );
    expect(script).toContain(`${composeCommand} run --rm --no-deps server`);
  });

  it("builds and cleans the opt-in projector profile explicitly", () => {
    expect(script).toContain(`${composeCommand} --profile projector build`);
    expect(script).not.toContain(`${composeCommand} build\n`);
    expect(script).toContain("compose_profiles=(--profile projector)");
    expect(script).toContain("compose_profiles[@]");
    expect(script).toContain("down || cleanup_status");
  });

  it("short-circuits test isolation for the host Manticore live suite", () => {
    expect(script).toContain(
      'DATABASE_TEST_URL="postgresql://smoke:smoke@127.0.0.1:1/unreachable"'
    );
    expect(script).toContain("MANTICORE_REQUIRE_LIVE=1");
    expect(script).toContain("live_search_specs=(");
    expect(script).toContain(`bun test "\${live_search_specs[@]}"`);
    expect(script).toContain("packages/search/src/adapter.spec.ts");
    expect(script).toContain("packages/search/src/ast-hash.spec.ts");
    expect(script).toContain("packages/search/src/manticore/bulk-live.spec.ts");
    expect(script).toContain("packages/search/src/manticore/live.spec.ts");
    expect(script).toContain("packages/search/src/manticore/sort-live.spec.ts");
  });

  it("keeps synthetic S3 wiring behind an explicit smoke override", async () => {
    const override = await Bun.file(smokeComposeOverridePath).text();

    expect(script).toContain("raw_storage_enabled=");
    expect(script).toContain("SMOKE_RAW_STORAGE");
    expect(script).toContain("--file docker-compose.smoke.yml");
    expect(script).toContain(
      `${composeCommand} --profile storage up -d --wait raw-storage-minio`
    );
    expect(script).toContain(
      `${composeCommand} --profile storage run --rm --no-deps raw-storage-minio-init`
    );
    expect(override).toContain("RAW_S3_BUCKET:");
    expect(override).toContain("RAW_S3_ENDPOINT:");
  });

  it("keeps exported ambient variables out of Compose invocations", async () => {
    const result = await runSmokeWithMocks(0, 0, false, 0, {
      POSTGRES_DB: "ji_poisoned_db",
      POSTGRES_MIGRATOR_PASSWORD: "poisoned-password",
    });

    expect(result.exitCode).toBe(0);
    expect(result.dockerEnv).toContain("HOME=");
    expect(result.dockerEnv).toContain("PATH=");
    expect(result.dockerEnv).not.toContain("ji_poisoned_db");
    expect(result.dockerEnv).not.toContain("poisoned-password");
  }, 20_000);

  it("forwards COMPOSE_PARALLEL_LIMIT and Docker daemon selection through the scrub", async () => {
    const result = await runSmokeWithMocks(0, 0, false, 0, {
      COMPOSE_PARALLEL_LIMIT: "2",
      DOCKER_HOST: "ssh://builder@example.invalid",
    });

    expect(result.exitCode).toBe(0);
    expect(result.dockerEnv).toContain("COMPOSE_PARALLEL_LIMIT=2");
    expect(result.dockerEnv).toContain(
      "DOCKER_HOST=ssh://builder@example.invalid"
    );
  }, 20_000);

  it("rejects an out-of-range COMPOSE_PARALLEL_LIMIT", async () => {
    const result = await runSmokeWithMocks(0, 0, false, 0, {
      COMPOSE_PARALLEL_LIMIT: "9",
    });

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("COMPOSE_PARALLEL_LIMIT must be 1 or 2");
  }, 20_000);

  it("forwards op://-resolved secrets while ambient overrides stay scrubbed", async () => {
    const result = await runSmokeWithMocks(
      0,
      0,
      false,
      0,
      {
        BETTER_AUTH_SECRET: "resolved-secret-value",
        COMPOSE_ENV_FILE: "op.env",
        POSTGRES_DB: "ji_poisoned_db",
      },
      {
        contents:
          "BETTER_AUTH_SECRET=op://ji/local/better-auth-secret\nPOSTGRES_DB=ji_smoke\n",
        name: "op.env",
      }
    );

    expect(result.exitCode).toBe(0);
    // The op://-marked name is the one channel resolved secrets arrive on.
    expect(result.dockerEnv).toContain(
      "BETTER_AUTH_SECRET=resolved-secret-value"
    );
    // A literal (non-op://) entry stays file-authoritative: the ambient
    // poisoned POSTGRES_DB must not reach Compose.
    expect(result.dockerEnv).not.toContain("ji_poisoned_db");
  }, 20_000);

  it("starts MinIO and completes bucket bootstrap before server readiness", async () => {
    const result = await runSmokeWithMocks(0, 0, true);

    expect(result.exitCode).toBe(0);
    expectCommandsInOrder(
      result.commands,
      "docker compose --env-file .env --file docker-compose.yml --file docker-compose.smoke.yml up -d --wait postgres manticore redis",
      "docker compose --env-file .env --file docker-compose.yml --file docker-compose.smoke.yml --profile storage up -d --wait raw-storage-minio",
      "docker compose --env-file .env --file docker-compose.yml --file docker-compose.smoke.yml --profile storage run --rm --no-deps raw-storage-minio-init",
      "docker compose --env-file .env --file docker-compose.yml --file docker-compose.smoke.yml up -d --no-build --wait server web",
      "curl --silent --show-error --max-time 5 http://localhost:3000/readyz"
    );
    expect(result.commands.at(-1)).toBe(
      "docker compose --env-file .env --file docker-compose.yml --file docker-compose.smoke.yml --profile projector --profile storage down"
    );
  }, 20_000);

  it("executes the happy path in order and waits for a drained projection", async () => {
    const result = await runSmokeWithMocks();

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain(
      "docker-compose smoke: Manticore live search suite passed"
    );
    expect(result.commands).toHaveLength(21);
    expect(result.commands).toContain("bun -e config");
    expectCommandsInOrder(
      result.commands,
      "docker compose --env-file .env ps -aq",
      "docker compose --env-file .env config --format json",
      "docker volume inspect mock-postgres-volume",
      "docker volume create mock-postgres-volume",
      "docker compose --env-file .env --profile projector build",
      "docker compose --env-file .env up -d --wait postgres manticore redis",
      "bun run db:migrate",
      "docker compose --env-file .env run --rm --no-deps server bun /app/tools/manticore/start-search-generation.ts --apply",
      "docker compose --env-file .env --profile projector up -d --no-build projector",
      "docker compose --env-file .env up -d --no-build --wait server web",
      "curl --silent --show-error --max-time 5 http://localhost:3000/readyz",
      "bun -e readiness",
      "docker compose --env-file .env --profile projector stop projector",
      "docker compose --env-file .env run --rm --no-deps server bun /app/tools/search/reconcile-projection.ts --fail-on-drift",
      "curl --fail --silent --show-error --retry 10 --retry-delay 2 http://localhost:3000/readyz",
      "curl --fail --silent --show-error --retry 10 --retry-delay 2 http://localhost:3001/",
      "curl --silent --output /dev/null --write-out %{http_code} http://localhost:3001/dashboard",
      "docker compose --env-file .env port manticore 9308",
      "bun test packages/search/src/adapter.spec.ts packages/search/src/ast-hash.spec.ts packages/search/src/manticore/bulk-live.spec.ts packages/search/src/manticore/live.spec.ts packages/search/src/manticore/sort-live.spec.ts",
      "docker compose --env-file .env --profile projector down"
    );
  }, 20_000);

  it("propagates reconciliation failure, skips later curls, and still cleans the profile", async () => {
    const result = await runSmokeWithMocks(23, 17);
    const reconciliationIndex = result.commands.findIndex((command) =>
      command.includes("reconcile-projection.ts --fail-on-drift")
    );

    expect(result.exitCode).toBe(23);
    expect(result.stderr).toContain(
      "docker-compose smoke: collecting failure diagnostics (exit 23)"
    );
    expect(result.stderr).toContain("mock compose ps");
    expect(result.stderr).toContain("mock server/projector logs");
    expect(reconciliationIndex).toBeGreaterThan(-1);
    expect(result.commands.slice(reconciliationIndex + 1)).toEqual([
      "docker compose --env-file .env ps",
      "docker compose --env-file .env logs --no-color --tail 80 server projector",
      "docker compose --env-file .env --profile projector down",
    ]);
    expect(result.commands).not.toContain(
      "curl --fail --silent --show-error --retry 10 --retry-delay 2 http://localhost:3000/readyz"
    );
    expect(result.commands).not.toContain(
      "curl --fail --silent --show-error --retry 10 --retry-delay 2 http://localhost:3001/"
    );
    expect(result.commands).not.toContain(
      "curl --silent --output /dev/null --write-out %{http_code} http://localhost:3001/dashboard"
    );
  }, 20_000);

  it("returns a cleanup failure when the primary smoke path succeeds", async () => {
    const result = await runSmokeWithMocks(0, 17);

    expect(result.exitCode).toBe(17);
    expect(result.stderr).toBe("");
    expect(result.commands.at(-1)).toBe(
      "docker compose --env-file .env --profile projector down"
    );
  }, 20_000);

  it("preserves a storage bootstrap failure and still cleans every opted-in profile", async () => {
    const result = await runSmokeWithMocks(0, 17, true, 23);
    const storageInitIndex = result.commands.findIndex((command) =>
      command.includes("raw-storage-minio-init")
    );

    expect(result.exitCode).toBe(23);
    expect(result.stderr).toContain(
      "docker-compose smoke: collecting failure diagnostics (exit 23)"
    );
    expect(storageInitIndex).toBeGreaterThan(-1);
    expect(result.commands.slice(storageInitIndex + 1)).toEqual([
      "docker compose --env-file .env --file docker-compose.yml --file docker-compose.smoke.yml ps",
      "docker compose --env-file .env --file docker-compose.yml --file docker-compose.smoke.yml logs --no-color --tail 80 server projector raw-storage-minio raw-storage-minio-init",
      "docker compose --env-file .env --file docker-compose.yml --file docker-compose.smoke.yml --profile projector --profile storage down",
    ]);
  }, 20_000);
});
