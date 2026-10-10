import { describe, expect, it } from "bun:test";

// `@ji/env/web` validates process.env at import time and Bun caches modules
// per process, so each scenario loads the module in a fresh subprocess with
// exactly the variables under test. This exercises the real createEnv
// contract (server scope, emptyStringAsUndefined, URL SoT) rather than the
// resolver in isolation — see internal-server-url.spec.ts for that.

const PUBLIC_URL = "http://localhost:3000";
const INTERNAL_URL = "http://server:3000";
const WEB_ENV_MODULE = `${import.meta.dir}/web.ts`;

const PROBE_SCRIPT = `
const { env, fixturesEnabled, getInternalServerUrl } = await import(${JSON.stringify(WEB_ENV_MODULE)});
console.log(JSON.stringify({
  fixturesEnabled,
  internal: getInternalServerUrl(),
  publicUrl: env.NEXT_PUBLIC_SERVER_URL,
  releaseSha: env.APP_RELEASE_SHA ?? null,
}));
`;

interface ProbeResult {
  readonly exitCode: number;
  readonly stderr: string;
  readonly stdout: string;
}

const loadWebEnv = (variables: Record<string, string>): ProbeResult => {
  const result = Bun.spawnSync({
    cmd: ["bun", "-e", PROBE_SCRIPT],
    cwd: import.meta.dir,
    // Deliberately not inheriting process.env: the parent shell may itself
    // carry INTERNAL_SERVER_URL, which would silently mask the fallback case.
    env: {
      HOME: process.env.HOME ?? "",
      PATH: process.env.PATH ?? "",
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

interface ProbeEnvelope {
  readonly fixturesEnabled: boolean;
  readonly internal: string;
  readonly publicUrl: string;
  readonly releaseSha: string | null;
}

const parseProbe = (result: ProbeResult): ProbeEnvelope => {
  expect(result.exitCode).toBe(0);
  // SAFETY: probe script prints a fixed JSON envelope we own.
  return JSON.parse(result.stdout.trim()) as ProbeEnvelope;
};

describe("@ji/env/web INTERNAL_SERVER_URL", () => {
  it("uses INTERNAL_SERVER_URL for server-side fetches when set", () => {
    const probe = parseProbe(
      loadWebEnv({
        INTERNAL_SERVER_URL: INTERNAL_URL,
        NEXT_PUBLIC_SERVER_URL: PUBLIC_URL,
      })
    );
    expect(probe.internal).toBe(INTERNAL_URL);
    expect(probe.publicUrl).toBe(PUBLIC_URL);
  });

  it("defaults to NEXT_PUBLIC_SERVER_URL when INTERNAL_SERVER_URL is absent", () => {
    const probe = parseProbe(
      loadWebEnv({ NEXT_PUBLIC_SERVER_URL: PUBLIC_URL })
    );
    expect(probe.internal).toBe(PUBLIC_URL);
  });

  it("treats an empty INTERNAL_SERVER_URL as absent (emptyStringAsUndefined)", () => {
    const probe = parseProbe(
      loadWebEnv({
        INTERNAL_SERVER_URL: "",
        NEXT_PUBLIC_SERVER_URL: PUBLIC_URL,
      })
    );
    expect(probe.internal).toBe(PUBLIC_URL);
  });

  it("rejects an INTERNAL_SERVER_URL without an http(s) scheme", () => {
    // "server:3000" parses as a URL with scheme "server" — the realistic typo.
    const result = loadWebEnv({
      INTERNAL_SERVER_URL: "server:3000",
      NEXT_PUBLIC_SERVER_URL: PUBLIC_URL,
    });
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("INTERNAL_SERVER_URL");
  });
});

const RELEASE_SHA = "0123456789abcdef0123456789abcdef01234567";
const OTHER_RELEASE_SHA = "fedcba9876543210fedcba9876543210fedcba98";

describe("@ji/env/web APP_RELEASE_SHA", () => {
  it("resolves the release SHA from Coolify's SOURCE_COMMIT when APP_RELEASE_SHA is unset", () => {
    const probe = parseProbe(
      loadWebEnv({
        NEXT_PUBLIC_SERVER_URL: PUBLIC_URL,
        SOURCE_COMMIT: RELEASE_SHA,
      })
    );
    expect(probe.releaseSha).toBe(RELEASE_SHA);
  });

  it("prefers an explicit APP_RELEASE_SHA over SOURCE_COMMIT", () => {
    const probe = parseProbe(
      loadWebEnv({
        APP_RELEASE_SHA: OTHER_RELEASE_SHA,
        NEXT_PUBLIC_SERVER_URL: PUBLIC_URL,
        SOURCE_COMMIT: RELEASE_SHA,
      })
    );
    expect(probe.releaseSha).toBe(OTHER_RELEASE_SHA);
  });

  it("exposes no release identity when neither variable is set", () => {
    const probe = parseProbe(
      loadWebEnv({ NEXT_PUBLIC_SERVER_URL: PUBLIC_URL })
    );
    expect(probe.releaseSha).toBeNull();
  });

  it("rejects a release SHA that is not a full lowercase Git SHA", () => {
    const result = loadWebEnv({
      NEXT_PUBLIC_SERVER_URL: PUBLIC_URL,
      SOURCE_COMMIT: "main",
    });
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("APP_RELEASE_SHA");
  });
});

describe("@ji/env/web NEXT_PUBLIC_USE_FIXTURES", () => {
  it('"true" enables fixtures', () => {
    const probe = parseProbe(
      loadWebEnv({
        NEXT_PUBLIC_SERVER_URL: PUBLIC_URL,
        NEXT_PUBLIC_USE_FIXTURES: "true",
      })
    );
    expect(probe.fixturesEnabled).toBe(true);
  });

  it('"1" enables fixtures', () => {
    const probe = parseProbe(
      loadWebEnv({
        NEXT_PUBLIC_SERVER_URL: PUBLIC_URL,
        NEXT_PUBLIC_USE_FIXTURES: "1",
      })
    );
    expect(probe.fixturesEnabled).toBe(true);
  });

  it("defaults to disabled when unset", () => {
    const probe = parseProbe(
      loadWebEnv({ NEXT_PUBLIC_SERVER_URL: PUBLIC_URL })
    );
    expect(probe.fixturesEnabled).toBe(false);
  });

  it('"yes" does not enable fixtures', () => {
    const probe = parseProbe(
      loadWebEnv({
        NEXT_PUBLIC_SERVER_URL: PUBLIC_URL,
        NEXT_PUBLIC_USE_FIXTURES: "yes",
      })
    );
    expect(probe.fixturesEnabled).toBe(false);
  });

  it("treats an empty value as disabled", () => {
    const probe = parseProbe(
      loadWebEnv({
        NEXT_PUBLIC_SERVER_URL: PUBLIC_URL,
        NEXT_PUBLIC_USE_FIXTURES: "",
      })
    );
    expect(probe.fixturesEnabled).toBe(false);
  });
});
