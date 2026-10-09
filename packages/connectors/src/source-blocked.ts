/**
 * The source refused us at its edge (a bot challenge or similar block), as
 * opposed to a transient or server-side failure. Typed so run accounting can
 * classify the run as `blocked` instead of a generic fetch failure.
 */
export class SourceBlockedError extends Error {
  readonly url: string;

  constructor(options: { message: string; url: string }) {
    super(options.message);
    this.name = "SourceBlockedError";
    this.url = options.url;
  }
}
