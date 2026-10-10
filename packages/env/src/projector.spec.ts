import { describe, expect, it } from "bun:test";

// `@ji/env/projector` validates process.env at import time and Bun caches
// modules per process, so each scenario loads the module in a fresh
// subprocess with exactly the variables under test (same approach as
// server.spec.ts). This exercises the real createEnv contract: the
// APP_RELEASE_SHA-else-SOURCE_COMMIT resolution inside runtimeEnv (an empty
// string counts as unset), the SHA regex, and the startup failure message.

const APP_SHA = "0123456789abcdef0123456789abcdef01234567";
const SOURCE_SHA = "fedcba9876543210fedcba9876543210fedcba98";
const PROJECTOR_ENV_MODULE = `${import.meta.dir}/projector.ts`;

const PROBE_SCRIPT = `
const { env } = await import(${JSON.stringify(PROJECTOR_ENV_MODULE)});
console.log(JSON.stringify({ releaseSha: env.APP_RELEASE_SHA ?? null }));
`;

// Minimum the schema needs to boot; unrelated to the release SHA. The lock
// URL must be a direct endpoint, not a Neon pooler host.
const REQUIRED_PROJECTOR_ENV = {
  DATABASE_URL: "postgres://user:pass@localhost:5432/ji_test",
  MANTICORE_URL: "http://127.0.0.1:9308",
  PROJECTOR_DATABASE_URL: "postgres://user:pass@localhost:5432/ji_test",
};

interface ProbeResult {
  readonly exitCode: number;
  readonly stderr: string;
  readonly stdout: string;
}

const loadProjectorEnv = (variables: Record<string, string>): ProbeResult => {
  const result = Bun.spawnSync({
    cmd: ["bun", "-e", PROBE_SCRIPT],
    cwd: import.meta.dir,
    // Deliberately not inheriting process.env: the parent shell (or Coolify)
    // may itself carry SOURCE_COMMIT, which would mask the cases below.
    env: {
      HOME: process.env.HOME ?? "",
      PATH: process.env.PATH ?? "",
      ...REQUIRED_PROJECTOR_ENV,
      ...variables,
    },
    stderr: "pipe",
    stdout: "pipe",
  });
  return {
    exitCode: result.exitCode,
    stderr: result.stderr.toString(),
    stdout: result.stdout.toString(),
  };
};

const releaseShaOf = (result: ProbeResult): string | null => {
  expect(result.exitCode).toBe(0);
  // Last line: dotenv may print an injection tip line above the probe JSON.
  const lastLine = result.stdout.trim().split("\n").at(-1) ?? "";
  // SAFETY: probe script prints a fixed { releaseSha } JSON envelope we own.
  const parsed = JSON.parse(lastLine) as { releaseSha: string | null };
  return parsed.releaseSha;
};

describe("@ji/env/projector APP_RELEASE_SHA", () => {
  it("boots without a release SHA when neither variable is set", () => {
    expect(releaseShaOf(loadProjectorEnv({}))).toBeNull();
  });

  it("resolves the release SHA from Coolify's SOURCE_COMMIT when APP_RELEASE_SHA is unset", () => {
    expect(releaseShaOf(loadProjectorEnv({ SOURCE_COMMIT: SOURCE_SHA }))).toBe(
      SOURCE_SHA
    );
  });

  it("prefers APP_RELEASE_SHA over SOURCE_COMMIT when both are set", () => {
    expect(
      releaseShaOf(
        loadProjectorEnv({
          APP_RELEASE_SHA: APP_SHA,
          SOURCE_COMMIT: SOURCE_SHA,
        })
      )
    ).toBe(APP_SHA);
  });

  it("refuses to start on a non-SHA APP_RELEASE_SHA and names both variables", () => {
    const result = loadProjectorEnv({
      APP_RELEASE_SHA: "main",
      SOURCE_COMMIT: SOURCE_SHA,
    });
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("Invalid environment variables");
    expect(result.stderr).toContain("APP_RELEASE_SHA");
    expect(result.stderr).toContain("SOURCE_COMMIT");
  });
});
