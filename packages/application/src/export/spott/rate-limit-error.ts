import { SpottApiError } from "./errors";
import { SPOTT_RATE_LIMIT_PER_MINUTE } from "./types";

export class SpottRateLimitError extends SpottApiError {
  constructor() {
    super(
      `Spott API rate limit exceeded (${SPOTT_RATE_LIMIT_PER_MINUTE} requests/minute)`,
      429
    );
    this.name = "SpottRateLimitError";
  }
}
