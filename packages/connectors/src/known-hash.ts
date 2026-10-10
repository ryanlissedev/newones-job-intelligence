import type { BronId } from "@ji/domain";

/**
 * Lookup for the LISTING-tier hash (`hash*ListingItem`) last persisted for a
 * record (RJC-357). Connector short-circuits compare `DiscoverItem.contentHash`
 * — also a listing hash — against this value, so both sides of the comparison
 * come from the same tier. Never back this with the payload hash
 * (`source_record.content_hash`): the two are computed over different inputs
 * and never match, which silently disables the skip.
 */
export interface KnownHashStore {
  /** Returns the last persisted listing hash, or null/undefined when none exists (never skip then). */
  get: (
    bronId: BronId,
    bronReferentie: string
  ) => Promise<string | null | undefined>;
  /**
   * Optional: the PAYLOAD hash (`source_record.content_hash`) last persisted for
   * the record. Only the lastmod honesty probe uses it: it compares a probed
   * fetch's payload hash with this to catch a source whose `<lastmod>` did not
   * move although the page did. It is never used to skip a fetch.
   */
  getPayloadHash?: (
    bronId: BronId,
    bronReferentie: string
  ) => Promise<string | null | undefined>;
}

/**
 * Connector `fetch` short-circuit: true when the store holds a listing hash for
 * this record equal to `contentHash`. Without a store, or without a persisted
 * hash, the fetch is never skipped.
 */
export const shouldSkipFetch = async (
  store: KnownHashStore | undefined,
  bronId: BronId,
  bronReferentie: string,
  contentHash: string
): Promise<boolean> => {
  if (!store) {
    return false;
  }
  const knownHash = await store.get(bronId, bronReferentie);
  return (
    knownHash !== null && knownHash !== undefined && knownHash === contentHash
  );
};

export class InMemoryKnownHashStore implements KnownHashStore {
  private readonly hashes = new Map<string, string>();
  private readonly payloadHashes = new Map<string, string>();

  private static key(bronId: BronId, bronReferentie: string): string {
    return `${bronId}\0${bronReferentie}`;
  }

  get(
    bronId: BronId,
    bronReferentie: string
  ): Promise<string | null | undefined> {
    return Promise.resolve(
      this.hashes.get(InMemoryKnownHashStore.key(bronId, bronReferentie))
    );
  }

  set(bronId: BronId, bronReferentie: string, contentHash: string): void {
    this.hashes.set(
      InMemoryKnownHashStore.key(bronId, bronReferentie),
      contentHash
    );
  }

  getPayloadHash(
    bronId: BronId,
    bronReferentie: string
  ): Promise<string | null | undefined> {
    return Promise.resolve(
      this.payloadHashes.get(InMemoryKnownHashStore.key(bronId, bronReferentie))
    );
  }

  setPayloadHash(
    bronId: BronId,
    bronReferentie: string,
    payloadHash: string
  ): void {
    this.payloadHashes.set(
      InMemoryKnownHashStore.key(bronId, bronReferentie),
      payloadHash
    );
  }
}
