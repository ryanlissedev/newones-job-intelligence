import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  summarizeUnitDiagnostics,
  writeUnitDiagnosticArtifacts,
} from "./crabbox-unit-diagnostics";

// These tests spawn the real bash launcher (git fixture, subprocesses). Under
// the default 5s per-test budget they time out when several gates run in
// parallel on one machine (observed 5.7s and 8.7s) — the launcher is not
// slow, the box is busy. A generous file-scoped budget keeps the assertion
// meaningful without turning host load into a red gate.
const LAUNCHER_TEST_TIMEOUT_MS = 60_000;
setDefaultTimeout(LAUNCHER_TEST_TIMEOUT_MS);

const launcherSource = path.join(
  import.meta.dir,
  "crabbox-exe-dev-shadow-run.sh"
);
let launcher = launcherSource;
const shadowScript = path.join(import.meta.dir, "crabbox-exe-dev-shadow.sh");
const unitDiagnosticsScript = path.join(
  import.meta.dir,
  "crabbox-unit-diagnostics.ts"
);
const sourceSha = "a".repeat(40);
const realGit = Bun.which("git") ?? "";
const realRm = Bun.which("rm") ?? "/bin/rm";
const cleanupFixtureExitStatuses = [0, 23] as const;
const launcherFixtureTimeoutMs = 30_000;
const nodeImage =
  "node:24-slim@sha256:ba849c60be29959425b8734d57b8b4b7d56f98edd9504c9af091d5281095a71e";
const remoteEvidencePath = "crabbox-output/exe-dev-shadow";
const crabboxArchiveSha256 =
  "7e742950103248c976b429c3ceab6fc6c37e091c96cfd47b473c29565f68f2dc";

const createExecutable = (filePath: string, contents: string): void => {
  writeFileSync(filePath, contents);
  chmodSync(filePath, 0o755);
};

const createLauncherFixture = (
  sourceShaValue = sourceSha,
  statusExitCode = 0,
  statusOutput = ""
) => {
  if (!realGit) {
    throw new Error("git is required for launcher fixtures");
  }
  const workspace = mkdtempSync(path.join(tmpdir(), "ji-shadow-launcher-"));
  const binDirectory = path.join(workspace, "bin");
  const argumentsFile = path.join(workspace, "arguments");
  const environmentFile = path.join(workspace, "environment");
  const gitStateFile = path.join(workspace, "git-state");
  const rmFailureMarker = path.join(workspace, "rm-failure-marker");
  const materializedWorkspaceFile = path.join(
    workspace,
    "materialized-workspace"
  );
  mkdirSync(binDirectory);
  mkdirSync(path.join(workspace, "scripts"));
  writeFileSync(
    path.join(workspace, "scripts/check-secrets-scan.ts"),
    `const arguments_ = process.argv.slice(2);
const preflightHoldPidFile = process.env.CRABBOX_FIXTURE_PREFLIGHT_HOLD_PID;
if (preflightHoldPidFile) {
  await Bun.write(preflightHoldPidFile, \`\${process.pid}\\n\`);
  await Bun.sleep(1500);
}
const manifestIndex = arguments_.indexOf("--write-manifest");
const manifestPath = arguments_[manifestIndex + 1];
await Bun.write(manifestPath, '${"b".repeat(64)}  "scripts/check-secrets-scan.ts"\\n');
`
  );
  createExecutable(
    path.join(binDirectory, "git"),
    `#!/usr/bin/env bash
set -euo pipefail
for variable in GIT_ALTERNATE_OBJECT_DIRECTORIES GIT_COMMON_DIR GIT_CONFIG GIT_CONFIG_COUNT GIT_CONFIG_PARAMETERS GIT_DIR GIT_GRAFT_FILE GIT_IMPLICIT_WORK_TREE GIT_INDEX_FILE GIT_NO_REPLACE_OBJECTS GIT_OBJECT_DIRECTORY GIT_PREFIX GIT_REPLACE_REF_BASE GIT_SHALLOW_FILE GIT_WORK_TREE; do
  [[ -z "\${!variable+x}" ]] || exit 65
done
[[ "\${1:-}" == "--no-replace-objects" ]] || exit 66
shift
expected_workspace_root="\${EXPECTED_WORKSPACE_ROOT:-$PWD}"
if [[ "$#" -eq 2 && "$1" == "rev-parse" && "$2" == "--show-toplevel" ]]; then
  printf '%s\\n' "$expected_workspace_root"
elif [[ "$#" -eq 5 && "$1" == "-C" && "$2" == "$expected_workspace_root" && "$3" == "rev-parse" && "$4" == "--verify" && "$5" == "HEAD" ]]; then
  printf '%s\\n' "${sourceShaValue}"
elif [[ "$#" -eq 5 && "$1" == "-C" && "$2" == "$expected_workspace_root" && "$3" == "status" && "$4" == "--porcelain=v1" && "$5" == "--untracked-files=all" ]]; then
  printf '%s' '${statusOutput}'
  exit ${statusExitCode}
elif [[ "$#" -eq 6 && "$1" == "-C" && "$2" == "$expected_workspace_root" && "$3" == "archive" && "$4" == "--format=tar" && "$5" == --output=* && "$6" == "${sourceShaValue}" ]]; then
  output="\${5#--output=}"
  /usr/bin/tar -cf "$output" -C "$expected_workspace_root" scripts
elif [[ "\${1:-}" == "init" || "\${1:-}" == "add" || "\${1:-}" == "-c" ]]; then
  exec "$REAL_GIT" --no-replace-objects "$@"
else
  exit 64
fi
`
  );
  const crabboxPath = path.join(binDirectory, "crabbox");
  createExecutable(
    crabboxPath,
    `#!/usr/bin/env bash
set -euo pipefail
if [[ "$#" -eq 1 && "$1" == "--version" ]]; then
  printf '%s\\n' "\${CRABBOX_VERSION_OUTPUT:-0.62.0}"
  exit 0
fi
if [[ -n "\${CRABBOX_FIXTURE_HOLD_PID:-}" ]]; then
  printf '%s\\n' "$$" >"$CRABBOX_FIXTURE_HOLD_PID"
  sleep 30 &
  sleep_pid="$!"
  trap 'kill "$sleep_pid" 2>/dev/null; exit 143' TERM
  wait "$sleep_pid"
  exit 0
fi
printf '%s\\n' "$@" >"$CAPTURE_ARGUMENTS"
printf '%s\\n' "$CRABBOX_SOURCE_GIT_SHA" "$CRABBOX_SOURCE_GIT_STATE" >"$CAPTURE_ENVIRONMENT"
printf '%s\\n' "$PWD" >"$CAPTURE_MATERIALIZED_WORKSPACE"
printf '%s\\n' "$CRABBOX_SOURCE_MANIFEST_SHA256" "$CRABBOX_SOURCE_MANIFEST_FILE_COUNT" "$CRABBOX_SOURCE_MATERIALIZATION_DURATION_MS" "$CRABBOX_SOURCE_PREFLIGHT_DURATION_MS" >>"$CAPTURE_ENVIRONMENT"
if [[ -n "\${MATERIALIZED_EVIDENCE_FIXTURE:-}" ]]; then
  mkdir -p .artifacts/crabbox/exe-dev-shadow
  printf 'fresh\\n' >.artifacts/crabbox/exe-dev-shadow/report.md
fi
if [[ -n "\${MATERIALIZED_VALIDATION_STATUS_FIXTURE:-}" ]]; then
  mkdir -p .artifacts/crabbox/exe-dev-shadow
  printf '%s\\n' "$MATERIALIZED_VALIDATION_STATUS_FIXTURE" >.artifacts/crabbox/exe-dev-shadow/validation-exit-status.txt
fi
if [[ -n "\${CAPTURE_GIT_STATE:-}" ]]; then
  # Git exports GIT_DIR/GIT_PREFIX to hooks (pre-push gate); inspect the
  # materialized repo, not the repo that launched the hook.
  unset GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE GIT_PREFIX GIT_COMMON_DIR
  "$REAL_GIT" log --oneline >"$CAPTURE_GIT_STATE"
  if "$REAL_GIT" -C . ls-files --error-unmatch .crabbox-input-manifest.sha256 >/dev/null; then
    printf 'manifest-ls-files-exit=0\\n' >>"$CAPTURE_GIT_STATE"
  else
    git_exit_status="$?"
    printf 'manifest-ls-files-exit=%s\\n' "$git_exit_status" >>"$CAPTURE_GIT_STATE"
  fi
fi
exit "\${CRABBOX_FIXTURE_EXIT_STATUS:-0}"
`
  );
  const crabboxBinarySha256 = createHash("sha256")
    .update(readFileSync(crabboxPath))
    .digest("hex");
  const provenanceFile = `${crabboxPath}.provenance`;
  writeFileSync(
    provenanceFile,
    `archive_sha256=${crabboxArchiveSha256}\nbinary_sha256=${crabboxBinarySha256}\n`
  );
  launcher = path.join(workspace, "crabbox-exe-dev-shadow-run.sh");
  createExecutable(
    launcher,
    readFileSync(launcherSource, "utf-8").replace(
      /readonly EXPECTED_CRABBOX_BINARY_SHA256="[0-9a-f]+"/u,
      `readonly EXPECTED_CRABBOX_BINARY_SHA256="${crabboxBinarySha256}"`
    )
  );
  createExecutable(
    path.join(binDirectory, "rm"),
    `#!/usr/bin/env bash
set -euo pipefail
if [[ "$*" == *"/ji-exe-dev-shadow."* ]]; then
  if [[ -n "\${CRABBOX_FIXTURE_RM_ALWAYS_FAIL:-}" ]]; then
    exit 42
  fi
  if [[ -n "\${CRABBOX_FIXTURE_RM_FAIL_ONCE:-}" && ! -e "$RM_FAILURE_MARKER" ]]; then
    : >"$RM_FAILURE_MARKER"
    exit 1
  fi
fi
exec "$REAL_RM" "$@"
`
  );

  return {
    argumentsFile,
    binDirectory,
    environmentFile,
    gitStateFile,
    launcherPath: launcher,
    materializedWorkspaceFile,
    provenanceFile,
    rmFailureMarker,
    workspace,
  };
};

const launcherEnvironment = (
  fixture: ReturnType<typeof createLauncherFixture>
) => ({
  ...process.env,
  CAPTURE_ARGUMENTS: fixture.argumentsFile,
  CAPTURE_ENVIRONMENT: fixture.environmentFile,
  CAPTURE_MATERIALIZED_WORKSPACE: fixture.materializedWorkspaceFile,
  CRABBOX_EXE_DEV_CONTROL_HOST: "exe.dev",
  EXE_DEV_REGION: "FRA",
  EXPECTED_WORKSPACE_ROOT: fixture.workspace,
  PATH: `${fixture.binDirectory}:${process.env.PATH ?? "/usr/bin:/bin"}`,
  REAL_GIT: realGit,
  REAL_RM: realRm,
  RM_FAILURE_MARKER: fixture.rmFailureMarker,
});

const cleanupMaterializedWorkspace = (
  fixture: ReturnType<typeof createLauncherFixture>
): void => {
  if (!existsSync(fixture.materializedWorkspaceFile)) {
    return;
  }
  const materializedWorkspace = readFileSync(
    fixture.materializedWorkspaceFile,
    "utf-8"
  ).trim();
  if (materializedWorkspace.length === 0) {
    return;
  }
  rmSync(path.dirname(materializedWorkspace), { force: true, recursive: true });
};

const writeInputManifest = (workspace: string, entries: string[]): string => {
  const manifest = entries
    .map((relativePath) => `${"b".repeat(64)}  ${JSON.stringify(relativePath)}`)
    .join("\n");
  const manifestPath = path.join(workspace, ".crabbox-input-manifest.sha256");
  writeFileSync(manifestPath, `${manifest}\n`);
  return manifestPath;
};

const waitForFile = (filePath: string, timeoutMs: number): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  const poll = async (): Promise<void> => {
    if (existsSync(filePath)) {
      return;
    }
    if (Date.now() >= deadline) {
      throw new Error(`timed out waiting for ${filePath}`);
    }
    await Bun.sleep(50);
    return poll();
  };
  return poll();
};

describe("exe.dev shadow scripts", () => {
  test("forwards ordinary flags with source identity", () => {
    const fixture = createLauncherFixture();
    try {
      const result = Bun.spawnSync(["bash", launcher, "--dry-run"], {
        env: launcherEnvironment(fixture),
        stderr: "pipe",
        stdout: "pipe",
      });

      expect(result.exitCode).toBe(0);
      expect(readFileSync(fixture.argumentsFile, "utf-8")).toBe(
        "job\nrun\n--dry-run\nexe-dev-shadow\n"
      );
      const environment = readFileSync(fixture.environmentFile, "utf-8");
      expect(environment).toMatch(
        new RegExp(`^${sourceSha}\\nclean\\nsha256:[0-9a-f]{64}\\n1\\n`, "u")
      );
      expect(readFileSync(fixture.materializedWorkspaceFile, "utf-8")).not.toBe(
        `${fixture.workspace}\n`
      );
      const metadata = environment.trim().split("\n");
      expect(Number.isInteger(Number(metadata[4]))).toBe(true);
      expect(Number.isInteger(Number(metadata[5]))).toBe(true);
    } finally {
      rmSync(fixture.workspace, { force: true, recursive: true });
    }
  });

  test("retries transient materialization cleanup and preserves Crabbox status", () => {
    const fixture = createLauncherFixture();
    try {
      const result = Bun.spawnSync(["bash", launcher, "--dry-run"], {
        env: {
          ...launcherEnvironment(fixture),
          CRABBOX_FIXTURE_EXIT_STATUS: "23",
          CRABBOX_FIXTURE_RM_FAIL_ONCE: "1",
        },
        stderr: "pipe",
        stdout: "pipe",
      });

      expect(result.exitCode).toBe(23);
      expect(result.stderr.toString()).toBe("");
      expect(existsSync(fixture.rmFailureMarker)).toBe(true);
      const materializedWorkspace = readFileSync(
        fixture.materializedWorkspaceFile,
        "utf-8"
      ).trim();
      expect(existsSync(materializedWorkspace)).toBe(false);
    } finally {
      cleanupMaterializedWorkspace(fixture);
      rmSync(fixture.workspace, { force: true, recursive: true });
    }
  });

  for (const originalExitStatus of cleanupFixtureExitStatuses) {
    test(`reports permanent materialization cleanup failure without changing status ${originalExitStatus}`, () => {
      const fixture = createLauncherFixture();
      try {
        const result = Bun.spawnSync(
          ["bash", fixture.launcherPath, "--dry-run"],
          {
            env: {
              ...launcherEnvironment(fixture),
              CRABBOX_FIXTURE_EXIT_STATUS: String(originalExitStatus),
              CRABBOX_FIXTURE_RM_ALWAYS_FAIL: "1",
            },
            stderr: "pipe",
            stdout: "pipe",
          }
        );

        expect(result.exitCode).toBe(originalExitStatus);
        expect(result.stderr.toString()).toContain(
          "failed to clean up materialization workspace after 3 attempts"
        );
        expect(result.stderr.toString()).not.toContain("rm:");
      } finally {
        cleanupMaterializedWorkspace(fixture);
        rmSync(fixture.workspace, { force: true, recursive: true });
      }
    });
  }

  test("seeds the materialized workspace with a tracked input manifest", () => {
    const fixture = createLauncherFixture();
    try {
      const result = Bun.spawnSync(["bash", launcher, "--dry-run"], {
        env: {
          ...launcherEnvironment(fixture),
          CAPTURE_GIT_STATE: fixture.gitStateFile,
        },
        stderr: "pipe",
        stdout: "pipe",
      });

      expect(result.stderr.toString()).toBe("");
      expect(result.exitCode).toBe(0);
      const gitState = readFileSync(fixture.gitStateFile, "utf-8")
        .trim()
        .split("\n");
      expect(gitState).toHaveLength(2);
      expect(gitState[0]).toMatch(
        new RegExp(`^[0-9a-f]+ materialized ${sourceSha}$`, "u")
      );
      expect(gitState[1]).toBe("manifest-ls-files-exit=0");
    } finally {
      rmSync(fixture.workspace, { force: true, recursive: true });
    }
  });

  test("isolates source fingerprinting from inherited repository bindings", () => {
    const fixture = createLauncherFixture();
    try {
      const result = Bun.spawnSync(["bash", launcher, "--dry-run"], {
        env: {
          ...launcherEnvironment(fixture),
          GIT_DIR: "/foreign/repository/.git",
          GIT_INDEX_FILE: "/foreign/repository/.git/index",
          GIT_WORK_TREE: "/foreign/repository",
        },
        stderr: "pipe",
        stdout: "pipe",
      });

      expect(result.stderr.toString()).toBe("");
      expect(result.exitCode).toBe(0);
      expect(readFileSync(fixture.environmentFile, "utf-8")).toContain(
        `${sourceSha}\nclean\n`
      );
    } finally {
      rmSync(fixture.workspace, { force: true, recursive: true });
    }
  });

  test("excludes generated artifacts from sync and Docker contexts", () => {
    const repositoryRoot = path.join(import.meta.dir, "..");
    const crabboxConfig = readFileSync(
      path.join(repositoryRoot, ".crabbox.yaml"),
      "utf-8"
    );
    const dockerignore = readFileSync(
      path.join(repositoryRoot, ".dockerignore"),
      "utf-8"
    );

    expect(crabboxConfig.split("\n")).toContain("    - .artifacts");
    expect(crabboxConfig.split("\n")).toContain('    - ".env*"');
    expect(crabboxConfig.split("\n")).toContain('    - "!.env.example"');
    expect(crabboxConfig.split("\n")).toContain(
      '    - "!apps/server/.env.example"'
    );
    expect(crabboxConfig.split("\n")).toContain(
      '    - "!apps/web/.env.example"'
    );
    expect(crabboxConfig.split("\n")).toContain(
      "    - .fireflies-request.json"
    );
    expect(crabboxConfig.split("\n")).toContain(
      "    - .fireflies-transcript.json"
    );
    expect(dockerignore.split("\n")).toContain(".artifacts");
    expect(dockerignore.split("\n")).toContain("**/.artifacts");
    expect(crabboxConfig).toContain(
      `${remoteEvidencePath}/junit.xml=.artifacts/crabbox/exe-dev-shadow/junit.xml`
    );
    expect(crabboxConfig).toContain(
      `${remoteEvidencePath}/unit-diagnostics.log=.artifacts/crabbox/exe-dev-shadow/unit-diagnostics.log`
    );
    expect(crabboxConfig).toContain(
      `${remoteEvidencePath}/unit-diagnostics.json=.artifacts/crabbox/exe-dev-shadow/unit-diagnostics.json`
    );
    expect(crabboxConfig).toContain(
      `artifactGlobs:\n      - ${remoteEvidencePath}/**`
    );
    expect(crabboxConfig).toContain(
      `${remoteEvidencePath}/validation-exit-status.txt=.artifacts/crabbox/exe-dev-shadow/validation-exit-status.txt`
    );
    expect(crabboxConfig).toContain(
      `${remoteEvidencePath}/mcp-edge-smoke/evidence.json`
    );
    expect(crabboxConfig).toContain(
      `${remoteEvidencePath}/mcp-edge-smoke/runtime-identity.json`
    );
    expect(crabboxConfig).toContain(
      `${remoteEvidencePath}/mcp-edge-smoke/route-config.conf`
    );
    expect(crabboxConfig).toContain(
      `${remoteEvidencePath}/mcp-edge-smoke/container-status.txt`
    );
    expect(crabboxConfig).toContain(
      `${remoteEvidencePath}/mcp-edge-smoke/evidence.json=.artifacts/crabbox/exe-dev-shadow/mcp-edge-smoke/evidence.json`
    );
    expect(crabboxConfig).toContain(
      `${remoteEvidencePath}/mcp-edge-smoke/runtime-identity.json=.artifacts/crabbox/exe-dev-shadow/mcp-edge-smoke/runtime-identity.json`
    );
    expect(crabboxConfig).toContain(
      `${remoteEvidencePath}/mcp-edge-smoke/route-config.conf=.artifacts/crabbox/exe-dev-shadow/mcp-edge-smoke/route-config.conf`
    );
    expect(crabboxConfig).toContain(
      `${remoteEvidencePath}/mcp-edge-smoke/container-status.txt=.artifacts/crabbox/exe-dev-shadow/mcp-edge-smoke/container-status.txt`
    );
    expect(crabboxConfig).toContain(
      "command: CRABBOX_CAPTURE_VALIDATION_STATUS=1 bash scripts/crabbox-exe-dev-shadow.sh"
    );
  });

  test("rejects every existing-lease id form before invoking Crabbox", () => {
    const forbiddenArguments = [
      ["--id", "lease"],
      ["--id=lease"],
      ["-id", "lease"],
      ["-id=lease"],
    ];

    for (const arguments_ of forbiddenArguments) {
      const fixture = createLauncherFixture();
      try {
        const result = Bun.spawnSync(["bash", launcher, ...arguments_], {
          env: {
            ...process.env,
            CAPTURE_ARGUMENTS: fixture.argumentsFile,
            CAPTURE_ENVIRONMENT: fixture.environmentFile,
            CRABBOX_EXE_DEV_CONTROL_HOST: "exe.dev",
            EXE_DEV_REGION: "FRA",
            PATH: `${fixture.binDirectory}:${process.env.PATH ?? "/usr/bin:/bin"}`,
          },
          stderr: "pipe",
          stdout: "pipe",
        });

        expect(result.exitCode).not.toBe(0);
        expect(result.stderr.toString()).toContain(
          "existing-lease --id arguments are forbidden"
        );
        expect(() => readFileSync(fixture.argumentsFile)).toThrow();
      } finally {
        rmSync(fixture.workspace, { force: true, recursive: true });
      }
    }
  });

  test("requires explicit approval for the configured control host", () => {
    for (const controlHost of [undefined, "example.invalid"]) {
      const fixture = createLauncherFixture();
      try {
        const environment = {
          ...process.env,
          CAPTURE_ARGUMENTS: fixture.argumentsFile,
          CAPTURE_ENVIRONMENT: fixture.environmentFile,
          CRABBOX_EXE_DEV_CONTROL_HOST: controlHost,
          EXE_DEV_REGION: "FRA",
          PATH: `${fixture.binDirectory}:${process.env.PATH ?? "/usr/bin:/bin"}`,
        };
        if (controlHost === undefined) {
          delete environment.CRABBOX_EXE_DEV_CONTROL_HOST;
        }

        const result = Bun.spawnSync(["bash", launcher, "--dry-run"], {
          env: environment,
          stderr: "pipe",
          stdout: "pipe",
        });

        expect(result.exitCode).not.toBe(0);
        expect(result.stderr.toString()).toContain(
          "set CRABBOX_EXE_DEV_CONTROL_HOST=exe.dev"
        );
        expect(() => readFileSync(fixture.argumentsFile)).toThrow();
      } finally {
        rmSync(fixture.workspace, { force: true, recursive: true });
      }
    }
  });

  test("requires the configured region before invoking Crabbox", () => {
    for (const region of [undefined, "AMS"]) {
      const fixture = createLauncherFixture();
      try {
        const environment = {
          ...process.env,
          CAPTURE_ARGUMENTS: fixture.argumentsFile,
          CAPTURE_ENVIRONMENT: fixture.environmentFile,
          CRABBOX_EXE_DEV_CONTROL_HOST: "exe.dev",
          EXE_DEV_REGION: region,
          PATH: `${fixture.binDirectory}:${process.env.PATH ?? "/usr/bin:/bin"}`,
        };
        if (region === undefined) {
          delete environment.EXE_DEV_REGION;
        }

        const result = Bun.spawnSync(["bash", launcher, "--dry-run"], {
          env: environment,
          stderr: "pipe",
          stdout: "pipe",
        });

        expect(result.exitCode).not.toBe(0);
        expect(result.stderr.toString()).toContain("set EXE_DEV_REGION=FRA");
        expect(() => readFileSync(fixture.argumentsFile)).toThrow();
      } finally {
        rmSync(fixture.workspace, { force: true, recursive: true });
      }
    }
  });

  test("accepts SHA-256 object ids and exports their complete value", () => {
    const sha256ObjectId = "b".repeat(64);
    const fixture = createLauncherFixture(sha256ObjectId);
    try {
      const result = Bun.spawnSync(["bash", launcher, "--dry-run"], {
        env: launcherEnvironment(fixture),
        stderr: "pipe",
        stdout: "pipe",
      });

      expect(result.exitCode).toBe(0);
      expect(readFileSync(fixture.environmentFile, "utf-8")).toContain(
        `${sha256ObjectId}\nclean\n`
      );
    } finally {
      rmSync(fixture.workspace, { force: true, recursive: true });
    }
  });

  test("rejects a dirty workspace before invoking Crabbox", () => {
    const fixture = createLauncherFixture(sourceSha, 0, " M source.ts\n");
    try {
      const result = Bun.spawnSync(["bash", launcher, "--dry-run"], {
        env: launcherEnvironment(fixture),
        stderr: "pipe",
        stdout: "pipe",
      });

      expect(result.exitCode).not.toBe(0);
      expect(result.stderr.toString()).toContain(
        "source workspace must be clean before materialization"
      );
      expect(() => readFileSync(fixture.argumentsFile)).toThrow();
    } finally {
      rmSync(fixture.workspace, { force: true, recursive: true });
    }
  });

  test("rejects an unpinned Crabbox client before materialization", () => {
    const fixture = createLauncherFixture();
    try {
      const result = Bun.spawnSync(["bash", launcher, "--dry-run"], {
        env: {
          ...launcherEnvironment(fixture),
          CRABBOX_VERSION_OUTPUT: "0.47.0",
        },
        stderr: "pipe",
        stdout: "pipe",
      });

      expect(result.exitCode).not.toBe(0);
      expect(result.stderr.toString()).toContain(
        "expected Crabbox 0.62.0, found 0.47.0"
      );
      expect(() => readFileSync(fixture.argumentsFile)).toThrow();
    } finally {
      rmSync(fixture.workspace, { force: true, recursive: true });
    }
  });

  test("rejects a Crabbox binary without matching release provenance", () => {
    const fixture = createLauncherFixture();
    try {
      writeFileSync(
        fixture.provenanceFile,
        `archive_sha256=${"0".repeat(64)}\nbinary_sha256=${"0".repeat(64)}\n`
      );
      const result = Bun.spawnSync(["bash", launcher, "--dry-run"], {
        env: launcherEnvironment(fixture),
        stderr: "pipe",
        stdout: "pipe",
      });

      expect(result.exitCode).not.toBe(0);
      expect(result.stderr.toString()).toContain(
        "provenance archive digest does not match"
      );
      expect(() => readFileSync(fixture.argumentsFile)).toThrow();
    } finally {
      rmSync(fixture.workspace, { force: true, recursive: true });
    }
  });

  test(
    "replaces prior attempt evidence with the materialized result",
    () => {
      const fixture = createLauncherFixture();
      const evidenceDirectory = path.join(
        fixture.workspace,
        ".artifacts/crabbox/exe-dev-shadow"
      );
      try {
        mkdirSync(evidenceDirectory, { recursive: true });
        writeFileSync(path.join(evidenceDirectory, "stale-junit.xml"), "stale");

        const result = Bun.spawnSync(["bash", launcher, "--dry-run"], {
          env: {
            ...launcherEnvironment(fixture),
            MATERIALIZED_EVIDENCE_FIXTURE: "1",
          },
          stderr: "pipe",
          stdout: "pipe",
        });

        expect(result.exitCode).toBe(0);
        expect(() =>
          readFileSync(path.join(evidenceDirectory, "stale-junit.xml"))
        ).toThrow();
        expect(
          readFileSync(path.join(evidenceDirectory, "report.md"), "utf-8")
        ).toBe("fresh\n");
      } finally {
        rmSync(fixture.workspace, { force: true, recursive: true });
      }
    },
    launcherFixtureTimeoutMs
  );

  test(
    "clears prior evidence when the new attempt has no artifacts",
    () => {
      const fixture = createLauncherFixture();
      const evidenceDirectory = path.join(
        fixture.workspace,
        ".artifacts/crabbox/exe-dev-shadow"
      );
      try {
        mkdirSync(evidenceDirectory, { recursive: true });
        writeFileSync(path.join(evidenceDirectory, "stale-junit.xml"), "stale");

        const result = Bun.spawnSync(["bash", launcher, "--dry-run"], {
          env: launcherEnvironment(fixture),
          stderr: "pipe",
          stdout: "pipe",
        });

        expect(result.exitCode).toBe(0);
        expect(existsSync(evidenceDirectory)).toBe(false);
      } finally {
        rmSync(fixture.workspace, { force: true, recursive: true });
      }
    },
    launcherFixtureTimeoutMs
  );

  test("returns the downloaded validation status after artifact transport", () => {
    const fixture = createLauncherFixture();
    try {
      const result = Bun.spawnSync(["bash", launcher], {
        env: {
          ...launcherEnvironment(fixture),
          MATERIALIZED_VALIDATION_STATUS_FIXTURE: "23",
        },
        stderr: "pipe",
        stdout: "pipe",
      });

      expect(result.exitCode).toBe(23);
      expect(
        readFileSync(
          path.join(
            fixture.workspace,
            ".artifacts/crabbox/exe-dev-shadow/validation-exit-status.txt"
          ),
          "utf-8"
        )
      ).toBe("23\n");
    } finally {
      rmSync(fixture.workspace, { force: true, recursive: true });
    }
  });

  test("fails closed when Git status cannot determine source state", () => {
    const fixture = createLauncherFixture(sourceSha, 70);
    try {
      const result = Bun.spawnSync(["bash", launcher, "--dry-run"], {
        env: {
          ...process.env,
          CAPTURE_ARGUMENTS: fixture.argumentsFile,
          CAPTURE_ENVIRONMENT: fixture.environmentFile,
          CRABBOX_EXE_DEV_CONTROL_HOST: "exe.dev",
          EXE_DEV_REGION: "FRA",
          PATH: `${fixture.binDirectory}:${process.env.PATH ?? "/usr/bin:/bin"}`,
        },
        stderr: "pipe",
        stdout: "pipe",
      });

      expect(result.exitCode).not.toBe(0);
      expect(result.stderr.toString()).toContain(
        "could not determine the source Git state"
      );
      expect(() => readFileSync(fixture.argumentsFile)).toThrow();
    } finally {
      rmSync(fixture.workspace, { force: true, recursive: true });
    }
  });

  test("preserves intermediate shell-function failures in a phase", () => {
    const workspace = mkdtempSync(path.join(tmpdir(), "ji-shadow-phase-"));
    try {
      const result = Bun.spawnSync(
        [
          "bash",
          "-c",
          `source "$SHADOW_SCRIPT"
mkdir -p "$EVIDENCE_DIR"
: >"$PHASES_FILE"
monotonic_ms() { printf '1000\\n'; }
iso_timestamp() { printf '2026-08-29T00:00:00Z\\n'; }
failing_phase() {
  (exit 23)
  printf 'masked\\n' >continued-after-failure
}
set +e
run_phase "failure-test" "failing_phase" failing_phase
status=$?
set -e
[[ $status -eq 23 ]]
[[ ! -e continued-after-failure ]]
grep -q '"exitStatus":23' "$PHASES_FILE"
`,
        ],
        {
          cwd: workspace,
          env: { ...process.env, SHADOW_SCRIPT: shadowScript },
          stderr: "pipe",
          stdout: "pipe",
        }
      );

      expect(result.stderr.toString()).toBe("");
      expect(result.exitCode).toBe(0);
    } finally {
      rmSync(workspace, { force: true, recursive: true });
    }
  });

  test("isolates database requirements in the unit phase", () => {
    const workspace = mkdtempSync(path.join(tmpdir(), "ji-shadow-unit-"));
    const binDirectory = path.join(workspace, "bin");
    const captureFile = path.join(workspace, "unit-environment");
    mkdirSync(binDirectory);
    createExecutable(
      path.join(binDirectory, "bun"),
      `#!/usr/bin/env bash
set -euo pipefail
[[ "\${1:-}" == "test" ]] || exit 0
printf '%s\\n' "\${DATABASE_URL-unset}" "\${DATABASE_TEST_URL-unset}" "\${DATABASE_APP_TEST_URL-unset}" "\${MIGRATION_DATABASE_URL-unset}" "\${REQUIRE_DATABASE_TESTS-unset}" >"$CAPTURE_FILE"
`
    );

    try {
      const result = Bun.spawnSync(
        ["bash", "-c", 'source "$SHADOW_SCRIPT"; run_unit_suite'],
        {
          cwd: workspace,
          env: {
            ...process.env,
            CAPTURE_FILE: captureFile,
            DATABASE_APP_TEST_URL: "inherited",
            DATABASE_TEST_URL: "inherited",
            DATABASE_URL: "inherited",
            MIGRATION_DATABASE_URL: "inherited",
            PATH: `${binDirectory}:${process.env.PATH ?? "/usr/bin:/bin"}`,
            REQUIRE_DATABASE_TESTS: "1",
            SHADOW_SCRIPT: shadowScript,
          },
          stderr: "pipe",
          stdout: "pipe",
        }
      );

      expect(result.stderr.toString()).toBe("");
      expect(result.exitCode).toBe(0);
      expect(readFileSync(captureFile, "utf-8")).toBe(
        "postgresql://127.0.0.1:1/unused\nunset\nunset\nunset\nunset\n"
      );
    } finally {
      rmSync(workspace, { force: true, recursive: true });
    }
  });

  test("preserves required diagnostics when the unit phase fails", () => {
    const workspace = mkdtempSync(
      path.join(tmpdir(), "ji-shadow-unit-failure-")
    );
    const binDirectory = path.join(workspace, "bin");
    const evidenceDirectory = path.join(workspace, remoteEvidencePath);
    mkdirSync(binDirectory);
    writeFileSync(path.join(workspace, "bun.lock"), "lockfile");
    const inputManifestPath = writeInputManifest(workspace, ["bun.lock"]);
    const inputManifestDigest = new Bun.CryptoHasher("sha256")
      .update(readFileSync(inputManifestPath))
      .digest("hex");
    createExecutable(
      path.join(binDirectory, "bun"),
      `#!/usr/bin/env bash
set -euo pipefail
if [[ "\${1:-}" == "--version" ]]; then
  printf '1.3.14\\n'
  exit 0
fi
if [[ "\${1:-}" == "test" ]]; then
  for argument in "$@"; do
    if [[ "$argument" == --reporter-outfile=* ]]; then
      output="\${argument#--reporter-outfile=}"
      mkdir -p "$(dirname "$output")"
      printf '<testsuites tests="1" failures="1"><testsuite tests="1" failures="1"><testcase name="remote failure"><failure message="fixture" /></testcase></testsuite></testsuites>\\n' >"$output"
    fi
  done
  printf '%s\\n' 'error: loader fixture failed' 'error: https://user:private@example.invalid/path?token=private' '2 errors'
  exit 4
fi
if [[ "\${1:-}" == "scripts/crabbox-unit-diagnostics.ts" ]]; then
  shift
  exec "$REAL_BUN" "$UNIT_DIAGNOSTICS_SCRIPT" "$@"
fi
exit 0
`
    );

    try {
      const spawnedEnvironment = {
        ...process.env,
        CRABBOX_CLIENT_VERSION: "0.62.0",
        CRABBOX_SOURCE_GIT_SHA: sourceSha,
        CRABBOX_SOURCE_GIT_STATE: "clean",
        CRABBOX_SOURCE_MANIFEST_FILE_COUNT: "1",
        CRABBOX_SOURCE_MANIFEST_SHA256: `sha256:${inputManifestDigest}`,
        EXE_DEV_REGION: "FRA",
        HOME: workspace,
        PATH: `${binDirectory}:${process.env.PATH ?? "/usr/bin:/bin"}`,
        REAL_BUN: process.execPath,
        SHADOW_SCRIPT: shadowScript,
        UNIT_DIAGNOSTICS_SCRIPT: unitDiagnosticsScript,
      };
      delete spawnedEnvironment.CRABBOX_CAPTURE_VALIDATION_STATUS;
      const result = Bun.spawnSync(
        [
          "bash",
          "-c",
          'source "$SHADOW_SCRIPT"; monotonic_ms() { date +%s000; }; main',
        ],
        {
          cwd: workspace,
          env: spawnedEnvironment,
          stderr: "pipe",
          stdout: "pipe",
        }
      );
      const databaseJunit = readFileSync(
        path.join(evidenceDirectory, "database-junit.xml"),
        "utf-8"
      );
      const manifest = readFileSync(
        path.join(evidenceDirectory, "manifest.sha256"),
        "utf-8"
      );

      expect({
        exitCode: result.exitCode,
        stderr: result.stderr.toString(),
      }).toEqual({ exitCode: 4, stderr: "" });
      expect(
        readFileSync(path.join(evidenceDirectory, "junit.xml"), "utf-8")
      ).toContain('failures="1"');
      expect(databaseJunit).toContain('skipped="1"');
      expect(databaseJunit).toContain('message="phase not reached"');
      expect(
        readFileSync(
          path.join(evidenceDirectory, "validation-exit-status.txt"),
          "utf-8"
        )
      ).toBe("4\n");
      expect(
        readFileSync(path.join(evidenceDirectory, "report.md"), "utf-8")
      ).toContain("- Status: `failed`");
      expect(manifest).toContain("junit.xml");
      expect(manifest).toContain("database-junit.xml");
      expect(manifest).toContain("unit-diagnostics.log");
      expect(manifest).toContain("unit-diagnostics.json");
      expect(manifest).toContain("validation-exit-status.txt");
      const unitDiagnostics = readFileSync(
        path.join(evidenceDirectory, "unit-diagnostics.log"),
        "utf-8"
      );
      const unitDiagnosticSummary = JSON.parse(
        readFileSync(
          path.join(evidenceDirectory, "unit-diagnostics.json"),
          "utf-8"
        )
      );
      expect(unitDiagnostics).toContain("error: loader fixture failed");
      expect(unitDiagnostics).toContain("[REDACTED_URL]");
      expect(unitDiagnostics).not.toContain("user:private");
      expect(unitDiagnosticSummary).toEqual({
        bunErrorLineCount: 2,
        bunReportedErrorCount: 2,
        junitErrorElementCount: 0,
        nonJunitErrorCount: 2,
        schemaVersion: 1,
      });
    } finally {
      rmSync(workspace, { force: true, recursive: true });
    }
  });

  test("counts setup errors that Bun omits from JUnit", async () => {
    const workspace = mkdtempSync(path.join(tmpdir(), "ji-unit-diagnostics-"));
    const inputPath = path.join(workspace, "raw.log");
    const junitPath = path.join(workspace, "junit.xml");
    const logPath = path.join(workspace, "unit-diagnostics.log");
    const summaryPath = path.join(workspace, "unit-diagnostics.json");
    try {
      writeFileSync(
        inputPath,
        "error: loader one\nerror: https://user:pass@example.invalid/?token=private\n2 errors\n"
      );
      writeFileSync(
        junitPath,
        '<testsuites tests="1" failures="0" errors="0"><testcase name="pass" /></testsuites>\n'
      );

      await writeUnitDiagnosticArtifacts(
        inputPath,
        junitPath,
        logPath,
        summaryPath
      );

      expect(readFileSync(logPath, "utf-8")).toBe(
        "error: loader one\nerror: [REDACTED_URL]\n2 errors\n"
      );
      expect(JSON.parse(readFileSync(summaryPath, "utf-8"))).toEqual({
        bunErrorLineCount: 2,
        bunReportedErrorCount: 2,
        junitErrorElementCount: 0,
        nonJunitErrorCount: 2,
        schemaVersion: 1,
      });
      expect(
        summarizeUnitDiagnostics("error: represented\n1 error\n", "<error />")
      ).toEqual({
        bunErrorLineCount: 1,
        bunReportedErrorCount: 1,
        junitErrorElementCount: 1,
        nonJunitErrorCount: 0,
        schemaVersion: 1,
      });
    } finally {
      rmSync(workspace, { force: true, recursive: true });
    }
  });

  test("requires the durable user-write Postgres contract in the database phase", () => {
    const script = readFileSync(shadowScript, "utf-8");

    expect(script).toContain("packages/db/src/core.spec.ts");
    expect(script).toContain("packages/db/src/user-write-stores.spec.ts");
    expect(script).toContain("REQUIRE_DATABASE_TESTS=1");
    expect(script).toContain("--max-concurrency 1");
    expect(script).toContain(
      'run_phase "database-integration" "REQUIRE_DATABASE_TESTS=1 bun test packages/db/src/core.spec.ts packages/db/src/user-write-stores.spec.ts --reporter=junit"'
    );
  });

  test("runs and retains the two-instance MCP edge smoke evidence", () => {
    const script = readFileSync(shadowScript, "utf-8");
    const evidenceDirectoryVariable = `${String.fromCodePoint(36)}{EVIDENCE_DIR}`;

    expect(script).toContain(
      'run_phase "mcp-edge" "bun run docker:mcp-edge-smoke" run_mcp_edge_smoke'
    );
    expect(script).toContain("capture_mcp_edge_evidence");
    expect(script).toContain(
      `MCP_EDGE_EVIDENCE_DIR="${evidenceDirectoryVariable}/mcp-edge-smoke"`
    );
    expect(script).toContain('find "$MCP_EDGE_EVIDENCE_DIR" -type f -print0');
  });

  test(
    "forwards SIGTERM to the running Crabbox child and exits with the signal status",
    async () => {
      const fixture = createLauncherFixture();
      const pidFile = path.join(fixture.workspace, "crabbox.pid");
      try {
        const launcherProcess = Bun.spawn(["bash", launcher, "--dry-run"], {
          env: {
            ...launcherEnvironment(fixture),
            CRABBOX_FIXTURE_HOLD_PID: pidFile,
          },
          stderr: "pipe",
          stdout: "pipe",
        });

        await waitForFile(pidFile, 10_000);
        const crabboxPid = Number(readFileSync(pidFile, "utf-8").trim());
        expect(Number.isInteger(crabboxPid)).toBe(true);

        launcherProcess.kill("SIGTERM");
        const exitCode = await launcherProcess.exited;

        expect(exitCode).toBe(143);
        expect(() => process.kill(crabboxPid, 0)).toThrow();
        expect(
          existsSync(
            path.join(fixture.workspace, ".artifacts/crabbox/exe-dev-shadow")
          )
        ).toBe(false);
      } finally {
        rmSync(fixture.workspace, { force: true, recursive: true });
      }
    },
    launcherFixtureTimeoutMs
  );

  test(
    "stops before launching Crabbox when a signal arrives during preflight",
    async () => {
      const fixture = createLauncherFixture();
      const pidFile = path.join(fixture.workspace, "preflight.pid");
      try {
        const launcherProcess = Bun.spawn(["bash", launcher, "--dry-run"], {
          env: {
            ...launcherEnvironment(fixture),
            CRABBOX_FIXTURE_PREFLIGHT_HOLD_PID: pidFile,
          },
          stderr: "pipe",
          stdout: "pipe",
        });

        await waitForFile(pidFile, 10_000);
        launcherProcess.kill("SIGTERM");
        const exitCode = await launcherProcess.exited;

        expect(exitCode).toBe(143);
        expect(existsSync(fixture.argumentsFile)).toBe(false);
        expect(
          existsSync(
            path.join(fixture.workspace, ".artifacts/crabbox/exe-dev-shadow")
          )
        ).toBe(false);
      } finally {
        rmSync(fixture.workspace, { force: true, recursive: true });
      }
    },
    launcherFixtureTimeoutMs
  );

  test("accepts both Git object formats in remote fingerprints", () => {
    const result = Bun.spawnSync(
      [
        "bash",
        "-c",
        'source "$SHADOW_SCRIPT"; is_valid_git_oid "$(printf a%.0s {1..40})"; is_valid_git_oid "$(printf b%.0s {1..64})"; ! is_valid_git_oid "$(printf c%.0s {1..63})"',
      ],
      {
        env: { ...process.env, SHADOW_SCRIPT: shadowScript },
        stderr: "pipe",
        stdout: "pipe",
      }
    );

    expect(result.stderr.toString()).toBe("");
    expect(result.exitCode).toBe(0);
  });

  test("records the effective Crabbox profile", () => {
    const result = Bun.spawnSync(
      ["bash", "-c", 'source "$SHADOW_SCRIPT"; printf "%s\\n" "$PROFILE"'],
      {
        env: { ...process.env, SHADOW_SCRIPT: shadowScript },
        stderr: "pipe",
        stdout: "pipe",
      }
    );

    expect(result.stderr.toString()).toBe("");
    expect(result.exitCode).toBe(0);
    expect(result.stdout.toString()).toBe("exe-dev-shadow\n");
  });

  test("records the configured machine class and observed CPU model", () => {
    const workspace = mkdtempSync(path.join(tmpdir(), "ji-shadow-machine-"));
    const evidenceDirectory = path.join(workspace, remoteEvidencePath);
    mkdirSync(evidenceDirectory, { recursive: true });
    writeFileSync(path.join(workspace, "bun.lock"), "lockfile");
    writeInputManifest(workspace, ["bun.lock"]);

    try {
      const result = Bun.spawnSync(
        ["bash", "-c", 'source "$SHADOW_SCRIPT"; write_fingerprint'],
        {
          cwd: workspace,
          env: {
            ...process.env,
            CRABBOX_CLIENT_VERSION: "0.62.0",
            CRABBOX_SOURCE_MANIFEST_FILE_COUNT: "1",
            CRABBOX_SOURCE_MANIFEST_SHA256: `sha256:${"c".repeat(64)}`,
            CRABBOX_SOURCE_MATERIALIZATION_DURATION_MS: "12",
            CRABBOX_SOURCE_PREFLIGHT_DURATION_MS: "34",
            SHADOW_SCRIPT: shadowScript,
          },
          stderr: "pipe",
          stdout: "pipe",
        }
      );
      const fingerprint = JSON.parse(
        readFileSync(
          path.join(evidenceDirectory, "execution-fingerprint.json"),
          "utf-8"
        )
      );

      expect(result.stderr.toString()).toBe("");
      expect(result.exitCode).toBe(0);
      expect(fingerprint.machine).toBe("2cpu-8gb-40gb");
      expect(fingerprint.crabboxClientVersion).toBe("0.62.0");
      expect(fingerprint.cpuModel.length).toBeGreaterThan(0);
      expect(fingerprint.nodeImage).toBe(nodeImage);
      expect(fingerprint.sourceManifestFileCount).toBe(1);
      expect(fingerprint.sourceMaterializationDurationMs).toBe(12);
      expect(fingerprint.sourcePreflightDurationMs).toBe(34);
    } finally {
      rmSync(workspace, { force: true, recursive: true });
    }
  });

  test("includes imported fixtures in the correctness dataset manifest", () => {
    const workspace = mkdtempSync(path.join(tmpdir(), "ji-shadow-dataset-"));
    const fixturesDirectory = path.join(
      workspace,
      "scripts/ci-metrics/fixtures"
    );
    mkdirSync(fixturesDirectory, { recursive: true });
    writeFileSync(
      path.join(workspace, "scripts/ci-metrics/core.spec.ts"),
      "test"
    );
    writeFileSync(path.join(fixturesDirectory, "jobs.json"), "fixture");
    writeFileSync(path.join(workspace, ".crabbox.yaml"), "jobs: {}\n");
    writeInputManifest(workspace, [
      ".crabbox.yaml",
      "scripts/ci-metrics/core.spec.ts",
      "scripts/ci-metrics/fixtures/jobs.json",
    ]);

    try {
      const result = Bun.spawnSync(
        ["bash", "-c", 'source "$SHADOW_SCRIPT"; write_dataset_manifest'],
        {
          cwd: workspace,
          env: { ...process.env, SHADOW_SCRIPT: shadowScript },
          stderr: "pipe",
          stdout: "pipe",
        }
      );

      expect(result.stderr.toString()).toBe("");
      expect(result.exitCode).toBe(0);
      expect(result.stdout.toString()).toContain(
        "scripts/ci-metrics/fixtures/jobs.json"
      );
      expect(result.stdout.toString()).toContain(".crabbox.yaml");
    } finally {
      rmSync(workspace, { force: true, recursive: true });
    }
  });

  test("finalizes report and manifest when the input manifest is missing", () => {
    const workspace = mkdtempSync(path.join(tmpdir(), "ji-shadow-finalize-"));
    const evidenceDirectory = path.join(workspace, remoteEvidencePath);
    mkdirSync(evidenceDirectory, { recursive: true });
    writeFileSync(path.join(workspace, "bun.lock"), "lockfile");

    try {
      const result = Bun.spawnSync(
        [
          "bash",
          "-c",
          'source "$SHADOW_SCRIPT"; : >"$PHASES_FILE"; finalize_evidence',
        ],
        {
          cwd: workspace,
          env: { ...process.env, SHADOW_SCRIPT: shadowScript },
          stderr: "pipe",
          stdout: "pipe",
        }
      );
      const fingerprint = JSON.parse(
        readFileSync(
          path.join(evidenceDirectory, "execution-fingerprint.json"),
          "utf-8"
        )
      );
      const manifest = readFileSync(
        path.join(evidenceDirectory, "manifest.sha256"),
        "utf-8"
      );

      expect(result.stderr.toString()).toBe("");
      expect(result.exitCode).toBe(0);
      expect(fingerprint.datasetFileCount).toBe(0);
      expect(
        readFileSync(path.join(evidenceDirectory, "report.md"), "utf-8")
      ).toContain("# exe.dev shadow evidence");
      expect(manifest).toContain("execution-fingerprint.json");
      expect(manifest).toContain("report.md");
    } finally {
      rmSync(workspace, { force: true, recursive: true });
    }
  });

  test("pins the Node runtime image in Docker and evidence", () => {
    const repositoryRoot = path.join(import.meta.dir, "..");
    const dockerfile = readFileSync(
      path.join(repositoryRoot, "apps/web/Dockerfile"),
      "utf-8"
    );
    const script = readFileSync(shadowScript, "utf-8");

    expect(dockerfile.match(new RegExp(nodeImage, "gu"))?.length).toBe(2);
    expect(script).toContain(`readonly NODE_IMAGE="${nodeImage}"`);
  });
});
