import type { OperatorRunStore } from "../types";
import { randomId } from "./random-id";

export class MemoryOperatorRunStore implements OperatorRunStore {
  private readonly pendingRuns = new Set<string>();

  startRun(bronId: string): Promise<{ readonly runId: string }> {
    this.pendingRuns.add(bronId);
    return Promise.resolve({ runId: `run-${bronId}-${randomId()}` });
  }

  startTestImport(bronId: string): Promise<{ readonly runId: string }> {
    this.pendingRuns.add(bronId);
    return Promise.resolve({ runId: `test-${bronId}-${randomId()}` });
  }
}
