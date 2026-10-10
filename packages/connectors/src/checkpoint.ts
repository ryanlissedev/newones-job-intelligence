import type { BronId, ScrapeRunId } from "@ji/domain";

import type { ConnectorCheckpoint, ConnectorRunMetrics } from "./contract";

export interface CheckpointKey {
  bronId: BronId;
  scrapeRunId: ScrapeRunId;
}

export interface ConnectorRunProgress {
  checkpoint: ConnectorCheckpoint | null;
  metrics: ConnectorRunMetrics;
}

export interface RunProgressStore {
  load: (key: CheckpointKey) => Promise<ConnectorRunProgress | null>;
}
