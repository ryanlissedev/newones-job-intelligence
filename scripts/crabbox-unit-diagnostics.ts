import { redactEvidenceText } from "./performance/core";

export interface UnitDiagnosticSummary {
  readonly bunErrorLineCount: number;
  readonly bunReportedErrorCount: number;
  readonly junitErrorElementCount: number;
  readonly nonJunitErrorCount: number;
  readonly schemaVersion: 1;
}

const countMatches = (value: string, pattern: RegExp): number =>
  value.match(pattern)?.length ?? 0;

export const summarizeUnitDiagnostics = (
  diagnostics: string,
  junit: string
): UnitDiagnosticSummary => {
  const bunErrorLineCount = countMatches(diagnostics, /^error:/gmu);
  let bunReportedErrorCount = 0;
  for (const match of diagnostics.matchAll(
    /^\s*(?<count>\d+)\s+errors?\s*$/gmu
  )) {
    const count = Number(match.groups?.count ?? 0);
    bunReportedErrorCount = Math.max(bunReportedErrorCount, count);
  }
  const junitErrorElementCount = countMatches(junit, /<error(?:\s|>)/gu);

  return {
    bunErrorLineCount,
    bunReportedErrorCount,
    junitErrorElementCount,
    nonJunitErrorCount: Math.max(
      0,
      bunReportedErrorCount - junitErrorElementCount
    ),
    schemaVersion: 1,
  };
};

export const writeUnitDiagnosticArtifacts = async (
  inputPath: string,
  junitPath: string,
  logPath: string,
  summaryPath: string
): Promise<void> => {
  const rawDiagnostics = await Bun.file(inputPath).text();
  const junit = await Bun.file(junitPath).text();
  const diagnostics = redactEvidenceText(rawDiagnostics);
  const summary = summarizeUnitDiagnostics(diagnostics, junit);

  await Promise.all([
    Bun.write(logPath, diagnostics),
    Bun.write(summaryPath, `${JSON.stringify(summary, null, 2)}\n`),
  ]);
};

if (import.meta.main) {
  const [inputPath, junitPath, logPath, summaryPath] = process.argv.slice(2);
  if (!(inputPath && junitPath && logPath && summaryPath)) {
    throw new Error(
      "usage: bun scripts/crabbox-unit-diagnostics.ts <input> <junit> <log> <summary>"
    );
  }
  await writeUnitDiagnosticArtifacts(
    inputPath,
    junitPath,
    logPath,
    summaryPath
  );
}
