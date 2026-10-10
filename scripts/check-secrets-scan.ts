import { createHash } from "node:crypto";
import { lstat, readdir, readlink } from "node:fs/promises";
import path from "node:path";

const AWS_ACCESS_KEY = /AKIA[0-9A-Z]{16}/gu;
const GITHUB_PAT = /ghp_[A-Za-z0-9]{36}/gu;
const OPENAI_LIVE = /sk-live-[A-Za-z0-9]{20,}/gu;
const SENSITIVE_LITERALS: readonly {
  label: string;
  literal: string;
}[] = [
  { label: "Hetzner production IP", literal: ["23.88", ".60.222"].join("") },
  {
    label: "Hetzner sslip hostname",
    literal: ["23-88", "-60-222"].join(""),
  },
  {
    label: "Trigger.dev project ref",
    literal: ["proj_", "xgtjezribvfwcmqktcli"].join(""),
  },
  { label: "Hetzner server id", literal: ["164", "361997"].join("") },
  { label: "Hetzner firewall id", literal: ["11", "557985"].join("") },
  {
    label: "Hetzner server name",
    literal: ["ubuntu-8gb-", "nbg1-1"].join(""),
  },
  {
    label: "exe.dev test host",
    literal: ["catapulze.exe", ".xyz"].join(""),
  },
  {
    label: "1Password vault name",
    literal: ["Catapulze", " Development"].join(""),
  },
  { label: "Neon endpoint id", literal: ["ep-holy", "-dream"].join("") },
  { label: "owner email domain", literal: ["ryanlisse", ".com"].join("") },
  { label: "local path owner", literal: ["ryan.lisse@", "blinqx"].join("") },
];
const MAX_SCAN_FILE_BYTES = 10 * 1024 * 1024;
export const MATERIALIZED_INPUT_MANIFEST = ".crabbox-input-manifest.sha256";
const REPOSITORY_LOCAL_GIT_VARIABLES = [
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
const GENERATED_DIRECTORY_NAMES = new Set([
  ".alchemy",
  ".artifacts",
  ".cache",
  ".crabbox",
  ".evlog",
  ".git",
  ".next",
  ".nx",
  ".nyc_output",
  ".omc",
  ".openwiki",
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
]);
const GENERATED_QLTY_DIRECTORY_NAMES = new Set([
  "configs",
  "logs",
  "out",
  "plugin_cachedir",
  "results",
  "sources",
]);
const GENERATED_REPOSITORY_PATHS = [
  "docs/research/bench/gf_go",
  "docs/research/bench/gofetch/gofetch",
  "docs/research/bench/mh_go",
  "docs/research/bench/rs/target",
] as const;

export const collectSecretViolations = (
  filePath: string,
  source: string
): string[] => {
  const violations: string[] = [];
  if (AWS_ACCESS_KEY.test(source)) {
    violations.push(`${filePath} looks like an AWS access key`);
  }
  AWS_ACCESS_KEY.lastIndex = 0;
  const privateKeyBegin = ["-----BE", "GIN"].join("");
  const privateKeyEnd = ["PRIVATE ", "KEY-----"].join("");
  if (source.includes(privateKeyBegin) && source.includes(privateKeyEnd)) {
    violations.push(`${filePath} contains a PEM private key block`);
  }
  if (GITHUB_PAT.test(source)) {
    violations.push(`${filePath} looks like a GitHub PAT`);
  }
  GITHUB_PAT.lastIndex = 0;
  if (OPENAI_LIVE.test(source)) {
    violations.push(`${filePath} looks like a live OpenAI key`);
  }
  OPENAI_LIVE.lastIndex = 0;
  for (const { label, literal } of SENSITIVE_LITERALS) {
    if (source.includes(literal)) {
      violations.push(`${filePath} contains a scrubbed identifier: ${label}`);
    }
  }
  return violations;
};

const isScannable = (relativePath: string): boolean => {
  const pathSegments = relativePath.split("/");
  const isGeneratedDirectory = pathSegments.some((segment) =>
    GENERATED_DIRECTORY_NAMES.has(segment)
  );
  const isGeneratedQltyDirectory =
    pathSegments[0] === ".qlty" &&
    GENERATED_QLTY_DIRECTORY_NAMES.has(pathSegments[1] ?? "");
  const isGeneratedRepositoryPath = GENERATED_REPOSITORY_PATHS.some(
    (generatedPath) =>
      relativePath === generatedPath ||
      relativePath.startsWith(`${generatedPath}/`)
  );
  return !(
    isGeneratedDirectory ||
    isGeneratedQltyDirectory ||
    isGeneratedRepositoryPath
  );
};

const isMaterializedInput = (relativePath: string): boolean => {
  const [topLevelPath] = relativePath.split("/");
  return !(
    relativePath === MATERIALIZED_INPUT_MANIFEST ||
    topLevelPath === ".artifacts" ||
    topLevelPath === ".crabbox" ||
    topLevelPath === "crabbox-output" ||
    topLevelPath === ".git"
  );
};

const isLocalDotenv = (relativePath: string): boolean => {
  const fileName = path.posix.basename(relativePath);
  return (
    fileName === ".env" ||
    (fileName.startsWith(".env.") && fileName !== ".env.example")
  );
};

const listWorkspaceFiles = async (
  rootDir: string,
  relativeDirectory = "",
  materializedInputsOnly = false
): Promise<string[]> => {
  const directory = path.join(rootDir, relativeDirectory);
  const entries = await readdir(directory, { withFileTypes: true });
  const nestedPaths = await Promise.all(
    entries.map((entry): string[] | Promise<string[]> => {
      const relativePath = path.posix.join(relativeDirectory, entry.name);
      const includesPath = materializedInputsOnly
        ? isMaterializedInput(relativePath)
        : isScannable(relativePath);
      if (!includesPath) {
        return [];
      }
      if (entry.isDirectory()) {
        return listWorkspaceFiles(
          rootDir,
          relativePath,
          materializedInputsOnly
        );
      }
      const includesFile =
        materializedInputsOnly || !isLocalDotenv(relativePath);
      return includesFile ? [relativePath] : [];
    })
  );

  return nestedPaths.flat();
};

interface ScannedInput {
  manifest: string;
  paths: string[];
  violations: string[];
}

const scanInputPaths = async (
  rootDir: string,
  paths: string[],
  maxFileBytes: number
): Promise<ScannedInput> => {
  const manifestLines: string[] = [];
  const violations: string[] = [];
  for (const relativePath of paths) {
    const absolutePath = path.join(rootDir, relativePath);
    // oxlint-disable-next-line eslint/no-await-in-loop -- sequential metadata reads bound scan resource use
    const stats = await lstat(absolutePath);
    if (stats.isSymbolicLink()) {
      // oxlint-disable-next-line eslint/no-await-in-loop -- links are hashed without following them outside the input root
      const linkTarget = await readlink(absolutePath);
      const digest = createHash("sha256")
        .update("symlink\0")
        .update(linkTarget)
        .digest("hex");
      manifestLines.push(`${digest}  ${JSON.stringify(relativePath)}`);
      continue;
    }
    if (!stats.isFile()) {
      violations.push(`${relativePath} is not a regular file or symbolic link`);
      continue;
    }
    if (stats.size > maxFileBytes) {
      violations.push(
        `${relativePath} exceeds the ${maxFileBytes}-byte secret-scan limit`
      );
      continue;
    }
    const file = Bun.file(absolutePath);
    // oxlint-disable-next-line eslint/no-await-in-loop -- one bounded read feeds both hashing and scanning
    const bytes = new Uint8Array(await file.arrayBuffer());
    const digest = createHash("sha256")
      .update("file\0")
      .update(bytes)
      .digest("hex");
    manifestLines.push(`${digest}  ${JSON.stringify(relativePath)}`);
    violations.push(
      ...collectSecretViolations(relativePath, new TextDecoder().decode(bytes))
    );
  }

  return {
    manifest: manifestLines.length > 0 ? `${manifestLines.join("\n")}\n` : "",
    paths,
    violations,
  };
};

const parseInputManifest = (manifest: string): Map<string, string> => {
  const entries = new Map<string, string>();
  for (const line of manifest.split("\n")) {
    if (!line) {
      continue;
    }
    const match = /^(?<digest>[0-9a-f]{64}) {2}(?<encodedPath>.+)$/u.exec(line);
    if (!match?.groups) {
      throw new Error("materialized input manifest contains an invalid line");
    }
    const { digest, encodedPath } = match.groups;
    if (!(encodedPath.startsWith('"') && encodedPath.endsWith('"'))) {
      throw new Error("materialized input manifest contains an invalid path");
    }
    let parsedPath: unknown;
    try {
      parsedPath = JSON.parse(encodedPath);
    } catch {
      throw new Error("materialized input manifest contains an invalid path");
    }
    // oxlint-disable-next-line anti-slop/no-runtime-typeof -- JSON.parse is the I/O boundary; this establishes the manifest's string contract
    if (typeof parsedPath !== "string" || parsedPath.length === 0) {
      throw new Error("materialized input manifest contains an invalid path");
    }
    const relativePath = parsedPath;
    if (entries.has(relativePath)) {
      throw new Error(`materialized input manifest repeats ${relativePath}`);
    }
    entries.set(relativePath, digest);
  }
  return entries;
};

export const createScannedInputManifest = async (
  rootDir: string,
  maxFileBytes = MAX_SCAN_FILE_BYTES
): Promise<ScannedInput> => {
  const workspaceFiles = await listWorkspaceFiles(rootDir, "", true);
  const paths = workspaceFiles.toSorted();
  return scanInputPaths(rootDir, paths, maxFileBytes);
};

export const verifyScannedInputManifest = async (
  rootDir: string,
  manifest: string,
  maxFileBytes = MAX_SCAN_FILE_BYTES
): Promise<string[]> => {
  const expectedEntries = parseInputManifest(manifest);
  const workspaceFiles = await listWorkspaceFiles(rootDir, "", true);
  const actualPaths = workspaceFiles.toSorted();
  const scanned = await scanInputPaths(rootDir, actualPaths, maxFileBytes);
  const actualEntries = parseInputManifest(scanned.manifest);
  const violations = [...scanned.violations];

  const expectedPaths = [...expectedEntries.keys()].toSorted();
  if (expectedPaths.join("\n") !== actualPaths.join("\n")) {
    violations.push("materialized input file set does not match its manifest");
    return violations;
  }
  for (const relativePath of expectedPaths) {
    if (actualEntries.get(relativePath) !== expectedEntries.get(relativePath)) {
      violations.push(
        `${relativePath} does not match the materialized input manifest`
      );
    }
  }
  return violations;
};

const readIfPresent = async (
  rootDir: string,
  relativePath: string,
  maxFileBytes: number
): Promise<{ source: string | null; tooLarge: boolean }> => {
  const absolutePath = path.join(rootDir, relativePath);
  let stats;
  try {
    stats = await lstat(absolutePath);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return { source: null, tooLarge: false };
    }
    throw error;
  }
  if (stats.isSymbolicLink()) {
    const linkTarget = await readlink(absolutePath);
    return {
      source: linkTarget,
      tooLarge: new TextEncoder().encode(linkTarget).byteLength > maxFileBytes,
    };
  }
  if (!stats.isFile()) {
    return { source: null, tooLarge: false };
  }
  const file = Bun.file(absolutePath);
  if (file.size > maxFileBytes) {
    return { source: null, tooLarge: true };
  }
  return { source: await file.text(), tooLarge: false };
};

export const scanTrackedFiles = async (
  rootDir: string,
  maxFileBytes = MAX_SCAN_FILE_BYTES,
  environment: NodeJS.ProcessEnv = process.env
): Promise<string[]> => {
  const gitEnvironment = { ...environment };
  for (const variable of REPOSITORY_LOCAL_GIT_VARIABLES) {
    gitEnvironment[variable] = undefined;
  }
  const proc = Bun.spawn(["git", "ls-files", "-z"], {
    cwd: rootDir,
    env: gitEnvironment,
    stderr: "pipe",
    stdout: "pipe",
  });
  const listed = await new Response(proc.stdout).text();
  const gitExitCode = await proc.exited;
  // Git is authoritative for committed inputs: a tracked file is scanned even
  // when it lives under a directory name that the workspace walk prunes as
  // generated (for example a force-added build/ or logs/ entry).
  const listedPaths = listed
    .split("\0")
    .filter((relativePath) => relativePath.length > 0);
  const workspacePaths = await listWorkspaceFiles(rootDir);
  const paths =
    gitExitCode === 0
      ? [...new Set([...listedPaths, ...workspacePaths])].toSorted()
      : workspacePaths.toSorted();
  const violations: string[] = [];
  for (const relativePath of paths) {
    // oxlint-disable-next-line eslint/no-await-in-loop -- sequential reads bound scan memory
    const { source, tooLarge } = await readIfPresent(
      rootDir,
      relativePath,
      maxFileBytes
    );
    if (tooLarge) {
      violations.push(
        `${relativePath} exceeds the ${maxFileBytes}-byte secret-scan limit`
      );
      continue;
    }
    if (source === null) {
      continue;
    }
    violations.push(...collectSecretViolations(relativePath, source));
  }
  return violations;
};

if (import.meta.main) {
  const arguments_ = process.argv.slice(2);
  const rootArgumentIndex = arguments_.indexOf("--root");
  const writeManifestIndex = arguments_.indexOf("--write-manifest");
  const verifyManifestIndex = arguments_.indexOf("--verify-manifest");
  const shouldUseRootArgument = arguments_.includes("--root");
  const shouldWriteManifest = arguments_.includes("--write-manifest");
  const shouldVerifyManifest = arguments_.includes("--verify-manifest");
  let rootDir = process.cwd();
  if (shouldUseRootArgument) {
    rootDir = arguments_[rootArgumentIndex + 1] ?? "";
  }
  if (!rootDir) {
    throw new Error("--root requires a directory");
  }

  let violations: string[];
  if (shouldWriteManifest) {
    const manifestPath = arguments_[writeManifestIndex + 1];
    if (!manifestPath) {
      throw new Error("--write-manifest requires a path");
    }
    const scanned = await createScannedInputManifest(rootDir);
    ({ violations } = scanned);
    if (violations.length === 0) {
      await Bun.write(manifestPath, scanned.manifest);
    }
  } else if (shouldVerifyManifest) {
    const manifestPath = arguments_[verifyManifestIndex + 1];
    if (!manifestPath) {
      throw new Error("--verify-manifest requires a path");
    }
    violations = await verifyScannedInputManifest(
      rootDir,
      await Bun.file(manifestPath).text()
    );
  } else {
    violations = await scanTrackedFiles(rootDir);
  }
  if (violations.length > 0) {
    for (const line of violations) {
      console.error(line);
    }
    process.exit(1);
  }
}
