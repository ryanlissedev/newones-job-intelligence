import { describe, expect, it } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  collectSecretViolations,
  createScannedInputManifest,
  scanTrackedFiles,
  verifyScannedInputManifest,
} from "./check-secrets-scan";

const repoRoot = path.join(import.meta.dir, "..");
const repositoryLocalGitVariables = [
  "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  "GIT_COMMON_DIR",
  "GIT_CONFIG",
  "GIT_CONFIG_COUNT",
  "GIT_CONFIG_PARAMETERS",
  "GIT_DIR",
  "GIT_GRAFT_FILE",
  "GIT_IMPLICIT_WORK_TREE",
  "GIT_INDEX_FILE",
  "GIT_NO_REPLACE_OBJECTS",
  "GIT_OBJECT_DIRECTORY",
  "GIT_PREFIX",
  "GIT_REPLACE_REF_BASE",
  "GIT_SHALLOW_FILE",
  "GIT_WORK_TREE",
] as const;

const runRepositoryGit = (workspace: string, arguments_: string[]): number => {
  const environment = { ...process.env };
  for (const variable of repositoryLocalGitVariables) {
    environment[variable] = undefined;
  }

  return Bun.spawnSync(["git", ...arguments_], {
    cwd: workspace,
    env: environment,
  }).exitCode;
};

describe("check-secrets-scan", () => {
  it("catches a clearly fake AWS access key", () => {
    const fake = ["AKIA", "IOSFODNN7EXAMPLE"].join("");
    expect(
      collectSecretViolations("fixture.ts", `const k = "${fake}";`)
    ).toEqual(["fixture.ts looks like an AWS access key"]);
    expect(
      collectSecretViolations("fixture.ts", fake).join("\n")
    ).not.toContain(fake);
  });

  it("catches a private key marker without self-matching the scanner", () => {
    const marker = ["-----BE", "GIN PRIVATE ", "KEY-----"].join("");
    expect(collectSecretViolations("fixture.pem", marker)).toEqual([
      "fixture.pem contains a PEM private key block",
    ]);
    expect(
      collectSecretViolations(
        "scripts/check-secrets-scan.ts",
        readFileSync(
          path.join(import.meta.dir, "check-secrets-scan.ts"),
          "utf-8"
        )
      )
    ).toEqual([]);
  });

  it("catches scrubbed infrastructure identifiers", () => {
    const cases: readonly { fragments: string[]; label: string }[] = [
      { fragments: ["23.88", ".60.222"], label: "Hetzner production IP" },
      { fragments: ["23-88", "-60-222"], label: "Hetzner sslip hostname" },
      {
        fragments: ["proj_", "xgtjezribvfwcmqktcli"],
        label: "Trigger.dev project ref",
      },
      { fragments: ["164", "361997"], label: "Hetzner server id" },
      { fragments: ["11", "557985"], label: "Hetzner firewall id" },
      {
        fragments: ["ubuntu-8gb-", "nbg1-1"],
        label: "Hetzner server name",
      },
      { fragments: ["catapulze.exe", ".xyz"], label: "exe.dev test host" },
      {
        fragments: ["Catapulze", " Development"],
        label: "1Password vault name",
      },
      { fragments: ["ep-holy", "-dream"], label: "Neon endpoint id" },
      { fragments: ["ryanlisse", ".com"], label: "owner email domain" },
      { fragments: ["ryan.lisse@", "blinqx"], label: "local path owner" },
    ];

    for (const { fragments, label } of cases) {
      const candidate = fragments.join("");
      expect(collectSecretViolations("fixture.md", candidate)).toEqual([
        `fixture.md contains a scrubbed identifier: ${label}`,
      ]);
      expect(
        collectSecretViolations("fixture.md", candidate).join("\n")
      ).not.toContain(candidate);
    }
  });

  it("accepts the scrub placeholders", () => {
    expect(
      collectSecretViolations(
        "fixture.md",
        "<hetzner-ip> api.203-0-113-10.sslip.io .203-0-113-10.sslip.io"
      )
    ).toEqual([]);
  });

  it("does not treat .env.example placeholders as secrets", () => {
    const serverExample = readFileSync(
      path.join(repoRoot, "apps/server/.env.example"),
      "utf-8"
    );
    const webExample = readFileSync(
      path.join(repoRoot, "apps/web/.env.example"),
      "utf-8"
    );
    expect(
      collectSecretViolations("apps/server/.env.example", serverExample)
    ).toEqual([]);
    expect(
      collectSecretViolations("apps/web/.env.example", webExample)
    ).toEqual([]);
    expect(serverExample).toMatch(/^DATABASE_URL=/mu);
    expect(serverExample).not.toMatch(/AKIA[0-9A-Z]{16}/u);
    expect(webExample).toMatch(/^NEXT_PUBLIC_SERVER_URL=/mu);
  });

  it("scans synchronized files when Git metadata is absent", async () => {
    const workspace = mkdtempSync(path.join(tmpdir(), "ji-secret-scan-"));
    const fake = ["AKIA", "IOSFODNN7EXAMPLE"].join("");

    try {
      mkdirSync(path.join(workspace, "src"));
      writeFileSync(
        path.join(workspace, "src/config.ts"),
        `export const key = "${fake}";`
      );

      expect(await scanTrackedFiles(workspace)).toEqual([
        "src/config.ts looks like an AWS access key",
      ]);
    } finally {
      rmSync(workspace, { force: true, recursive: true });
    }
  });

  it("sorts Git-absent workspace findings deterministically", async () => {
    const workspace = mkdtempSync(path.join(tmpdir(), "ji-secret-sort-"));
    const fake = ["AKIA", "IOSFODNN7EXAMPLE"].join("");

    try {
      writeFileSync(path.join(workspace, "z.ts"), fake);
      writeFileSync(path.join(workspace, "a.ts"), fake);

      expect(await scanTrackedFiles(workspace)).toEqual([
        "a.ts looks like an AWS access key",
        "z.ts looks like an AWS access key",
      ]);
    } finally {
      rmSync(workspace, { force: true, recursive: true });
    }
  });

  it("scans tests instead of exempting them from upload preflight", async () => {
    const workspace = mkdtempSync(path.join(tmpdir(), "ji-secret-tests-"));
    const fake = ["AKIA", "IOSFODNN7EXAMPLE"].join("");

    try {
      writeFileSync(path.join(workspace, "upload.spec.ts"), fake);
      expect(await scanTrackedFiles(workspace)).toEqual([
        "upload.spec.ts looks like an AWS access key",
      ]);
    } finally {
      rmSync(workspace, { force: true, recursive: true });
    }
  });

  it("scans synchronized untracked files when Git metadata is present", async () => {
    const workspace = mkdtempSync(
      path.join(tmpdir(), "ji-secret-scan-seeded-")
    );
    const fake = ["AKIA", "IOSFODNN7EXAMPLE"].join("");

    try {
      expect(runRepositoryGit(workspace, ["init", "--quiet"])).toBe(0);
      writeFileSync(
        path.join(workspace, "tracked.ts"),
        "export const safe = true;"
      );
      expect(runRepositoryGit(workspace, ["add", "tracked.ts"])).toBe(0);
      writeFileSync(path.join(workspace, "untracked.ts"), fake);

      expect(await scanTrackedFiles(workspace)).toEqual([
        "untracked.ts looks like an AWS access key",
      ]);
    } finally {
      rmSync(workspace, { force: true, recursive: true });
    }
  });

  it("scans tracked dotenv-like names containing newlines", async () => {
    const workspace = mkdtempSync(
      path.join(tmpdir(), "ji-secret-scan-newline-")
    );
    const fake = ["AKIA", "IOSFODNN7EXAMPLE"].join("");
    const trackedPath = ".env.local\nfixture";

    try {
      expect(runRepositoryGit(workspace, ["init", "--quiet"])).toBe(0);
      writeFileSync(path.join(workspace, trackedPath), fake);
      expect(runRepositoryGit(workspace, ["add", "--", trackedPath])).toBe(0);

      expect(await scanTrackedFiles(workspace)).toEqual([
        `${trackedPath} looks like an AWS access key`,
      ]);
    } finally {
      rmSync(workspace, { force: true, recursive: true });
    }
  });

  it("scans tracked files beneath generated directory names", async () => {
    const workspace = mkdtempSync(
      path.join(tmpdir(), "ji-secret-scan-tracked-generated-")
    );
    const fake = ["AKIA", "IOSFODNN7EXAMPLE"].join("");
    const trackedPath = "packages/example/build/config.ts";

    try {
      expect(runRepositoryGit(workspace, ["init", "--quiet"])).toBe(0);
      mkdirSync(path.join(workspace, "packages/example/build"), {
        recursive: true,
      });
      writeFileSync(path.join(workspace, trackedPath), fake);
      expect(
        runRepositoryGit(workspace, ["add", "--force", "--", trackedPath])
      ).toBe(0);

      expect(await scanTrackedFiles(workspace)).toEqual([
        `${trackedPath} looks like an AWS access key`,
      ]);
    } finally {
      rmSync(workspace, { force: true, recursive: true });
    }
  });

  it("excludes local dotenv files while retaining example templates", async () => {
    const workspace = mkdtempSync(path.join(tmpdir(), "ji-secret-scan-env-"));
    const fake = ["AKIA", "IOSFODNN7EXAMPLE"].join("");

    try {
      mkdirSync(path.join(workspace, "apps/server"), { recursive: true });
      writeFileSync(path.join(workspace, "apps/server/.env"), fake);
      writeFileSync(path.join(workspace, "apps/server/.env.local"), fake);
      writeFileSync(path.join(workspace, "apps/server/.env.example"), fake);

      expect(await scanTrackedFiles(workspace)).toEqual([
        "apps/server/.env.example looks like an AWS access key",
      ]);
    } finally {
      rmSync(workspace, { force: true, recursive: true });
    }
  });

  it("scans files sequentially and fails closed on oversized input", async () => {
    const workspace = mkdtempSync(path.join(tmpdir(), "ji-secret-scan-size-"));

    try {
      writeFileSync(path.join(workspace, "large.txt"), "12345");
      expect(await scanTrackedFiles(workspace, 4)).toEqual([
        "large.txt exceeds the 4-byte secret-scan limit",
      ]);
    } finally {
      rmSync(workspace, { force: true, recursive: true });
    }
  });

  it("skips generated caches while retaining synchronized config and source", async () => {
    const workspace = mkdtempSync(path.join(tmpdir(), "ji-secret-scan-cache-"));
    const generatedDirectories = [
      ".alchemy",
      ".artifacts",
      ".cache",
      ".crabbox",
      ".evlog",
      ".next",
      ".nx",
      ".nyc_output",
      ".omc",
      ".openwiki",
      ".qlty/configs",
      ".qlty/logs",
      ".qlty/out",
      ".qlty/plugin_cachedir",
      ".qlty/results",
      ".qlty/sources",
      ".turbo",
      ".vercel",
      "build",
      "coverage",
      "crabbox-output",
      "dist",
      "logs",
      "node_modules",
      "openwiki",
      "temp",
      "tmp",
      "docs/research/bench/rs/target",
    ];
    const generatedFiles = [
      "docs/research/bench/gf_go",
      "docs/research/bench/gofetch/gofetch",
      "docs/research/bench/mh_go",
    ];
    const fake = ["AKIA", "IOSFODNN7EXAMPLE"].join("");

    try {
      for (const directory of generatedDirectories) {
        mkdirSync(path.join(workspace, directory), { recursive: true });
        writeFileSync(path.join(workspace, directory, "generated.txt"), fake);
      }
      for (const file of generatedFiles) {
        mkdirSync(path.dirname(path.join(workspace, file)), {
          recursive: true,
        });
        writeFileSync(path.join(workspace, file), fake);
      }
      mkdirSync(path.join(workspace, ".qlty"), { recursive: true });
      mkdirSync(path.join(workspace, "src"), { recursive: true });
      writeFileSync(path.join(workspace, ".qlty/qlty.toml"), fake);
      writeFileSync(path.join(workspace, "src/config.ts"), fake);

      expect(await scanTrackedFiles(workspace)).toEqual([
        ".qlty/qlty.toml looks like an AWS access key",
        "src/config.ts looks like an AWS access key",
      ]);
    } finally {
      rmSync(workspace, { force: true, recursive: true });
    }
  });

  it("ignores inherited repository-local Git bindings", async () => {
    const workspace = mkdtempSync(path.join(tmpdir(), "ji-secret-scan-git-"));
    const fake = ["AKIA", "IOSFODNN7EXAMPLE"].join("");

    try {
      writeFileSync(path.join(workspace, "config.ts"), fake);
      expect(
        await scanTrackedFiles(workspace, undefined, {
          ...process.env,
          GIT_COMMON_DIR: "/invalid/common",
          GIT_DIR: "/invalid/git-dir",
          GIT_INDEX_FILE: "/invalid/index",
          GIT_WORK_TREE: "/invalid/work-tree",
        })
      ).toEqual(["config.ts looks like an AWS access key"]);
    } finally {
      rmSync(workspace, { force: true, recursive: true });
    }
  });

  it("builds one canonical manifest across config, schema, and tests", async () => {
    const workspace = mkdtempSync(path.join(tmpdir(), "ji-input-manifest-"));

    try {
      mkdirSync(path.join(workspace, "scripts/performance"), {
        recursive: true,
      });
      writeFileSync(path.join(workspace, ".crabbox.yaml"), "jobs: {}\n");
      writeFileSync(
        path.join(
          workspace,
          "scripts/performance/performance-record.schema.json"
        ),
        "{}\n"
      );
      writeFileSync(path.join(workspace, "scripts/shadow.spec.ts"), "test\n");

      const scanned = await createScannedInputManifest(workspace);

      expect(scanned.violations).toEqual([]);
      expect(scanned.paths).toEqual([
        ".crabbox.yaml",
        "scripts/performance/performance-record.schema.json",
        "scripts/shadow.spec.ts",
      ]);
      expect(scanned.manifest).toContain('  ".crabbox.yaml"\n');
      expect(scanned.manifest).toContain(
        '  "scripts/performance/performance-record.schema.json"\n'
      );
      expect(scanned.manifest).toContain('  "scripts/shadow.spec.ts"\n');
    } finally {
      rmSync(workspace, { force: true, recursive: true });
    }
  });

  it("rejects mutated, missing, and extra materialized inputs", async () => {
    const workspace = mkdtempSync(path.join(tmpdir(), "ji-input-verify-"));

    try {
      writeFileSync(path.join(workspace, "input.ts"), "original\n");
      const { manifest } = await createScannedInputManifest(workspace);

      expect(await verifyScannedInputManifest(workspace, manifest)).toEqual([]);
      mkdirSync(path.join(workspace, "crabbox-output"));
      writeFileSync(
        path.join(workspace, "crabbox-output/runtime-evidence.txt"),
        "generated\n"
      );
      expect(await verifyScannedInputManifest(workspace, manifest)).toEqual([]);

      writeFileSync(path.join(workspace, "input.ts"), "mutated\n");
      expect(await verifyScannedInputManifest(workspace, manifest)).toEqual([
        "input.ts does not match the materialized input manifest",
      ]);

      rmSync(path.join(workspace, "input.ts"));
      expect(await verifyScannedInputManifest(workspace, manifest)).toEqual([
        "materialized input file set does not match its manifest",
      ]);

      writeFileSync(path.join(workspace, "input.ts"), "original\n");
      writeFileSync(path.join(workspace, "extra.ts"), "extra\n");
      expect(await verifyScannedInputManifest(workspace, manifest)).toEqual([
        "materialized input file set does not match its manifest",
      ]);
    } finally {
      rmSync(workspace, { force: true, recursive: true });
    }
  });

  it("binds symbolic-link targets without following them", async () => {
    const workspace = mkdtempSync(path.join(tmpdir(), "ji-input-symlink-"));
    const linkPath = path.join(workspace, "runtime-link");

    try {
      symlinkSync("target-a", linkPath);
      const { manifest } = await createScannedInputManifest(workspace);

      expect(manifest).toContain('  "runtime-link"\n');
      expect(await verifyScannedInputManifest(workspace, manifest)).toEqual([]);

      rmSync(linkPath);
      symlinkSync("target-b", linkPath);
      expect(await verifyScannedInputManifest(workspace, manifest)).toEqual([
        "runtime-link does not match the materialized input manifest",
      ]);
    } finally {
      rmSync(workspace, { force: true, recursive: true });
    }
  });

  it("encodes newline-containing input paths unambiguously", async () => {
    const workspace = mkdtempSync(path.join(tmpdir(), "ji-input-newline-"));
    const relativePath = "line\nbreak.ts";

    try {
      writeFileSync(path.join(workspace, relativePath), "safe\n");
      const { manifest, violations } =
        await createScannedInputManifest(workspace);

      expect(violations).toEqual([]);
      expect(manifest.split("\n").filter(Boolean)).toHaveLength(1);
      expect(manifest).toContain('  "line\\nbreak.ts"\n');
      expect(await verifyScannedInputManifest(workspace, manifest)).toEqual([]);
    } finally {
      rmSync(workspace, { force: true, recursive: true });
    }
  });

  it("does not follow workspace symlinks during local scans", async () => {
    const workspace = mkdtempSync(path.join(tmpdir(), "ji-scan-symlink-"));
    const scannedRoot = path.join(workspace, "scanned");

    try {
      mkdirSync(scannedRoot);
      writeFileSync(path.join(workspace, "outside-secret"), "x".repeat(65));
      symlinkSync("../outside-secret", path.join(scannedRoot, "outside-link"));

      expect(await scanTrackedFiles(scannedRoot, 64)).toEqual([]);
    } finally {
      rmSync(workspace, { force: true, recursive: true });
    }
  });
});
