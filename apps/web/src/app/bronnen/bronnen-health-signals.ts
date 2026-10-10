import type { SourceHealthSignalsView } from "@ji/application/registry";

type SignalReason = SourceHealthSignalsView[
  | "process"
  | "database"
  | "advisoryLock"
  | "progress"
  | "freshness"
  | "aggregate"]["reason"];

export const healthReasonLabels = {
  advisory_lock_not_owned: "Geen bevestigde lock",
  advisory_lock_unknown: "Lockstatus onbekend",
  current_run_backlogged: "Verwerking heeft nog achterstand",
  current_run_incomplete: "Bron niet volledig opgehaald",
  current_run_parked: "Observaties wachten op herstel",
  current_run_unknown: "Resultaat nog onbekend",
  database_available: "Database bereikbaar",
  database_unavailable: "Database niet bereikbaar",
  database_unknown: "Databasebereikbaarheid onbekend",
  first_progress_overdue: "Eerste voortgang blijft uit",
  freshness_policy_unknown: "Norm voor versheid onbekend",
  freshness_stale: "Gegevens niet volledig bijgewerkt",
  freshness_unknown: "Versheid onbekend",
  healthy: "Alle gezondheidssignalen zijn in orde",
  heartbeat_fresh: "Proces meldt zich op tijd",
  heartbeat_stale: "Procesmelding is verouderd",
  last_full_success_fresh: "Volledig bijgewerkt binnen de norm",
  last_full_success_stale: "Laatste volledige verwerking is te oud",
  lock_held: "Lock bevestigd",
  lock_lost: "Lock verloren",
  lock_not_reported: "Nog geen lockmeting",
  lock_observation_stale: "Lockmeting is verouderd",
  lock_policy_unknown: "Norm voor lockcontrole onbekend",
  never_reported: "Nog geen procesmelding",
  never_succeeded: "Nog geen volledige verwerking bevestigd",
  no_active_run: "Geen actieve verwerking",
  probe_not_observed: "Nog geen databasemeting",
  process_policy_unknown: "Norm voor procesmeldingen onbekend",
  process_telemetry_unknown: "Processtatus onbekend",
  progress_not_reported: "Nog geen voortgang bevestigd",
  progress_policy_unknown: "Tijdbudget voor voortgang onbekend",
  progress_stalled: "Voortgang blijft uit",
  progress_unknown: "Voortgang onbekend",
  progressing: "Verwerking maakt voortgang",
  source_blocked: "Bron geblokkeerd",
  source_inactive: "Bron inactief",
  waiting_for_advisory_lock: "Wacht op lock",
  worker_dead: "Procesmelding is te oud",
} satisfies Record<SignalReason, string>;

export const formatHealthAge = (ageMs: number | null): string => {
  if (ageMs === null) {
    return "Onbekend";
  }
  if (ageMs < 60_000) {
    return "Minder dan een minuut";
  }
  if (ageMs < 3_600_000) {
    return `${Math.floor(ageMs / 60_000)} min`;
  }
  if (ageMs < 86_400_000) {
    return `${Math.floor(ageMs / 3_600_000)} uur`;
  }
  return `${Math.floor(ageMs / 86_400_000)} dagen`;
};

export const healthSignalRows = (signals: SourceHealthSignalsView | null) =>
  (
    [
      ["Proces", signals?.process],
      ["Database", signals?.database],
      ["Lock", signals?.advisoryLock],
      ["Voortgang", signals?.progress],
      ["Versheid", signals?.freshness],
    ] as const
  ).map(([label, signal]) => ({
    age: formatHealthAge(signal?.observedAt ? signal.ageMs : null),
    label,
    reason: signal
      ? healthReasonLabels[signal.reason]
      : "Nog geen meting beschikbaar",
    waitingAge:
      label === "Voortgang" &&
      signals?.progress.waitingAgeMs !== null &&
      signals?.progress.waitingAgeMs !== undefined
        ? formatHealthAge(signals.progress.waitingAgeMs)
        : null,
  }));

export const formatSilenceAlert = (open: boolean | null): string => {
  if (open === null) {
    return "Onbekend";
  }
  return open ? "Open" : "Nee";
};
