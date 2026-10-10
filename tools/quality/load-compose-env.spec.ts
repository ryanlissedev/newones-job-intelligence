#!/usr/bin/env bun
/**
 * Contract for tools/quality/load-compose-env.sh — the helper that fills
 * unset POSTGRES_* keys before `bun run gate` (Claude Stop hook / lefthook).
 */
import { describe, expect, it } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const loaderPath = path.join(import.meta.dir, "load-compose-env.sh");

interface LoaderResult {
  exitCode: number;
  loaded: Map<string, string>;
  stderr: string;
  urls: Map<string, string>;
}

const parseEnvLines = (stdout: string, prefix: string): Map<string, string> => {
  const loaded = new Map<string, string>();
  for (const line of stdout.split("\n")) {
    if (!line.startsWith(prefix)) {
      continue;
    }
    const separator = line.indexOf("=");
    if (separator === -1) {
      continue;
    }
    loaded.set(line.slice(0, separator), line.slice(separator + 1));
  }
  return loaded;
};

const runLoader = async (options: {
  envFileContents: string;
  preset?: {
    DATABASE_URL?: string;
    POSTGRES_ADMIN_PASSWORD?: string;
    POSTGRES_ADMIN_USER?: string;
  };
}): Promise<LoaderResult> => {
  const directory = await mkdtemp(path.join(tmpdir(), "ji-compose-env-"));
  const envFile = path.join(directory, "compose.env");
  await writeFile(envFile, options.envFileContents, { mode: 0o600 });

  const unsetList = [
    "DATABASE_URL",
    "MIGRATION_DATABASE_URL",
    "POSTGRES_ADMIN_PASSWORD",
    "POSTGRES_ADMIN_USER",
    "POSTGRES_APP_PASSWORD",
    "POSTGRES_APP_USER",
    "POSTGRES_DB",
    "POSTGRES_HOST_PORT",
    "POSTGRES_MIGRATOR_PASSWORD",
    "POSTGRES_MIGRATOR_USER",
    "PROJECTOR_DATABASE_URL",
  ]
    .map((key) => `unset ${key}`)
    .join("\n");

  const preset = options.preset ?? {};
  const presetExports = [
    preset.POSTGRES_ADMIN_USER === undefined
      ? ""
      : `export POSTGRES_ADMIN_USER=${JSON.stringify(preset.POSTGRES_ADMIN_USER)}`,
    preset.POSTGRES_ADMIN_PASSWORD === undefined
      ? ""
      : `export POSTGRES_ADMIN_PASSWORD=${JSON.stringify(preset.POSTGRES_ADMIN_PASSWORD)}`,
    preset.DATABASE_URL === undefined
      ? ""
      : `export DATABASE_URL=${JSON.stringify(preset.DATABASE_URL)}`,
  ]
    .filter((line) => line.length > 0)
    .join("\n");

  const script = `
set -euo pipefail
${unsetList}
${presetExports}
export GATE_COMPOSE_ENV_FILE=${JSON.stringify(envFile)}
source ${JSON.stringify(loaderPath)}
env | awk -F= '
  $1 ~ /^POSTGRES_/ { print }
  $1 == "DATABASE_URL" { print }
  $1 == "MIGRATION_DATABASE_URL" { print }
  $1 == "PROJECTOR_DATABASE_URL" { print }
' | sort
`;

  const proc = Bun.spawn(["bash", "-c", script], {
    cwd: path.join(import.meta.dir, "../.."),
    stderr: "pipe",
    stdout: "pipe",
  });

  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);

  await rm(directory, { force: true, recursive: true });

  const urls = new Map<string, string>([
    ...parseEnvLines(stdout, "DATABASE_URL"),
    ...parseEnvLines(stdout, "MIGRATION_"),
    ...parseEnvLines(stdout, "PROJECTOR_"),
  ]);

  return {
    exitCode,
    loaded: parseEnvLines(stdout, "POSTGRES_"),
    stderr,
    urls,
  };
};

describe("load-compose-env.sh", () => {
  it("fills unset POSTGRES_* keys from the Compose env file", async () => {
    const result = await runLoader({
      envFileContents: [
        "# comment should be ignored",
        "POSTGRES_ADMIN_USER=from_file",
        "POSTGRES_ADMIN_PASSWORD=secret_from_file",
        "POSTGRES_DB=ji_from_file",
        "POSTGRES_APP_USER=app_from_file",
        "POSTGRES_APP_PASSWORD=app_secret",
        "POSTGRES_MIGRATOR_USER=mig_from_file",
        "POSTGRES_MIGRATOR_PASSWORD=mig_secret",
        "POSTGRES_HOST_PORT=5432",
        "BETTER_AUTH_SECRET=must-not-load",
        "CATAPULZE_DATABASE_URL=postgresql://must-not-load",
        "",
      ].join("\n"),
    });

    expect(result.exitCode).toBe(0);
    expect(result.loaded.get("POSTGRES_ADMIN_USER")).toBe("from_file");
    expect(result.loaded.get("POSTGRES_ADMIN_PASSWORD")).toBe(
      "secret_from_file"
    );
    expect(result.loaded.get("POSTGRES_DB")).toBe("ji_from_file");
    expect(result.loaded.has("BETTER_AUTH_SECRET")).toBe(false);
    expect(result.urls.get("DATABASE_URL")).toBe(
      "postgresql://app_from_file:app_secret@127.0.0.1:5432/ji_from_file"
    );
    expect(result.urls.get("MIGRATION_DATABASE_URL")).toBe(
      "postgresql://mig_from_file:mig_secret@127.0.0.1:5432/ji_from_file"
    );
  });

  it("does not override POSTGRES_* keys already present in the environment", async () => {
    const result = await runLoader({
      envFileContents: [
        "POSTGRES_ADMIN_USER=from_file",
        "POSTGRES_ADMIN_PASSWORD=secret_from_file",
        "POSTGRES_DB=ji_from_file",
      ].join("\n"),
      preset: {
        POSTGRES_ADMIN_PASSWORD: "already_secret",
        POSTGRES_ADMIN_USER: "already_set",
      },
    });

    expect(result.exitCode).toBe(0);
    expect(result.loaded.get("POSTGRES_ADMIN_USER")).toBe("already_set");
    expect(result.loaded.get("POSTGRES_ADMIN_PASSWORD")).toBe("already_secret");
    expect(result.loaded.get("POSTGRES_DB")).toBe("ji_from_file");
  });

  it("does not override DATABASE_URL when already set", async () => {
    const result = await runLoader({
      envFileContents: [
        "POSTGRES_APP_USER=app_from_file",
        "POSTGRES_APP_PASSWORD=app_secret",
        "POSTGRES_DB=ji_from_file",
        "POSTGRES_HOST_PORT=5432",
      ].join("\n"),
      preset: {
        DATABASE_URL: "postgresql://preset:preset@127.0.0.1:5432/preset_db",
      },
    });

    expect(result.exitCode).toBe(0);
    expect(result.urls.get("DATABASE_URL")).toBe(
      "postgresql://preset:preset@127.0.0.1:5432/preset_db"
    );
  });

  it("strips surrounding quotes from Compose-style values", async () => {
    const result = await runLoader({
      envFileContents: [
        'POSTGRES_ADMIN_USER="quoted_user"',
        "POSTGRES_ADMIN_PASSWORD='quoted_pass'",
      ].join("\n"),
    });

    expect(result.exitCode).toBe(0);
    expect(result.loaded.get("POSTGRES_ADMIN_USER")).toBe("quoted_user");
    expect(result.loaded.get("POSTGRES_ADMIN_PASSWORD")).toBe("quoted_pass");
  });

  it("percent-encodes reserved userinfo characters in derived URLs", async () => {
    const result = await runLoader({
      envFileContents: [
        "POSTGRES_APP_USER=app@role",
        "POSTGRES_APP_PASSWORD=p@ss:w/ord?#%",
        "POSTGRES_MIGRATOR_USER=mig:user",
        "POSTGRES_MIGRATOR_PASSWORD=mig/secret",
        "POSTGRES_DB=ji_from_file",
        "POSTGRES_HOST_PORT=5432",
      ].join("\n"),
    });

    expect(result.exitCode).toBe(0);
    expect(result.urls.get("DATABASE_URL")).toBe(
      "postgresql://app%40role:p%40ss%3Aw%2Ford%3F%23%25@127.0.0.1:5432/ji_from_file"
    );
    expect(result.urls.get("MIGRATION_DATABASE_URL")).toBe(
      "postgresql://mig%3Auser:mig%2Fsecret@127.0.0.1:5432/ji_from_file"
    );
    expect(result.urls.get("PROJECTOR_DATABASE_URL")).toBe(
      "postgresql://app%40role:p%40ss%3Aw%2Ford%3F%23%25@127.0.0.1:5432/ji_from_file"
    );
  });
});
