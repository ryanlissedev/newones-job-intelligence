import type { BronId } from "@ji/domain";

import type {
  Connector,
  ConnectorCheckpoint,
  ConnectorDiscoverResult,
  DiscoverItem,
} from "../contract";
import { shouldSkipFetch } from "../known-hash";
import type { KnownHashStore } from "../known-hash";
import { createMercellClient } from "./client";
import type { MercellClient } from "./client";
import { hashMercellDetailPayload, hashMercellListingItem } from "./hash";
import { asMercellIdString } from "./ids";
import type {
  MercellDetail,
  MercellFetchedPayload,
  MercellListingItem,
} from "./types";

export interface MercellConnectorOptions {
  bronId: BronId;
  client?: MercellClient;
  /**
   * Poll runs: stop paging at the first row whose `CreatedDate` is older than
   * this instant (the listing is ordered `CreatedDate` desc). Because the
   * s2c search API's `PropertyFilters` semantics are unverified, the
   * publication window is applied client-side and the run is flagged
   * `truncated` so missed-poll reconciliation never counts the unwalked tail.
   */
  publishedSince?: Date;
  /** Mirror the portal's `/today` view: only currently-open tenders. */
  todayOnly?: boolean;
  knownHashes?: KnownHashStore;
}

/* oxlint-disable anti-slop/no-unknown-parameters -- DEC-008 projection: the
 * raw upstream rows are typed loosely at the JSON boundary and narrowed by
 * these whitelists before anything reaches listingPayload or a stored body. */

/**
 * DEC-008: never let more than the whitelist reach `listingPayload` or the
 * stored body. A live listing row carries 25 keys (internal `EntityMnemonic*`
 * bookkeeping, `Version` byte arrays, `CreatedById`/`ModifiedById` user ids,
 * the buyer's blob `OrganizationImageUrl`); build a fresh object naming each
 * field so nothing unlisted can pass through.
 */
const projectMercellListingItem = (
  raw: MercellListingItem
): MercellListingItem => ({
  CreatedDate: raw.CreatedDate ?? null,
  Deadline: raw.Deadline ?? null,
  Guid: raw.Guid ?? null,
  ModifiedDate: raw.ModifiedDate ?? null,
  OrganizationId: raw.OrganizationId ?? null,
  OrganizationName: raw.OrganizationName ?? null,
  ProcedureType: raw.ProcedureType ?? null,
  PublicationDate: raw.PublicationDate ?? null,
  ShowOnToday: raw.ShowOnToday ?? null,
  SpecialNumber: raw.SpecialNumber ?? null,
  Status: raw.Status ?? null,
  TenderDescription: raw.TenderDescription ?? null,
  TenderId: raw.TenderId,
  TenderName: raw.TenderName,
});

/** DEC-008 detail whitelist, split across two projections so each stays
 * readable. `PublicationAuthorities[]` collapses to its mnemonic list — the
 * rest of each authority record (guids, timestamps, entity bookkeeping) is
 * not modelled. */
const projectMercellDetailIdentity = (
  raw: MercellDetail
): Pick<
  MercellDetail,
  | "ContactPersonDisplayName"
  | "ContactPersonEmail"
  | "ContactPersonPhone"
  | "DisplayNumber"
  | "OrganizationId"
  | "OrganizationName"
  | "PbpUrl"
  | "PublicationDate"
  | "publicationAuthorities"
  | "SpecialNumber"
  | "TenderDescription"
  | "TenderGuid"
  | "TenderId"
  | "TenderName"
> => ({
  ContactPersonDisplayName: raw.ContactPersonDisplayName ?? null,
  ContactPersonEmail: raw.ContactPersonEmail ?? null,
  ContactPersonPhone: raw.ContactPersonPhone ?? null,
  DisplayNumber: raw.DisplayNumber ?? null,
  OrganizationId: raw.OrganizationId ?? null,
  OrganizationName: raw.OrganizationName ?? null,
  PbpUrl: raw.PbpUrl ?? null,
  PublicationDate: raw.PublicationDate ?? null,
  SpecialNumber: raw.SpecialNumber ?? null,
  TenderDescription: raw.TenderDescription ?? null,
  TenderGuid: raw.TenderGuid ?? null,
  TenderId: raw.TenderId,
  TenderName: raw.TenderName,
  publicationAuthorities: raw.publicationAuthorities ?? [],
});

const projectMercellDetailClassification = (
  raw: MercellDetail
): Pick<
  MercellDetail,
  | "CurrencyType"
  | "EstimatedValue"
  | "EstimatedValueMax"
  | "EstimatedValueMin"
  | "EstimatedValueType"
  | "ExplicitTenderStatus"
  | "HasContinuousEvaluation"
  | "IsFrameworkAgreement"
  | "ProcedureType"
  | "PublishedTenderParticipationStatus"
  | "PublishedTenderStatus"
  | "TypeOfContract"
> => ({
  CurrencyType: raw.CurrencyType ?? null,
  EstimatedValue: raw.EstimatedValue ?? null,
  EstimatedValueMax: raw.EstimatedValueMax ?? null,
  EstimatedValueMin: raw.EstimatedValueMin ?? null,
  EstimatedValueType: raw.EstimatedValueType ?? null,
  ExplicitTenderStatus: raw.ExplicitTenderStatus ?? null,
  HasContinuousEvaluation: raw.HasContinuousEvaluation ?? null,
  IsFrameworkAgreement: raw.IsFrameworkAgreement ?? null,
  ProcedureType: raw.ProcedureType ?? null,
  PublishedTenderParticipationStatus:
    raw.PublishedTenderParticipationStatus ?? null,
  PublishedTenderStatus: raw.PublishedTenderStatus ?? null,
  TypeOfContract: raw.TypeOfContract ?? null,
});

const projectMercellDetail = (raw: MercellDetail): MercellDetail => ({
  ...projectMercellDetailIdentity(raw),
  ...projectMercellDetailClassification(raw),
});

const createdBefore = (item: MercellListingItem, cutoff: Date): boolean => {
  if (!item.CreatedDate) {
    // Unparseable/absent CreatedDate cannot be bounded — keep the row rather
    // than silently dropping a real record, and never let it trigger the
    // window edge.
    return false;
  }
  const created = new Date(item.CreatedDate);
  return !Number.isNaN(created.getTime()) && created < cutoff;
};

export const createMercellConnector = (
  options: MercellConnectorOptions
): Connector => {
  const client = options.client ?? createMercellClient();
  const { knownHashes, publishedSince, todayOnly } = options;

  return {
    bronId: options.bronId,
    discover: async (
      checkpoint: ConnectorCheckpoint | null
    ): Promise<ConnectorDiscoverResult> => {
      const page = checkpoint?.page ?? 0;
      const listing = await client.fetchListing(page, { todayOnly });
      const rows = listing.results.map(projectMercellListingItem);

      // Poll window: rows are CreatedDate-desc, so the first row older than
      // the cutoff ends the walk and everything after it is out of window.
      const cutoffIndex =
        publishedSince === undefined
          ? -1
          : rows.findIndex((row) => createdBefore(row, publishedSince));
      const inWindow = cutoffIndex === -1 ? rows : rows.slice(0, cutoffIndex);
      const windowCut = cutoffIndex !== -1;

      const hashed = await Promise.all(
        inWindow.map(async (row): Promise<DiscoverItem | null> => {
          const bronReferentie = asMercellIdString(row.TenderId);
          if (!bronReferentie) {
            return null;
          }
          return {
            bronReferentie,
            contentHash: await hashMercellListingItem(row),
            listingPayload: row,
          };
        })
      );
      const items = hashed.filter(
        (item): item is DiscoverItem => item !== null
      );
      const result: ConnectorDiscoverResult = {
        checkpoint: {
          page: page + 1,
          pageSize: listing.endIndex - listing.startIndex + 1,
        },
        hasMore: !windowCut && listing.endIndex < listing.resultsCount,
        items,
      };
      if (windowCut) {
        result.truncated = true;
      }
      return result;
    },
    fetch: async (item) => {
      // SAFETY: discover() attaches projected Mercell listing rows as listingPayload.
      const listingPayload = item.listingPayload as
        | MercellListingItem
        | undefined;
      const tenderId = asMercellIdString(listingPayload?.TenderId);
      if (!(listingPayload && tenderId)) {
        return {
          bronReferentie: item.bronReferentie,
          reason: "listing payload missing TenderId",
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

      const rawDetail = await client.fetchDetail(tenderId);
      const payload: MercellFetchedPayload = {
        detail: projectMercellDetail(rawDetail),
        listing: listingPayload,
        tenderId,
      };
      const body = new TextEncoder().encode(JSON.stringify(payload));
      const contentHash = await hashMercellDetailPayload(body);
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
