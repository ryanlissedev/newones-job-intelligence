import type { NeonV1JobRow, NeonV1Source } from "./neon-v1-types";

export class UnreachableNeonV1Source implements NeonV1Source {
  readonly label = "unreachable";

  loadJobs(): Promise<readonly NeonV1JobRow[]> {
    return Promise.reject(
      new Error(`Motian-Neon source unreachable (${this.label})`)
    );
  }
}
