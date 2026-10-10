import { hashContent } from "../object-store";
import { ONEFELLOW_PARSER_VERSION } from "./types";
import type { OnefellowJob } from "./types";

/** Canonical JSON of the whitelisted fields that matter for change
 * detection. Only fields the connector/normaliser actually read -- this
 * mirrors the DEC-008 projection in connector.ts, so a re-poll that only
 * changes an untracked field (e.g. an internal id) never registers as a
 * content change. */
export const hashOnefellowListingItem = (
  item: OnefellowJob
): Promise<string> => {
  const canonical = JSON.stringify({
    address_city: item.address_city ?? null,
    company: item.company ?? null,
    company_city: item.company_city ?? null,
    description: item.description ?? null,
    duration: item.duration ?? null,
    hours: item.hours ?? null,
    joborder_id: item.joborder_id,
    max_rate: item.max_rate ?? null,
    parser_version: ONEFELLOW_PARSER_VERSION,
    salary: item.salary ?? null,
    start_date: item.start_date ?? null,
    status: item.status ?? null,
    teaser: item.teaser ?? null,
    time_deadline: item.time_deadline ?? null,
    title: item.title,
    workplace_type: item.workplace_type ?? null,
  });
  return hashContent(new TextEncoder().encode(canonical));
};

export const hashOnefellowPayload = (body: Uint8Array): Promise<string> =>
  hashContent(body);
