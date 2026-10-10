import { describe, expect, it } from "bun:test";

// `@ji/env/server` validates process.env at import time and Bun caches
// modules per process, so each scenario loads the module in a fresh
// subprocess with exactly the variables under test (same approach as
// web.spec.ts). This exercises the real createEnv contract: the
// APP_RELEASE_SHA-else-SOURCE_COMMIT resolution inside runtimeEnv (an empty
// string counts as unset), the SHA regex, and the startup failure message.

const APP_SHA = "0123456789abcdef0123456789abcdef01234567";
const SOURCE_SHA = "fedcba9876543210fedcba9876543210fedcba98";
const SERVER_ENV_MODULE = `${import.meta.dir}/server.ts`;
const SECRET_SENTINEL = "super-secret-auth-token-do-not-leak-xyzzy";

const PROBE_SCRIPT = `
const { env } = await import(${JSON.stringify(SERVER_ENV_MODULE)});
console.log(JSON.stringify({ port: env.PORT, releaseSha: env.APP_RELEASE_SHA ?? null }));
`;

// Minimum the schema needs to boot; unrelated to the release SHA.
const REQUIRED_SERVER_ENV = {
  BETTER_AUTH_SECRET: "test-secret-test-secret-test-secret-1234",
  BETTER_AUTH_URL: "http://localhost:3000",
  CORS_ORIGIN: "http://localhost:3001",
  DATABASE_URL: "postgres://user:pass@localhost:5432/ji_test",
};

interface ProbeResult {
  readonly exitCode: number;
  readonly stderr: string;
  readonly stdout: string;
}

const loadServerEnv = (variables: Record<string, string>): ProbeResult => {
  const result = Bun.spawnSync({
    cmd: ["bun", "-e", PROBE_SCRIPT],
    cwd: import.meta.dir,
    // Deliberately not inheriting process.env: the parent shell (or Coolify)
    // may itself carry SOURCE_COMMIT, which would mask the cases below.
    env: {
      HOME: process.env.HOME ?? "",
      PATH: process.env.PATH ?? "",
      ...REQUIRED_SERVER_ENV,
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
  // SAFETY: probe script prints a fixed { port, releaseSha } JSON envelope we own.
  const parsed = JSON.parse(lastLine) as {
    port: number;
    releaseSha: string | null;
  };
  return parsed.releaseSha;
};

const portOf = (result: ProbeResult): number => {
  expect(result.exitCode).toBe(0);
  const lastLine = result.stdout.trim().split("\n").at(-1) ?? "";
  // SAFETY: probe script prints a fixed { port } JSON envelope we own.
  const parsed = JSON.parse(lastLine) as { port: number };
  return parsed.port;
};

describe("@ji/env/server PORT", () => {
  it("defaults to 3000 when PORT is unset", () => {
    expect(portOf(loadServerEnv({}))).toBe(3000);
  });

  it("parses a numeric PORT", () => {
    expect(portOf(loadServerEnv({ PORT: "8080" }))).toBe(8080);
  });

  it("refuses to start on a non-numeric PORT", () => {
    const result = loadServerEnv({ PORT: "abc" });
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("Invalid environment variables");
    expect(result.stderr).toContain("PORT");
  });

  it("refuses to start on an out-of-range PORT", () => {
    const result = loadServerEnv({ PORT: "70000" });
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("PORT");
  });
});

describe("@ji/env/server APP_RELEASE_SHA", () => {
  it("resolves the release SHA from Coolify's SOURCE_COMMIT when APP_RELEASE_SHA is unset", () => {
    expect(releaseShaOf(loadServerEnv({ SOURCE_COMMIT: SOURCE_SHA }))).toBe(
      SOURCE_SHA
    );
  });

  it("treats an empty APP_RELEASE_SHA as unset and still uses SOURCE_COMMIT", () => {
    // docker-compose passes `APP_RELEASE_SHA: ${APP_RELEASE_SHA:-}`, i.e. "".
    expect(
      releaseShaOf(
        loadServerEnv({ APP_RELEASE_SHA: "", SOURCE_COMMIT: SOURCE_SHA })
      )
    ).toBe(SOURCE_SHA);
  });

  it("prefers APP_RELEASE_SHA over SOURCE_COMMIT when both are set", () => {
    expect(
      releaseShaOf(
        loadServerEnv({ APP_RELEASE_SHA: APP_SHA, SOURCE_COMMIT: SOURCE_SHA })
      )
    ).toBe(APP_SHA);
  });

  it("refuses to start on a non-SHA APP_RELEASE_SHA and names both variables", () => {
    // The 2026-09-04 production symptom: an operator-managed value drifted to
    // a non-SHA string; a valid SOURCE_COMMIT must not silently paper over it.
    const result = loadServerEnv({
      APP_RELEASE_SHA: "main",
      SOURCE_COMMIT: SOURCE_SHA,
    });
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("Invalid environment variables");
    expect(result.stderr).toContain("APP_RELEASE_SHA");
    expect(result.stderr).toContain("SOURCE_COMMIT");
  });

  it("boots without a release SHA when neither variable is set (/version answers 503)", () => {
    expect(releaseShaOf(loadServerEnv({}))).toBeNull();
  });
});

describe("@ji/env/server fail-fast + no secret leakage", () => {
  it("fails fast when BETTER_AUTH_SECRET is too short and never echoes the secret", () => {
    const result = loadServerEnv({
      BETTER_AUTH_SECRET: SECRET_SENTINEL.slice(0, 16),
    });
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("Invalid environment variables");
    expect(result.stderr).toContain("BETTER_AUTH_SECRET");
    expect(result.stderr).not.toContain(SECRET_SENTINEL.slice(0, 16));
    expect(result.stdout).not.toContain(SECRET_SENTINEL.slice(0, 16));
  });

  it("fails fast on invalid DATABASE_URL and never echoes credentials", () => {
    const secretUrl =
      "postgres://ji_app:leaked-db-password-xyzzy@localhost:5432/ji";
    const result = loadServerEnv({
      // Also prove a present-but-invalid case via BETTER_AUTH_URL so we can
      // assert the password string never appears when a sibling secret is set.
      BETTER_AUTH_SECRET: SECRET_SENTINEL,
      // Empty string → treated as undefined by emptyStringAsUndefined → missing.
      DATABASE_URL: "",
    });
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("Invalid environment variables");
    expect(result.stderr).toContain("DATABASE_URL");
    expect(result.stderr).not.toContain(SECRET_SENTINEL);
    expect(result.stderr).not.toContain("leaked-db-password-xyzzy");
    // Ensure the unused secret URL literal is not accidentally printed either.
    expect(result.stderr).not.toContain(secretUrl);
  });

  it("fails fast when CORS_ORIGIN is not a URL without echoing sibling secrets", () => {
    const result = loadServerEnv({
      BETTER_AUTH_SECRET: SECRET_SENTINEL,
      CORS_ORIGIN: "not-a-url",
      DATABASE_URL: "postgres://ji_app:another-secret-pass@db/ji",
    });
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("CORS_ORIGIN");
    expect(result.stderr).not.toContain(SECRET_SENTINEL);
    expect(result.stderr).not.toContain("another-secret-pass");
  });
});
