export interface BacklogDrain {
  curated: number;
  failed: number;
  quarantined: number;
  remaining: number;
}

interface DrainBacklogOptions<Input> {
  /**
   * The inline pass was skipped, so `start.remaining` was never counted:
   * run at least one pass (budget and signal permitting) to learn it.
   */
  backlogUnknown?: boolean;
  deadlineMs: number;
  input: Input;
  signal: AbortSignal;
  start: BacklogDrain;
}

/** Retains parked outcomes across passes: remaining=0 alone is not success. */
export const drainBacklog = async <Input>(
  options: DrainBacklogOptions<Input>,
  curate: (input: Input) => Promise<BacklogDrain>,
  now: () => number = Date.now
): Promise<BacklogDrain> => {
  const { deadlineMs, input, signal, start } = options;
  const total = { ...start };
  let mustCount = options.backlogUnknown === true;
  while (
    (mustCount || total.remaining > 0) &&
    now() < deadlineMs &&
    !signal.aborted
  ) {
    // oxlint-disable-next-line no-await-in-loop -- passes must not overlap on one source
    const next = await curate(input);
    total.curated += next.curated;
    total.failed += next.failed;
    total.quarantined += next.quarantined;
    const progressed = mustCount || next.remaining < total.remaining;
    mustCount = false;
    total.remaining = next.remaining;
    if (!progressed) {
      break;
    }
  }
  return total;
};
