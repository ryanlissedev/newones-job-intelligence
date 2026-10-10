import { hashContent } from "../object-store";
import type { InhuurdeskAssignment } from "./types";

/**
 * RJC-357/RJC-401: this listing hash covers EVERY `InhuurdeskAssignment`
 * field -- fetch() re-serialises the listing row with no second request, so
 * an unchanged listing hash proves the whole payload (and everything the
 * Inhuurdesk normaliser derives) is unchanged. Keep this list in sync with
 * `InhuurdeskAssignment` or the known-hash skip becomes unsafe (coverage
 * test in inhuurdesk.spec.ts, see docs/sources/inhuurdesk.md).
 */
export const hashInhuurdeskListingItem = (
  item: InhuurdeskAssignment
): Promise<string> => {
  const canonical = JSON.stringify({
    clientName: item.clientName ?? null,
    clientNameSlug: item.clientNameSlug ?? null,
    closingDateClient: item.closingDateClient ?? null,
    closingDateInvoice: item.closingDateInvoice ?? null,
    contactpersonen: item.contactpersonen ?? null,
    content: item.content ?? null,
    endDate: item.endDate ?? null,
    hasMaxRate: item.hasMaxRate ?? null,
    hourlyRateMax: item.hourlyRateMax ?? null,
    hourlyRateMin: item.hourlyRateMin ?? null,
    hoursPerWeekMax: item.hoursPerWeekMax ?? null,
    hoursPerWeekMin: item.hoursPerWeekMin ?? null,
    id: item.id,
    location: item.location ?? null,
    publishedDate: item.publishedDate ?? null,
    referenceCode: item.referenceCode ?? null,
    segmentName: item.segmentName ?? null,
    startDate: item.startDate ?? null,
    title: item.title,
    titleSlug: item.titleSlug ?? null,
  });
  return hashContent(new TextEncoder().encode(canonical));
};

export const hashInhuurdeskPayload = (body: Uint8Array): Promise<string> =>
  hashContent(body);
