/**
 * Health thresholds for the brondashboard, in one file.
 *
 * Motian kept its cron SLO numbers in `src/lib/cron-slo-thresholds.ts` so the
 * dashboard badge and the scheduled health check could not drift apart. Same
 * idea here: D2 derives from these, and the D4 capabilities and D5 badges read
 * the same constants rather than restating them.
 */

/** Bron intervals and next-run times are wall-clock for a Dutch operator. */
export const BRON_HEALTH_TIME_ZONE = "Europe/Amsterdam";

/**
 * A run is only late once its scheduled moment is this far past.
 *
 * Without a grace window every source flickers to "achterstallig" in the
 * seconds between its cron firing and the run row appearing, which is how
 * Motian's dashboard ended up showing every scraper overdue at once.
 */
export const SCHEDULE_OVERDUE_GRACE_MS = 5 * 60 * 1000;

/** Failed runs inside this window feed `recent_failures`. */
export const RECENT_FAILURES_WINDOW_MS = 24 * 60 * 60 * 1000;

/** At or above this many failures in the window, `recent_failures` is critical. */
export const RECENT_FAILURES_CRITICAL_THRESHOLD = 3;

/**
 * The scheduler is stale when no source has polled within this multiple of the
 * smallest configured interval. Two intervals tolerates one missed tick.
 */
export const SCHEDULER_STALE_INTERVAL_MULTIPLIER = 2;

/** How many trailing runs `zero_activity` inspects. */
export const ZERO_ACTIVITY_RUN_COUNT = 3;

/** Circuit state that means "closed"; anything else counts as open. */
export const CIRCUIT_STATUS_CLOSED = "closed";
