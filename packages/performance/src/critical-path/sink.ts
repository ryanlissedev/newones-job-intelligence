import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import type { InProcessPerformanceRecord } from "./session";

export interface CriticalPathRecordSink {
  write: (records: InProcessPerformanceRecord[]) => Promise<void>;
}

const noopCriticalPathSink: CriticalPathRecordSink = {
  write: () => Promise.resolve(),
};

export class FileCriticalPathSink implements CriticalPathRecordSink {
  private readonly outputDirectory: string;

  constructor(outputDirectory: string) {
    this.outputDirectory = outputDirectory;
  }

  async write(records: InProcessPerformanceRecord[]): Promise<void> {
    await mkdir(this.outputDirectory, { recursive: true });
    await Promise.all(
      records.map(async (record) => {
        const stem = `${record.startedAt.replaceAll(/[:.]/gu, "-")}-${record.label}-${record.id}`;
        const destination = path.join(this.outputDirectory, `${stem}.json`);
        await writeFile(destination, `${JSON.stringify(record, null, 2)}\n`);
      })
    );
  }
}

export const resolveCriticalPathSink = (): CriticalPathRecordSink => {
  const outputDirectory = process.env.PERF_METRICS_DIR;
  if (outputDirectory === undefined || outputDirectory.length === 0) {
    return noopCriticalPathSink;
  }
  return new FileCriticalPathSink(outputDirectory);
};

export const isCriticalPathEnabled = (): boolean =>
  process.env.PERF_CRITICAL_PATH === "1" ||
  (process.env.PERF_METRICS_DIR !== undefined &&
    process.env.PERF_METRICS_DIR.length > 0);
