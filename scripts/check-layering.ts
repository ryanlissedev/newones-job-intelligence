const IMPORT_SPEC = /(?:from|import)\s+["'](?<specifier>[^"']+)["']/gu;

const FORBIDDEN_PREFIXES = [
  "@ji/application/identity",
  "@ji/application/sources",
  "@ji/db",
  "@ji/infra",
  "drizzle-orm",
  "drizzle-kit",
] as const;

const FORBIDDEN_PATH_FRAGMENTS = [
  "/packages/db",
  "/packages/infra",
  "packages/db/",
  "packages/infra/",
] as const;

export const isForbiddenSpecifier = (specifier: string): boolean => {
  for (const prefix of FORBIDDEN_PREFIXES) {
    if (specifier === prefix || specifier.startsWith(`${prefix}/`)) {
      return true;
    }
  }
  for (const fragment of FORBIDDEN_PATH_FRAGMENTS) {
    if (specifier.includes(fragment)) {
      return true;
    }
  }
  return false;
};

export const collectLayeringViolations = (
  filePath: string,
  source: string
): string[] => {
  const violations: string[] = [];
  for (const match of source.matchAll(IMPORT_SPEC)) {
    const specifier = match.groups?.specifier;
    if (specifier && isForbiddenSpecifier(specifier)) {
      violations.push(`${filePath} imports forbidden module ${specifier}`);
    }
  }
  return violations;
};

const isWebSource = (filePath: string): boolean =>
  filePath.startsWith("apps/web/") &&
  (filePath.endsWith(".ts") || filePath.endsWith(".tsx"));

export const scanWebTree = async (rootDir: string): Promise<string[]> => {
  const glob = new Bun.Glob("apps/web/**/*.{ts,tsx}");
  const violations: string[] = [];
  for await (const relativePath of glob.scan({ cwd: rootDir })) {
    if (!isWebSource(relativePath)) {
      continue;
    }
    const file = Bun.file(`${rootDir}/${relativePath}`);
    const source = await file.text();
    violations.push(...collectLayeringViolations(relativePath, source));
  }
  return violations;
};

if (import.meta.main) {
  const violations = await scanWebTree(process.cwd());
  if (violations.length > 0) {
    for (const line of violations) {
      console.error(line);
    }
    process.exit(1);
  }
}
