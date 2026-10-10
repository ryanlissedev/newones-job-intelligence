import { hashContent } from "../object-store";
import type { StriiveJob } from "./types";

/** CTP-524: split out so `hashStriiveListingItem` stays under the
 * complexity limit -- these are the 6 tariff fields added to the
 * DEC-008 whitelist (commercial facts, not PII; see types.ts). */
const tariefCanonical = (job: StriiveJob) => ({
  hasMaxRate: job.hasMaxRate ?? null,
  hourlyRateMax: job.hourlyRateMax ?? null,
  hourlyRateMin: job.hourlyRateMin ?? null,
  monthlyRateMax: job.monthlyRateMax ?? null,
  monthlyRateMin: job.monthlyRateMin ?? null,
  rateType: job.rateType ?? null,
});

/** CTP-524 F06/F15: jobType (contract) and tags (skills). */
const contractAndSkillsCanonical = (job: StriiveJob) => ({
  jobType: job.jobType ?? null,
  tags: job.tags ?? null,
});

/** Canonical JSON of the already-whitelisted job fields (see the DEC-008
 * projection in connector.ts) -- every field kept past the connector
 * boundary is change-relevant, so the whole projected job is hashed. */
export const hashStriiveListingItem = (job: StriiveJob): Promise<string> => {
  const canonical = JSON.stringify({
    broker: job.broker ?? null,
    brokerUrl: job.brokerUrl ?? null,
    clientName: job.clientName ?? null,
    closingDateClient: job.closingDateClient ?? null,
    closingDateInvoice: job.closingDateInvoice ?? null,
    contactpersonen: job.contactpersonen ?? null,
    content: job.content ?? null,
    endDate: job.endDate ?? null,
    hoursPerWeekMax: job.hoursPerWeekMax ?? null,
    hoursPerWeekMin: job.hoursPerWeekMin ?? null,
    id: job.id,
    location: job.location ?? null,
    referenceCode: job.referenceCode ?? null,
    referenceCodeClient: job.referenceCodeClient ?? null,
    regionLocation: job.regionLocation ?? null,
    source: job.source ?? null,
    startDate: job.startDate ?? null,
    title: job.title,
    ...tariefCanonical(job),
    ...contractAndSkillsCanonical(job),
  });
  return hashContent(new TextEncoder().encode(canonical));
};

export const hashStriivePayload = (body: Uint8Array): Promise<string> =>
  hashContent(body);
