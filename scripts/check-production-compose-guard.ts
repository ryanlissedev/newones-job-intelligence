import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

const repositoryRoot = process.cwd();

const allowedDownVolumePaths = new Set([".github/workflows/ci.yml"]);

const scanRoots = [".github/workflows", "scripts", "tools/postgres"];

const downVolumePattern = /\bdown\b[^\n]*-v\b|\bdown\s+-v\b/u;

const listFiles = (relativeDirectory: string): string[] => {
  const absoluteDirectory = path.join(repositoryRoot, relativeDirectory);
  const entries = readdirSync(absoluteDirectory, {
    recursive: true,
    withFileTypes: true,
  });

  return entries
    .filter((entry) => entry.isFile())
    .map((entry) =>
      path
        .relative(repositoryRoot, path.join(entry.path, entry.name))
        .replaceAll("\\", "/")
    );
};

export const findForbiddenDownVolumeUsage = (): string[] => {
  const violations: string[] = [];

  for (const relativeDirectory of scanRoots) {
    for (const relativePath of listFiles(relativeDirectory)) {
      if (!/\.(?:ya?ml|sh)$/u.test(relativePath)) {
        continue;
      }

      const contents = readFileSync(
        path.join(repositoryRoot, relativePath),
        "utf-8"
      );

      if (!downVolumePattern.test(contents)) {
        continue;
      }

      if (allowedDownVolumePaths.has(relativePath)) {
        continue;
      }

      violations.push(relativePath);
    }
  }

  return violations;
};

export const runProductionComposeGuard = (): void => {
  const violations = findForbiddenDownVolumeUsage();

  if (violations.length > 0) {
    for (const violation of violations) {
      console.error(
        `check-production-compose-guard: '${violation}' references 'docker compose down -v' outside the isolated CI volume job`
      );
    }
    process.exit(1);
  }

  console.log("check-production-compose-guard: passed");
};

if (import.meta.main) {
  runProductionComposeGuard();
}
