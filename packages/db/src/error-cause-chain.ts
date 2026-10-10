/**
 * Flattens an `Error` and its `cause` chain into one readable line.
 *
 * CTP-499: production logged `Curation failed for observation 7100e5cb-...`
 * and nothing else. The message that mattered -- `PostgresError 54000: index
 * row size 3368 exceeds btree version 4 maximum 2704` -- was two `cause` links
 * down, where neither the poller's `poller_source` line nor the rethrown
 * wrapper ever looked. Reading it took reproducing the failure in the app
 * image.
 */

/**
 * A value a `catch` block received.
 *
 * `unknown` is honest here rather than unparsed input: `throw` accepts any
 * value, so nothing at this boundary can promise an `Error`, and every function
 * below narrows before it reads a property.
 */
export interface ThrownValue {
  readonly error: unknown;
}

/**
 * Deep enough for the observed shape (wrapper -> Drizzle query error ->
 * postgres.js error), with one level spare, and shallow enough that a
 * pathologically nested chain cannot produce an unbounded line. The walk also
 * stops on a repeated reference, so a self-referencing cause terminates.
 */
export const MAX_CAUSE_DEPTH = 4;

const CAUSE_SEPARATOR = " <- ";

const messageOf = (input: ThrownValue): string =>
  input.error instanceof Error ? input.error.message : String(input.error);

/**
 * Returns `error`, `error.cause`, `error.cause.cause`, ... in order, at most
 * {@link MAX_CAUSE_DEPTH} entries.
 *
 * The link that carries the actionable detail is rarely the outermost one: a
 * Drizzle query error wraps the postgres.js error that holds the `code`, so
 * anything classifying a failure has to walk rather than inspect the top.
 */
export const causeChain = (input: ThrownValue): unknown[] => {
  const chain: unknown[] = [];
  const seen = new Set<unknown>();
  let current = input.error;
  while (
    current !== undefined &&
    current !== null &&
    !seen.has(current) &&
    chain.length < MAX_CAUSE_DEPTH
  ) {
    seen.add(current);
    chain.push(current);
    current = current instanceof Error ? current.cause : undefined;
  }
  return chain;
};

/**
 * Returns the messages of the chain, skipping empty ones so a blank link cannot
 * produce a dangling separator.
 */
export const causeChainMessages = (input: ThrownValue): string[] =>
  causeChain(input)
    .map((error) => messageOf({ error }))
    .filter((message) => message !== "");

/** The cause chain as one line, joined with `" <- "`. */
export const describeCauseChain = (input: ThrownValue): string =>
  causeChainMessages(input).join(CAUSE_SEPARATOR);

/** The `name` of an `Error`, or a stable placeholder for a non-`Error` throw. */
export const errorNameOf = (input: ThrownValue): string =>
  input.error instanceof Error ? input.error.name : "UnknownError";
