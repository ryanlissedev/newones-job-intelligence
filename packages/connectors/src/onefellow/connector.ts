import type { BronId } from "@ji/domain";

import type {
  Connector,
  ConnectorDiscoverResult,
  DiscoverItem,
} from "../contract";
import { shouldSkipFetch } from "../known-hash";
import type { KnownHashStore } from "../known-hash";
import { createOnefellowClient } from "./client";
import type { OnefellowClient } from "./client";
import { hashOnefellowListingItem, hashOnefellowPayload } from "./hash";
import { onefellowBronReferentie } from "./types";
import type { OnefellowFetchedPayload, OnefellowJob } from "./types";

export interface OnefellowConnectorOptions {
  bronId: BronId;
  client?: OnefellowClient;
  knownHashes?: KnownHashStore;
}

/** DEC-008: never let more than the normaliser/dedup whitelist reach
 * `listingPayload` or the stored body. The live endpoint returns ~70 keys
 * per job (confirmed 2026-08-31), including `contact`/`contact_email`/
 * `contact_phone_mobile`/`contact_phone_work`/`recruiter`/
 * `recruiter_email`/`recruiter_id`/`sourcer` -- PII this source must never
 * normalise, log, or store (docs/sources/onefellow.md). Build a fresh
 * object naming every field explicitly so nothing unlisted here can pass
 * through. */
const projectOnefellowJob = (raw: OnefellowJob): OnefellowJob => ({
  address_city: raw.address_city,
  company: raw.company,
  company_city: raw.company_city,
  description: raw.description,
  duration: raw.duration,
  hours: raw.hours,
  joborder_id: raw.joborder_id,
  max_rate: raw.max_rate,
  salary: raw.salary,
  start_date: raw.start_date,
  status: raw.status,
  teaser: raw.teaser,
  time_deadline: raw.time_deadline,
  time_published: raw.time_published,
  time_updated: raw.time_updated,
  title: raw.title,
  workplace_type: raw.workplace_type,
});

export const createOnefellowConnector = (
  options: OnefellowConnectorOptions
): Connector => {
  const client = options.client ?? createOnefellowClient();
  const { knownHashes } = options;

  return {
    bronId: options.bronId,
    discover: async (): Promise<ConnectorDiscoverResult> => {
      const jobs = await client.fetchListing();
      const items: DiscoverItem[] = await Promise.all(
        jobs.map(async (rawJob) => {
          const job = projectOnefellowJob(rawJob);
          return {
            bronReferentie: onefellowBronReferentie(job),
            contentHash: await hashOnefellowListingItem(job),
            listingPayload: job,
          };
        })
      );
      // No pagination on this endpoint (docs/sources/onefellow.md): the
      // single call returns every open opdracht, so discover() never asks
      // for a next page.
      return { checkpoint: {}, hasMore: false, items };
    },
    fetch: async (item) => {
      // SAFETY: discover() attaches the whitelisted Onefellow job as
      // listingPayload.
      const job = item.listingPayload as OnefellowJob | undefined;
      if (!job?.joborder_id || !job.title) {
        return {
          bronReferentie: item.bronReferentie,
          reason: "listing payload missing joborder_id/title",
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

      // The listing call already carries every field this source exposes
      // (docs/sources/onefellow.md: no separate detail endpoint) -- fetch()
      // re-serialises the already-whitelisted listing payload rather than
      // issuing a second request.
      const payload: OnefellowFetchedPayload = { job };
      const body = new TextEncoder().encode(JSON.stringify(payload));
      const contentHash = await hashOnefellowPayload(body);
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
