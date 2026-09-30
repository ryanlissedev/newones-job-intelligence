import { z } from "zod";

export const requireDatabaseUrl = (): string => {
  const databaseUrl = process.env.DATABASE_URL?.trim();
  if (!databaseUrl) {
    throw new Error("DATABASE_URL is required for poll-bron");
  }
  return databaseUrl;
};

export const requireManticoreUrl = (): string => {
  const manticoreUrl = process.env.MANTICORE_URL?.trim();
  if (!manticoreUrl) {
    throw new Error("MANTICORE_URL is required for outbox drain");
  }
  return manticoreUrl;
};

export type SearchProjectorMode = "worker" | "onbox";

const searchProjectorMode = z.enum(["worker", "onbox"]);

/**
 * Selects who drains the outbox into Manticore after a bron run (RJC-387).
 * Defaults to "worker" — the pre-existing behaviour, where this same
 * process constructs a `ManticoreSearchEngine` and drains inline right
 * after the outbox commit. "onbox" defers that entirely to the standalone
 * projector process (`apps/server/src/projector`) running next to
 * Manticore, so a cloud worker with no path to a private Manticore never
 * needs `MANTICORE_URL`. See docs/runbooks/search-projector.md.
 */
export const readSearchProjectorMode = (): SearchProjectorMode => {
  const raw = process.env.SEARCH_PROJECTOR?.trim() || "worker";
  const result = searchProjectorMode.safeParse(raw);
  if (!result.success) {
    throw new Error(
      `SEARCH_PROJECTOR must be "worker" or "onbox", received "${raw}"`
    );
  }
  return result.data;
};

export const DEFAULT_ALERT_ESCALATION_HOURS = 4;

/**
 * CTP-653: operator channel for alert routing. Unset means the stderr sink —
 * alerts are still persisted, only the push is skipped. Set to an https
 * webhook URL (Slack incoming webhook shape: `{text}`).
 */
export const readAlertWebhookUrl = (): string | null => {
  const raw = process.env.ALERT_WEBHOOK_URL?.trim();
  if (!raw) {
    return null;
  }
  const url = URL.parse(raw);
  const isLoopback =
    url !== null &&
    url.protocol === "http:" &&
    (url.hostname === "localhost" ||
      url.hostname === "127.0.0.1" ||
      url.hostname === "[::1]");
  if (url === null || (url.protocol !== "https:" && !isLoopback)) {
    throw new Error(
      // Webhook URLs carry a bearer-like secret in the path; never echo them.
      `ALERT_WEBHOOK_URL must be an https URL (http only for loopback), received scheme "${url?.protocol ?? "unparseable"}"`
    );
  }
  return url.toString();
};

/**
 * How long an open alert stays un-acked before the escalator re-delivers it.
 * Defaults to `DEFAULT_ALERT_ESCALATION_HOURS`; must be a positive number.
 */
export const readAlertEscalationHours = (): number => {
  const raw = process.env.ALERT_ESCALATION_HOURS?.trim();
  if (!raw) {
    return DEFAULT_ALERT_ESCALATION_HOURS;
  }
  const hours = Number(raw);
  if (!Number.isFinite(hours) || hours <= 0) {
    throw new Error(
      `ALERT_ESCALATION_HOURS must be a positive number, received "${raw}"`
    );
  }
  return hours;
};
