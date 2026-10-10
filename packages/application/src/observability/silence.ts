import type { ConnectorRunMetrics } from "@ji/connectors";

export const SOURCE_SILENCE_RUNBOOK_PATH = "docs/runbooks/source-silence.md";

export const DEFAULT_SILENCE_OWNER = "operator@catapulze.invalid";

export const DEFAULT_VOLUME_DROP_THRESHOLD = 0.5;

export const SILENCE_ALERT_KIND = "bron.stil" as const;

export interface RunBaselineSample {
  readonly at: Date;
  readonly changed: number;
  readonly found: number;
  readonly new: number;
}

export interface SilenceDetectionInput {
  readonly baseline: readonly RunBaselineSample[];
  readonly baselineWindowDays?: number;
  readonly bronId: string;
  readonly bronNaam: string;
  readonly detectedAt: Date;
  readonly httpStatus: number;
  readonly lastSuccessAt: Date | null;
  readonly metrics: ConnectorRunMetrics;
  readonly owner?: string;
  readonly thresholdRatio?: number;
}

export interface SilenceEventPayload {
  readonly bron: string;
  readonly bronNaam: string;
  readonly dedupeKey: string;
  readonly detectietijd: string;
  readonly drempel: number;
  readonly eigenaar: string;
  readonly evidence: Readonly<Record<string, boolean | null | number | string>>;
  readonly kind: typeof SILENCE_ALERT_KIND;
  readonly laatsteSucces: string | null;
  readonly message: string;
  readonly runbook: string;
}

const average = (values: readonly number[]): number => {
  if (values.length === 0) {
    return 0;
  }
  return values.reduce((sum, value) => sum + value, 0) / values.length;
};

const withinWindow = (
  sample: RunBaselineSample,
  detectedAt: Date,
  windowDays: number
): boolean => {
  const windowMs = windowDays * 86_400_000;
  return detectedAt.getTime() - sample.at.getTime() <= windowMs;
};

export const buildSilenceDedupeKey = (bronId: string): string =>
  `silence:${bronId}:zero-activity-volume-drop`;

export const evaluateSilence = (
  input: SilenceDetectionInput
): SilenceEventPayload | null => {
  if (input.httpStatus !== 200) {
    return null;
  }

  if (input.metrics.new !== 0 || input.metrics.changed !== 0) {
    return null;
  }

  const windowDays = input.baselineWindowDays ?? 7;
  const threshold = input.thresholdRatio ?? DEFAULT_VOLUME_DROP_THRESHOLD;
  const samples = input.baseline.filter((sample) =>
    withinWindow(sample, input.detectedAt, windowDays)
  );

  if (samples.length === 0) {
    return null;
  }

  const baselineAvgFound = average(samples.map((sample) => sample.found));
  const baselineAvgActivity = average(
    samples.map((sample) => sample.new + sample.changed)
  );

  if (baselineAvgFound <= 0 || baselineAvgActivity <= 0) {
    return null;
  }

  const activityDrop =
    (input.metrics.new + input.metrics.changed) / baselineAvgActivity;
  const volumeDrop = input.metrics.found / baselineAvgFound;
  const dropPastThreshold =
    activityDrop <= threshold && volumeDrop <= threshold;

  if (!dropPastThreshold) {
    return null;
  }

  const owner = input.owner ?? DEFAULT_SILENCE_OWNER;
  const dedupeKey = buildSilenceDedupeKey(input.bronId);

  return {
    bron: input.bronId,
    bronNaam: input.bronNaam,
    dedupeKey,
    detectietijd: input.detectedAt.toISOString(),
    drempel: threshold,
    eigenaar: owner,
    evidence: {
      baseline_avg_activity: baselineAvgActivity,
      baseline_avg_found: baselineAvgFound,
      baseline_samples: samples.length,
      baseline_window_days: windowDays,
      current_changed: input.metrics.changed,
      current_error: input.metrics.error,
      current_found: input.metrics.found,
      current_new: input.metrics.new,
      current_rejected: input.metrics.rejected,
      http_status: input.httpStatus,
      volume_drop_ratio: volumeDrop,
    },
    kind: SILENCE_ALERT_KIND,
    laatsteSucces: input.lastSuccessAt?.toISOString() ?? null,
    message: `Bron ${input.bronNaam} heeft een succesvolle run zonder nieuwe of gewijzigde records terwijl de 7-daagse baseline een volumedaling boven de drempel toont.`,
    runbook: SOURCE_SILENCE_RUNBOOK_PATH,
  };
};

export interface SilenceAlertWriter {
  findOpenByDedupeKey: (dedupeKey: string) => Promise<{ id: string } | null>;
  upsertBronHealth: (input: {
    bronId: string;
    lastRunAt: Date;
    lastRunStatus: string;
    silenceAlertOpen: boolean;
  }) => Promise<void>;
  writeAlert: (input: {
    bronId: string;
    dedupeKey: string;
    evidence: SilenceEventPayload["evidence"];
    kind: string;
    message: string;
  }) => Promise<{ created: boolean; id: string }>;
}

export const emitSilenceEvent = async (
  writer: SilenceAlertWriter,
  event: SilenceEventPayload
): Promise<{ alertId: string; created: boolean }> => {
  const existing = await writer.findOpenByDedupeKey(event.dedupeKey);
  if (existing) {
    await writer.upsertBronHealth({
      bronId: event.bron,
      lastRunAt: new Date(event.detectietijd),
      lastRunStatus: "succeeded",
      silenceAlertOpen: true,
    });
    return { alertId: existing.id, created: false };
  }

  const written = await writer.writeAlert({
    bronId: event.bron,
    dedupeKey: event.dedupeKey,
    evidence: {
      ...event.evidence,
      bron: event.bron,
      detectietijd: event.detectietijd,
      drempel: event.drempel,
      eigenaar: event.eigenaar,
      laatste_succes: event.laatsteSucces,
      runbook: event.runbook,
    },
    kind: event.kind,
    message: event.message,
  });

  await writer.upsertBronHealth({
    bronId: event.bron,
    lastRunAt: new Date(event.detectietijd),
    lastRunStatus: "succeeded",
    silenceAlertOpen: true,
  });

  return { alertId: written.id, created: written.created };
};

export const observeConnectorRunSilence = async (input: {
  baseline: readonly RunBaselineSample[];
  bronId: string;
  bronNaam: string;
  detectedAt: Date;
  httpStatus: number;
  lastSuccessAt: Date | null;
  metrics: ConnectorRunMetrics;
  writer: SilenceAlertWriter;
}): Promise<{
  alertId?: string;
  created: boolean;
  event: SilenceEventPayload | null;
}> => {
  const event = evaluateSilence(input);
  if (!event) {
    return { created: false, event: null };
  }

  const result = await emitSilenceEvent(input.writer, event);
  return {
    alertId: result.alertId,
    created: result.created,
    event,
  };
};
