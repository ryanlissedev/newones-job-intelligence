import type {
  Connector,
  ConnectorRunKind,
  KnownHashStore,
} from "@ji/connectors";
import type { BronId, VoorwaardenStatus } from "@ji/domain";

import type { NormalisedAanvraagDraft, NormaliseContext } from "../normalise";

export interface CreateSourceConnectorInput {
  bronId: BronId;
  knownHashes?: KnownHashStore;
  /** Replay/fixture runs: read the listing from this repo fixture instead of HTTP. */
  listingFixturePath?: string;
  /** Whether the source's live env flag (`liveEnv`) is set to "1". */
  live: boolean;
  runKind: ConnectorRunKind;
}

/** Everything the worker, replay, smoke seed and curate path need to know about one bron. */
export interface SourceDefinition<Slug extends string = string> {
  bronId: BronId;
  createConnector: (input: CreateSourceConnectorInput) => Connector;
  /**
   * RJC-357/RJC-401: whether this source's `hash*ListingItem` demonstrably
   * covers EVERY field the normaliser reads for a persisted or
   * lifecycle-relevant value (closing moment, status, locatie, tarief,
   * titel, beschrijving, bronUrl, bronSpecifiek). Only when true may the
   * known-hash short-circuit skip a fetch — so `createConnector` must
   * forward `knownHashes` to the connector iff this is true (asserted in
   * sources.spec.ts). False for every source whose fetch reads a detail
   * page the listing hash cannot see: skipping there freezes detail-only
   * changes (e.g. a moved sluitingsdatum) into the curated aanvraag.
   * Field-by-field evidence lives in docs/sources/<slug>.md.
   */
  listingHashCoversDetail: boolean;
  /** Env var name that switches the connector from fixtures to live HTTP. */
  liveEnv: string;
  naam: string;
  normalise: (
    body: Uint8Array,
    contentHash: string,
    context?: NormaliseContext
  ) => NormalisedAanvraagDraft;
  /** Bron row defaults used by the smoke seed. */
  seed: {
    crawlDelayMs: number;
    methode: string;
    /**
     * Overrides the activation guard's minimum distinct test-import
     * observations for sources whose whole catalog is smaller than the
     * default. It still guards against a zero/near-zero schema-drift
     * import; never set it above the default.
     */
    minimumTestImportObservations?: number;
    voorwaardenStatus: VoorwaardenStatus;
  };
  slug: Slug;
}
