import { isPollableBron } from "@ji/application/bronnen";

import type { PollBronRuntime } from "./poll-bron-run";
import type { SliceABronDefinition } from "./slice-a-bronnen";
import { resolveSliceABronSlug } from "./slice-a-bronnen";

/**
 * Activated Slice A bronnen that `schedule-slice-a-polls` would fan out to.
 * Shared by the Trigger schedule and the on-box/Coolify oneshot CLI (CTP-488).
 */
export const listPollableSliceABronnen = async (
  runtime: Pick<PollBronRuntime, "bronPersistence">
): Promise<SliceABronDefinition[]> => {
  const records = await runtime.bronPersistence.list();
  return records.flatMap((record) => {
    if (!isPollableBron(record)) {
      return [];
    }
    const bronSlug = resolveSliceABronSlug(record.naam);
    if (!bronSlug) {
      return [];
    }
    return [{ bronId: record.bronId, bronSlug, naam: record.naam }];
  });
};
