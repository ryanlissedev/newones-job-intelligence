import { describe, expect, it } from "bun:test";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const resolverSource = path.join(
  import.meta.dir,
  "../tools/quality/resolve-changed.sh"
);

const localRepositoryGitEnvironmentVariables = [
  "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  "GIT_CONFIG",
  "GIT_CONFIG_PARAMETERS",
  "GIT_CONFIG_COUNT",
  "GIT_OBJECT_DIRECTORY",
  "GIT_DIR",
  "GIT_WORK_TREE",
  "GIT_IMPLICIT_WORK_TREE",
  "GIT_GRAFT_FILE",
  "GIT_INDEX_FILE",
  "GIT_NO_REPLACE_OBJECTS",
  "GIT_REPLACE_REF_BASE",
  "GIT_PREFIX",
  "GIT_SHALLOW_FILE",
  "GIT_COMMON_DIR",
] as const;

const hermeticGitEnvironment = (home: string) => {
  const environment = {
    ...process.env,
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_TERMINAL_PROMPT: "0",
    HOME: home,
    LANG: "C",
    LC_ALL: "C",
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    TMPDIR: process.env.TMPDIR ?? tmpdir(),
  };

  for (const variable of localRepositoryGitEnvironmentVariables) {
    environment[variable] = undefined;
  }

  return environment;
};

const run = (
  command: string[],
  cwd: string,
  environment: ReturnType<typeof hermeticGitEnvironment>
): string => {
  const result = Bun.spawnSync({
    cmd: command,
    cwd,
    env: environment,
    stderr: "pipe",
    stdout: "pipe",
  });

  if (result.exitCode !== 0) {
    throw new Error(result.stderr.toString());
  }

  return result.stdout.toString();
};

describe("resolve-changed", () => {
  it("ignores only empty untracked libgit2 scratchfiles", () => {
    const repository = mkdtempSync(path.join(tmpdir(), "ji-resolve-changed-"));
    const sentinelRepository = mkdtempSync(
      path.join(tmpdir(), "ji-resolve-changed-sentinel-")
    );
    const gitDirectory = path.join(repository, ".git");
    const hermeticHome = path.join(repository, "home");
    const sentinelHome = path.join(sentinelRepository, "home");
    const originalGitEnvironment = Object.fromEntries(
      localRepositoryGitEnvironmentVariables.map((variable) => [
        variable,
        process.env[variable],
      ])
    );
    try {
      mkdirSync(hermeticHome);
      mkdirSync(sentinelHome);
      const sentinelEnvironment = hermeticGitEnvironment(sentinelHome);
      run(
        ["git", "init", "--initial-branch=main", "."],
        sentinelRepository,
        sentinelEnvironment
      );
      run(
        ["git", "config", "--local", "resolve-changed.sentinel", "unchanged"],
        sentinelRepository,
        sentinelEnvironment
      );
      const sentinelGitDirectory = path.join(sentinelRepository, ".git");
      const sentinelConfigPath = path.join(sentinelGitDirectory, "config");
      const sentinelConfigBefore = readFileSync(sentinelConfigPath);

      for (const variable of localRepositoryGitEnvironmentVariables) {
        process.env[variable] = "poisoned-by-resolve-changed-test";
      }
      process.env.GIT_DIR = sentinelGitDirectory;
      process.env.GIT_COMMON_DIR = sentinelGitDirectory;
      process.env.GIT_WORK_TREE = sentinelRepository;
      process.env.GIT_INDEX_FILE = path.join(sentinelGitDirectory, "index");

      const environment = hermeticGitEnvironment(hermeticHome);
      const git = (arguments_: string[]): string =>
        run(
          [
            "git",
            `--git-dir=${gitDirectory}`,
            `--work-tree=${repository}`,
            ...arguments_,
          ],
          repository,
          environment
        );
      const resolverTarget = path.join(
        repository,
        "tools/quality/resolve-changed.sh"
      );
      mkdirSync(path.dirname(resolverTarget), { recursive: true });
      copyFileSync(resolverSource, resolverTarget);

      run(
        ["git", "init", "--initial-branch=main", "."],
        repository,
        environment
      );

      const resolvedGitDirectory = realpathSync(
        git(["rev-parse", "--absolute-git-dir"]).trim()
      );
      const resolvedWorkTree = realpathSync(
        git(["rev-parse", "--show-toplevel"]).trim()
      );
      if (
        resolvedGitDirectory !== realpathSync(gitDirectory) ||
        resolvedWorkTree !== realpathSync(repository)
      ) {
        throw new Error("Temporary Git repository binding could not be proven");
      }

      git(["config", "--local", "user.email", "quality-test@example.invalid"]);
      git(["config", "--local", "user.name", "Quality Test"]);

      writeFileSync(path.join(repository, "_git2_tracked"), "baseline\n");
      git(["add", "_git2_tracked"]);
      git(["commit", "-m", "test: add baseline"]);
      git(["update-ref", "refs/remotes/origin/main", "HEAD"]);

      writeFileSync(path.join(repository, "_git2_tracked"), "");
      writeFileSync(path.join(repository, "_git2_empty"), "");
      writeFileSync(path.join(repository, "_git2_nonempty"), "content\n");

      const resolved = run(
        ["bash", "tools/quality/resolve-changed.sh"],
        repository,
        environment
      )
        .trim()
        .split("\n");

      expect(resolved).toContain("_git2_tracked");
      expect(resolved).toContain("_git2_nonempty");
      expect(resolved).not.toContain("_git2_empty");
      expect(existsSync(gitDirectory)).toBe(true);
      expect(readFileSync(sentinelConfigPath)).toEqual(sentinelConfigBefore);
    } finally {
      for (const variable of localRepositoryGitEnvironmentVariables) {
        const originalValue = originalGitEnvironment[variable];
        if (originalValue === undefined) {
          Reflect.deleteProperty(process.env, variable);
        } else {
          process.env[variable] = originalValue;
        }
      }
      rmSync(repository, { force: true, recursive: true });
      rmSync(sentinelRepository, { force: true, recursive: true });
    }
  }, 15_000);
});
