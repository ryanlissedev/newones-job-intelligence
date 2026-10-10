import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { chmod, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

interface ComposeService {
  build?: { dockerfile?: string };
  environment?: Record<string, string>;
  image?: string;
  ports?: unknown[];
}

interface ComposeConfig {
  name: string;
  services: Record<string, ComposeService>;
  volumes: Record<string, { external?: boolean; name?: string }>;
}

let config: ComposeConfig;
let expectedSourceSha: string;
let tempDirectory: string;

beforeAll(async () => {
  tempDirectory = await mkdtemp(path.join(tmpdir(), "mcp-edge-contract-"));
  const configPath = path.join(tempDirectory, "config.json");
  const git = Bun.spawn(["git", "rev-parse", "HEAD"], {
    stderr: "pipe",
    stdout: "pipe",
  });
  const [gitExitCode, gitStdout] = await Promise.all([
    git.exited,
    new Response(git.stdout).text(),
  ]);
  expectedSourceSha =
    gitExitCode === 0
      ? gitStdout.trim()
      : "0000000000000000000000000000000000000448";
  const child = Bun.spawn(["bash", "scripts/mcp-edge-smoke.sh"], {
    env: {
      ...globalThis.process.env,
      CATAPULZE_DATABASE_URL: "postgresql://production.invalid/prod",
      COMPOSE_FILE: "production-compose.yml",
      COMPOSE_PROJECT_NAME: "production-project",
      CRABBOX_SOURCE_GIT_SHA: expectedSourceSha,
      MCP_EDGE_CONFIG_OUTPUT: configPath,
      MCP_EDGE_SOURCE_SHA: "0000000000000000000000000000000000000448",
      POSTGRES_DATA_VOLUME: "production-volume",
    },
    stderr: "pipe",
    stdout: "pipe",
  });
  const [stderr, exitCode] = await Promise.all([
    new Response(child.stderr).text(),
    child.exited,
  ]);
  expect(stderr).toBe("");
  expect(exitCode).toBe(0);
  // SAFETY: Docker Compose emits the service/volume shape asserted below.
  config = JSON.parse(await readFile(configPath, "utf-8")) as ComposeConfig;
}, 15_000);

afterAll(async () => {
  await rm(tempDirectory, { force: true, recursive: true });
});

describe("MCP stateless edge Compose contract", () => {
  it("builds two identical production servers behind a pinned proxy", () => {
    expect(config.services["server-a"]?.build?.dockerfile).toBe(
      "apps/server/Dockerfile"
    );
    expect(config.services["server-b"]?.build?.dockerfile).toBe(
      "apps/server/Dockerfile"
    );
    expect(config.services["server-a"]?.image).toBe(
      `${config.name}-mcp-server:${expectedSourceSha}`
    );
    expect(config.services["server-b"]?.image).toBe(
      config.services["server-a"]?.image
    );
    expect(config.services.edge?.image).toBe(
      "nginx:1.29.1-alpine@sha256:42a516af16b852e33b7682d5ef8acbd5d13fe08fecadc7ed98605ba5e3b26ab8"
    );
  });

  it("ignores hostile Compose state and owns every runtime volume", () => {
    expect(config.name).toMatch(/^catapulze-edge-/u);
    expect(config.name).not.toBe("production-project");
    expect(config.services["server-a"]?.environment?.DATABASE_URL).toBe(
      "postgresql://ji_app:ji_app_smoke@postgres:5432/ji_smoke"
    );
    expect(config.services["server-a"]?.environment?.APP_RELEASE_SHA).toBe(
      expectedSourceSha
    );
    for (const volume of [
      "postgres_data",
      "manticore_data",
      "raw_storage_minio_data",
    ]) {
      expect(config.volumes[volume]?.external).not.toBe(true);
      expect(config.volumes[volume]?.name).toBe(`${config.name}_${volume}`);
    }
  });

  it("publishes no host ports", () => {
    for (const service of [
      "postgres",
      "redis",
      "manticore",
      "raw-storage-minio",
      "server",
      "server-a",
      "server-b",
      "web",
      "edge",
    ]) {
      expect(config.services[service]?.ports ?? []).toEqual([]);
    }
  });

  it("configures real upstream identity, request correlation and no failover", async () => {
    const nginx = await readFile("scripts/mcp-edge-nginx.conf", "utf-8");
    expect(nginx).toContain("server server-a:3000;");
    expect(nginx).toContain("server server-b:3000;");
    expect(nginx).toContain("X-Catapulze-Upstream $upstream_addr");
    expect(nginx).toContain("X-Request-Id $edge_request_id");
    expect(nginx).toContain("proxy_next_upstream off;");
    expect(nginx).toContain("location = /edge-health");
    expect(nginx).toContain("proxy_buffering off;");
    expect(nginx).not.toContain("ip_hash");
  });

  it("tears its unique project down after an intermediate failure", async () => {
    const fakeDirectory = await mkdtemp(
      path.join(tmpdir(), "mcp-edge-failure-")
    );
    const fakeDockerPath = path.join(fakeDirectory, "docker");
    const commandLogPath = path.join(fakeDirectory, "commands.log");
    await Bun.write(
      fakeDockerPath,
      `#!/bin/sh\nprintf '%s\\n' "$*" >> '${commandLogPath}'\ncase "$*" in\n  *" config --quiet") exit 0 ;;\n  *" build server-a migrator projector") exit 42 ;;\n  *) exit 0 ;;\nesac\n`
    );
    await chmod(fakeDockerPath, 0o755);
    const child = Bun.spawn(["bash", "scripts/mcp-edge-smoke.sh"], {
      env: {
        ...globalThis.process.env,
        MCP_EDGE_ARTIFACT_DIR: path.join(fakeDirectory, "artifacts"),
        PATH: `${fakeDirectory}:${globalThis.process.env.PATH ?? ""}`,
      },
      stderr: "pipe",
      stdout: "pipe",
    });
    const exitCode = await child.exited;
    const commands = await readFile(commandLogPath, "utf-8");
    await rm(fakeDirectory, { force: true, recursive: true });
    expect(exitCode).toBe(42);
    expect(commands).toContain("build server-a migrator projector");
    expect(commands).toContain("down --volumes --remove-orphans");
  });
});
