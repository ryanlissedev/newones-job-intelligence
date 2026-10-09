import type { SearchVersion } from "../version";

/** How often the pin re-reads the durable version, off the request path. */
export const DEFAULT_VERSION_REFRESH_MS = 5000;
/**
 * Shortest time a pinned version stays the cache-key version while the
 * projector keeps advancing. Measured on prod (2026-10-08): 7 distinct
 * `appliedSequence` values in ~140 s, bursts every ~2 s. Keying on each one
 * expired every cached search within seconds.
 */
export const DEFAULT_MIN_PIN_MS = 60_000;

export interface SearchVersionPinOptions {
  readonly minPinMs?: number;
  readonly now?: () => number;
  /** The authoritative read, e.g. `engine.getAppliedVersion()` (Postgres). */
  readonly read: () => Promise<SearchVersion>;
  readonly refreshMs?: number;
}

interface Stamped {
  readonly at: number;
  readonly version: SearchVersion;
}

/**
 * The version the result and facet caches are keyed on.
 *
 * - Off the request path: only the very first call waits on `read`. After
 *   that the last observed version is served from memory and refreshed in
 *   the background at most once per `refreshMs`. A failed background read
 *   keeps the last observed version and retries after `refreshMs`.
 * - Coarse: a newer `appliedSequence` re-pins only once the current pin is
 *   `minPinMs` old, so a busy projector bumps the key about once a minute
 *   instead of every batch. A new `generation` (rebuild or schema change)
 *   re-pins as soon as it is observed.
 *
 * Freshness stays bounded by the result TTL, as RJC-389 already requires:
 * equal versions never guaranteed equal index contents.
 */
export class SearchVersionPin {
  private readonly minPinMs: number;
  private readonly now: () => number;
  private observed: Stamped | undefined;
  private pinned: Stamped | undefined;
  private readonly read: () => Promise<SearchVersion>;
  private readonly refreshMs: number;
  private refreshing: Promise<void> | undefined;

  constructor(options: SearchVersionPinOptions) {
    this.minPinMs = options.minPinMs ?? DEFAULT_MIN_PIN_MS;
    this.now = options.now ?? Date.now;
    this.read = options.read;
    this.refreshMs = options.refreshMs ?? DEFAULT_VERSION_REFRESH_MS;
  }

  async current(): Promise<SearchVersion> {
    if (this.observed === undefined) {
      await this.refresh();
    } else if (this.now() - this.observed.at >= this.refreshMs) {
      void this.refreshInBackground();
    }
    return this.pin();
  }

  private pin(): SearchVersion {
    // SAFETY: `current` awaits a successful refresh before the first pin.
    const observed = this.observed as Stamped;
    const { pinned } = this;
    const now = this.now();
    if (
      pinned === undefined ||
      pinned.version.generation !== observed.version.generation ||
      (observed.version.appliedSequence > pinned.version.appliedSequence &&
        now - pinned.at >= this.minPinMs)
    ) {
      this.pinned = { at: now, version: observed.version };
    }
    return (this.pinned as Stamped).version;
  }

  private async refreshInBackground(): Promise<void> {
    try {
      await this.refresh();
    } catch {
      // Keep serving the last observed version; the next call after
      // `refreshMs` retries the read.
    }
  }

  private refresh(): Promise<void> {
    this.refreshing ??= (async () => {
      const startedAt = this.now();
      try {
        const version = await this.read();
        this.observed = { at: startedAt, version };
      } catch (error) {
        if (this.observed !== undefined) {
          // Back off a full interval before the next attempt.
          this.observed = { at: startedAt, version: this.observed.version };
        }
        throw error;
      } finally {
        this.refreshing = undefined;
      }
    })();
    return this.refreshing;
  }
}
