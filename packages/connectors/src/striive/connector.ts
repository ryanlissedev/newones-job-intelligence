import type { BronId } from "@ji/domain";

import type {
  Connector,
  ConnectorCheckpoint,
  ConnectorDiscoverResult,
  DiscoverItem,
  SourceContact,
} from "../contract";
import { shouldSkipFetch } from "../known-hash";
import type { KnownHashStore } from "../known-hash";
import { createStriiveClient, striiveBronReferentie } from "./client";
import type { StriiveClient } from "./client";
import { hashStriiveListingItem, hashStriivePayload } from "./hash";
import { STRIIVE_MAX_PAGES, STRIIVE_PAGE_SIZE } from "./types";
import type { StriiveFetchedPayload, StriiveJob } from "./types";

export interface StriiveConnectorOptions {
  bronId: BronId;
  client?: StriiveClient;
  knownHashes?: KnownHashStore;
}

/** CTP-524: split out so `projectStriiveJob` stays under the complexity
 * limit -- these are the 6 tariff fields added to the DEC-008 whitelist
 * (commercial facts, not PII; see types.ts). */
const projectStriiveTarief = (raw: StriiveJob) => ({
  hasMaxRate: raw.hasMaxRate ?? null,
  hourlyRateMax: raw.hourlyRateMax ?? null,
  hourlyRateMin: raw.hourlyRateMin ?? null,
  monthlyRateMax: raw.monthlyRateMax ?? null,
  monthlyRateMin: raw.monthlyRateMin ?? null,
  rateType: raw.rateType ?? null,
});

/** CTP-524 F06/F15: `jobType` (contract/engagement type) and `tags`
 * (skills) are real live fields (confirmed 2026-09-15), whitelisted for the
 * same reason as tariff -- commercial facts, not PII. */
const projectStriiveContractAndSkills = (raw: StriiveJob) => ({
  jobType: raw.jobType ?? null,
  tags: raw.tags ?? null,
});

const clean = (value: string | null | undefined): string | null =>
  value?.trim() || null;

/** CTP-610: folds the raw recruiter/order-contact/requester slots into
 * `contactpersonen`. Field list confirmed in the live capture's scrub note
 * (fixtures/connectors/striive/listing-live.json) -- the slots exist on
 * every record; values were stripped from fixtures but flow live. */
export const projectStriiveContacts = (
  raw: StriiveJob
): SourceContact[] | null => {
  const contacts: SourceContact[] = [];
  const recruiterNaam = [
    clean(raw.recruiterFirstName),
    clean(raw.recruiterMiddleName),
    clean(raw.recruiterLastName),
  ]
    .filter((part): part is string => part !== null)
    .join(" ");
  const recruiter: SourceContact = {
    email: clean(raw.recruiterEmail),
    naam: recruiterNaam || null,
    rol: clean(raw.recruiterFunctionTitle),
    telefoon: clean(raw.recruiterPhoneNumber),
  };
  if (recruiter.naam || recruiter.email || recruiter.telefoon) {
    contacts.push(recruiter);
  }
  // Only fullName: legalName is the contracting legal entity (an
  // organisation), not a person — org names never count as contactpersonen.
  const orderNaam = clean(raw.orderContactFullName);
  if (orderNaam) {
    contacts.push({ naam: orderNaam, rol: "ordercontact" });
  }
  const requester = clean(raw.requesterEmail);
  if (requester && !contacts.some((c) => c.email === requester)) {
    contacts.push({ email: requester, rol: "aanvrager" });
  }
  return contacts.length > 0 ? contacts : null;
};

/** DEC-008: never let more than the whitelisted fields reach
 * `listingPayload` or the stored body. The live endpoint returns a much
 * larger raw record per job -- recruiter name/email/phone and internal
 * staffing-system ids -- so build a fresh object naming every field
 * explicitly. Tariff fields are whitelisted (CTP-524, F09): they were zero
 * at capture time but are commercial facts, not PII, so DEC-008 does not
 * exclude them -- see the doc comment on `StriiveJob` in types.ts. */
const projectStriiveJob = (raw: StriiveJob): StriiveJob => ({
  broker: raw.broker ?? null,
  brokerUrl: raw.brokerUrl ?? null,
  clientName: raw.clientName ?? null,
  closingDateClient: raw.closingDateClient ?? null,
  closingDateInvoice: raw.closingDateInvoice ?? null,
  contactpersonen: projectStriiveContacts(raw) ?? undefined,
  content: raw.content ?? null,
  endDate: raw.endDate ?? null,
  hoursPerWeekMax: raw.hoursPerWeekMax ?? null,
  hoursPerWeekMin: raw.hoursPerWeekMin ?? null,
  id: raw.id,
  location: raw.location ?? null,
  referenceCode: raw.referenceCode ?? null,
  referenceCodeClient: raw.referenceCodeClient ?? null,
  regionLocation: raw.regionLocation ?? null,
  source: raw.source ?? null,
  startDate: raw.startDate ?? null,
  title: raw.title,
  ...projectStriiveTarief(raw),
  ...projectStriiveContractAndSkills(raw),
});

export const createStriiveConnector = (
  options: StriiveConnectorOptions
): Connector => {
  const client = options.client ?? createStriiveClient();
  const { knownHashes } = options;

  return {
    bronId: options.bronId,
    discover: async (
      checkpoint: ConnectorCheckpoint | null
    ): Promise<ConnectorDiscoverResult> => {
      const page = checkpoint?.page ?? 1;
      const listing = await client.fetchListing(page);
      const items: DiscoverItem[] = await Promise.all(
        listing.data.map(async (rawJob) => {
          const job = projectStriiveJob(rawJob);
          return {
            bronReferentie: striiveBronReferentie(job),
            contentHash: await hashStriiveListingItem(job),
            listingPayload: job,
          };
        })
      );
      const nextPage = page + 1;
      const sourceHasMore = listing.data.length === STRIIVE_PAGE_SIZE;
      const hasMore = sourceHasMore && nextPage <= STRIIVE_MAX_PAGES;
      return {
        checkpoint: { page: nextPage },
        hasMore,
        items,
        // RJC-397: the cap stopped us while Striive still had pages.
        truncated: sourceHasMore && !hasMore,
      };
    },
    fetch: async (item) => {
      // SAFETY: discover() attaches projected Striive job rows as listingPayload.
      const job = item.listingPayload as StriiveJob | undefined;
      if (!(job?.id && job.title)) {
        return {
          bronReferentie: item.bronReferentie,
          reason: "listing payload missing id/title",
          status: "rejected" as const,
        };
      }

      if (
        await shouldSkipFetch(
          knownHashes,
          options.bronId,
          item.bronReferentie,
          item.contentHash
        )
      ) {
        return null;
      }

      const payload: StriiveFetchedPayload = { job };
      const body = new TextEncoder().encode(JSON.stringify(payload));
      const contentHash = await hashStriivePayload(body);
      return {
        body,
        bronReferentie: item.bronReferentie,
        contentHash,
        contentType: "json",
        status: "fetched" as const,
      };
    },
    fetchUsesNetwork: false,
  };
};
