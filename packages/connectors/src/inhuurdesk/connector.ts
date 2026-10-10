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
import { createInhuurdeskClient, inhuurdeskBronReferentie } from "./client";
import type { InhuurdeskClient } from "./client";
import { hashInhuurdeskListingItem, hashInhuurdeskPayload } from "./hash";
import type { InhuurdeskAssignment, InhuurdeskFetchedPayload } from "./types";

export interface InhuurdeskConnectorOptions {
  bronId: BronId;
  client?: InhuurdeskClient;
  knownHashes?: KnownHashStore;
}

const clean = (value: string | null | undefined): string | null =>
  value?.trim() || null;

/** CTP-610: folds the raw recruiter/requester slots into `contactpersonen`.
 * All were null/`""` across the 21-record live capture (2026-09-03) but are
 * real fields that flow live; `recruiter` reads as a nested person object
 * (HeadFirst-family shape), so non-object values are ignored. */
export const projectInhuurdeskContacts = (
  raw: InhuurdeskAssignment
): SourceContact[] | null => {
  const contacts: SourceContact[] = [];
  const rec = raw.recruiter;
  if (rec) {
    const naam =
      clean(rec.name) ??
      ([clean(rec.firstName), clean(rec.middleName), clean(rec.lastName)]
        .filter((part): part is string => part !== null)
        .join(" ") ||
        null);
    const contact: SourceContact = {
      email: clean(rec.email) ?? clean(raw.recruiterEmail),
      naam,
      rol: clean(rec.functionTitle),
      telefoon: clean(rec.phoneNumber) ?? clean(raw.recruiterPhoneNumber),
    };
    if (contact.naam || contact.email || contact.telefoon) {
      contacts.push(contact);
    }
  } else {
    const contact: SourceContact = {
      email: clean(raw.recruiterEmail),
      naam: null,
      rol: null,
      telefoon: clean(raw.recruiterPhoneNumber),
    };
    if (contact.email || contact.telefoon) {
      contacts.push(contact);
    }
  }
  const requester = clean(raw.requesterEmail);
  if (requester && !contacts.some((c) => c.email === requester)) {
    contacts.push({ email: requester, rol: "aanvrager" });
  }
  return contacts.length > 0 ? contacts : null;
};

/** DEC-008: the live record carries ~120 raw fields (recruiter name/email/
 * phone slots, worksite, positionRule*, Salesforce ids); only the whitelist
 * below reaches `listingPayload` or the stored body. Build a fresh object
 * naming every field explicitly. */
export const projectInhuurdeskAssignment = (
  raw: InhuurdeskAssignment
): InhuurdeskAssignment => ({
  clientName: raw.clientName ?? null,
  clientNameSlug: raw.clientNameSlug ?? null,
  closingDateClient: raw.closingDateClient ?? null,
  closingDateInvoice: raw.closingDateInvoice ?? null,
  contactpersonen: projectInhuurdeskContacts(raw) ?? undefined,
  content: raw.content ?? null,
  endDate: raw.endDate ?? null,
  hasMaxRate: raw.hasMaxRate ?? null,
  hourlyRateMax: raw.hourlyRateMax ?? null,
  hourlyRateMin: raw.hourlyRateMin ?? null,
  hoursPerWeekMax: raw.hoursPerWeekMax ?? null,
  hoursPerWeekMin: raw.hoursPerWeekMin ?? null,
  id: raw.id,
  location: raw.location ?? null,
  publishedDate: raw.publishedDate ?? null,
  referenceCode: raw.referenceCode ?? null,
  segmentName: raw.segmentName ?? null,
  startDate: raw.startDate ?? null,
  title: raw.title,
  titleSlug: raw.titleSlug ?? null,
});

export const createInhuurdeskConnector = (
  options: InhuurdeskConnectorOptions
): Connector => {
  const client = options.client ?? createInhuurdeskClient();
  const { knownHashes } = options;

  return {
    bronId: options.bronId,
    discover: async (
      checkpoint: ConnectorCheckpoint | null
    ): Promise<ConnectorDiscoverResult> => {
      // Live 2026-09-03: `page` is 1-indexed -- `page=0` and `page=1` return
      // the same first page, the page past the end returns an empty `data`.
      const page = checkpoint?.page ?? 1;
      const listing = await client.fetchListing(page);
      let pageSize = checkpoint?.pageSize ?? 0;
      if (pageSize <= 0) {
        pageSize = listing.data.length > 0 ? listing.data.length : 1;
      }
      const items: DiscoverItem[] = await Promise.all(
        listing.data.map(async (raw) => {
          const assignment = projectInhuurdeskAssignment(raw);
          return {
            bronReferentie: inhuurdeskBronReferentie(assignment),
            contentHash: await hashInhuurdeskListingItem(assignment),
            listingPayload: assignment,
          };
        })
      );
      return {
        checkpoint: { page: page + 1, pageSize },
        hasMore: listing.data.length > 0 && page * pageSize < listing.total,
        items,
      };
    },
    fetch: async (item) => {
      // SAFETY: discover() attaches Inhuurdesk assignment rows as listingPayload.
      const assignment = item.listingPayload as
        | InhuurdeskFetchedPayload["assignment"]
        | undefined;
      if (!(assignment?.id && assignment.title)) {
        return {
          bronReferentie: item.bronReferentie,
          reason: "listing payload missing id or title",
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

      const payload: InhuurdeskFetchedPayload = { assignment };
      const body = new TextEncoder().encode(JSON.stringify(payload));
      const contentHash = await hashInhuurdeskPayload(body);
      return {
        body,
        bronReferentie: item.bronReferentie,
        contentHash,
        contentType: "json",
        status: "fetched" as const,
      };
    },
  };
};
