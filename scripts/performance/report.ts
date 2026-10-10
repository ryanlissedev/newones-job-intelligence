#!/usr/bin/env bun
import { appendFile } from "node:fs/promises";
import path from "node:path";

import {
  atomicWrite,
  DEFAULT_OUTPUT_DIR,
  readRecords,
  renderAggregateMarkdown,
} from "./core";

const parseOutputDirectory = (args: string[]): string => {
  if (args.length === 0) {
    return process.env.PERF_METRICS_DIR ?? DEFAULT_OUTPUT_DIR;
  }
  if (args.length === 2 && args[0] === "--output-dir" && args[1]) {
    return args[1];
  }
  throw new Error("Usage: report.ts [--output-dir <path>]");
};

if (import.meta.main) {
  try {
    const outputDirectory = parseOutputDirectory(Bun.argv.slice(2));
    let invalidCount = 0;
    const records = await readRecords(outputDirectory, {
      onInvalidRecord: (error) => {
        invalidCount += 1;
        process.stderr.write(
          `performance: skipping invalid record — ${error.message}\n`
        );
      },
    });
    if (invalidCount > 0) {
      process.stderr.write(
        `performance: skipped ${invalidCount} invalid record(s); reporting on ${records.length} valid record(s)\n`
      );
    }
    if (records.length === 0) {
      throw new Error("no valid performance records found (empty result set)");
    }
    const report = renderAggregateMarkdown(records);
    const reportPath = path.join(outputDirectory, "report.md");
    await atomicWrite(reportPath, report);
    process.stdout.write(report);
    const summaryPath = process.env.GITHUB_STEP_SUMMARY;
    if (summaryPath) {
      await appendFile(summaryPath, `\n${report}`);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`performance: ${message}\n`);
    process.exit(2);
  }
}
