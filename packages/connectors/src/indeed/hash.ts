import { hashContent } from "../object-store";
import type { IndeedJobCard } from "./types";

/** Listing-tier hash covers every whitelisted card field (RJC-357): the
 * normaliser reads card fields for titel/locatie/opdrachtgever/tarief/
 * lifecycle (`expired`), so a card change must force a detail re-fetch. */
export const hashIndeedListingItem = (card: IndeedJobCard): Promise<string> => {
  const canonical = JSON.stringify({
    company: card.company,
    companyRating: card.companyRating,
    companyReviewCount: card.companyReviewCount,
    country: card.country,
    createDate: card.createDate,
    displayTitle: card.displayTitle,
    expired: card.expired,
    extractedSalary: card.extractedSalary,
    formattedLocation: card.formattedLocation,
    formattedRelativeTime: card.formattedRelativeTime,
    hiresNeededExact: card.hiresNeededExact,
    indeedApplyable: card.indeedApplyable,
    jobLocationCity: card.jobLocationCity,
    jobLocationState: card.jobLocationState,
    jobTypes: card.jobTypes,
    jobkey: card.jobkey,
    newJob: card.newJob,
    normTitle: card.normTitle,
    pubDate: card.pubDate,
    redirectToThirdPartySite: card.redirectToThirdPartySite,
    remoteWorkModel: card.remoteWorkModel,
    requirementLabels: card.requirementLabels,
    salarySnippet: card.salarySnippet,
    snippet: card.snippet,
    sponsored: card.sponsored,
    title: card.title,
    truncatedCompany: card.truncatedCompany,
    urgentlyHiring: card.urgentlyHiring,
    viewJobLink: card.viewJobLink,
  });
  return hashContent(new TextEncoder().encode(canonical));
};

export const hashIndeedDetailPayload = (body: Uint8Array): Promise<string> =>
  hashContent(body);
