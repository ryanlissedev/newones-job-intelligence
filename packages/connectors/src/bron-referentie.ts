import { createHash } from "node:crypto";

import { BRON_REFERENTIE_MAX_LENGTH } from "@ji/domain";

/**
 * Marks a `bron_referentie` as a digest rather than a literal reference.
 * Same convention as `dedup_key` (CTP-499) and content addresses elsewhere.
 */
const BRON_REFERENTIE_DIGEST_PREFIX = "sha256:";

const utf8ByteLength = (value: string): number =>
  new TextEncoder().encode(value).length;

/**
 * CTP-500: keeps a `bron_referentie` at or under
 * {@link BRON_REFERENTIE_MAX_LENGTH} UTF-8 bytes unchanged, so every
 * `source_record` and `aanvraag` row written before this change keeps
 * matching, and replaces a longer one with the sha256 digest of the whole
 * value. Truncating instead would silently merge two records that differ
 * only past the cut.
 *
 * Applied wherever a connector's reference meets a stored one: the staging
 * write in `runConnector`, the known-hash lookup, and `curateObservation`.
 * Connectors themselves keep the raw value, because several rebuild the
 * detail URL from it.
 */
export const boundBronReferentie = (bronReferentie: string): string =>
  utf8ByteLength(bronReferentie) <= BRON_REFERENTIE_MAX_LENGTH
    ? bronReferentie
    : `${BRON_REFERENTIE_DIGEST_PREFIX}${createHash("sha256").update(bronReferentie, "utf-8").digest("hex")}`;
