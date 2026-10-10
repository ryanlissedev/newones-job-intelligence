/**
 * CTP-610: per-bron policy for contactpersoon extraction, the adjustable
 * mechanism the owner chose over an external legal gate. Everything tunable
 * lives in this one file:
 *
 * - `extractie`: whether a bron's contact fields may be stored at all. Normalise
 *   drops `contactpersonen` when this is false, so turning a bron off takes
 *   effect on the next observation without a connector change.
 * - `publicatiedoel`: whom the source published the contact for. Aanbestedings-
 *   platforms publish contacts for bidders ("aanbieder"); werkenbij sites for
 *   applicants ("sollicitant"). Recorded per bron for the disclosure trail.
 * - `retentieDagen`: how long a stored contact stays visible on the read path
 *   (`contactpersonenBinnenRetentie`). Read-side masking, not deletion: a policy
 *   change takes effect immediately and the raw value is never lost early.
 */
export type ContactpersoonPublicatiedoel = "aanbieder" | "sollicitant";

export interface ContactpersoonBeleid {
  extractie: boolean;
  publicatiedoel: ContactpersoonPublicatiedoel;
  retentieDagen: number;
}

/** Owner decision 2026-09-18: every bron is in scope ("alle vacatures"), so the
 * default is extraction on. Individual bronnen get a stricter entry below when
 * their publication context argues for it. */
const DEFAULT_BELEID: ContactpersoonBeleid = {
  extractie: true,
  publicatiedoel: "sollicitant",
  retentieDagen: 365,
};

/** Per-bron overrides; keyed by the source slug (the `parserVersion` prefix). */
const BELEID_OVERRIDES = {
  // Aanbestedings-/inhuurplatformen publish contacts for suppliers submitting
  // questions and bids, so our use aligns with the publication purpose.
  ctm: { publicatiedoel: "aanbieder" },
  inhuurdesk: { publicatiedoel: "aanbieder" },
  mercell: { publicatiedoel: "aanbieder" },
  needstaffing: { publicatiedoel: "aanbieder" },
  opdrachtoverheid: { publicatiedoel: "aanbieder" },
  striive: { publicatiedoel: "aanbieder" },
  tenderned: { publicatiedoel: "aanbieder" },
} satisfies Record<string, Partial<ContactpersoonBeleid>>;

export const contactpersoonBeleidVoor = (
  slug: string
): ContactpersoonBeleid => {
  // SAFETY: any slug is legal input — an unknown key reads as undefined and
  // falls through to the default via `?? {}`.
  const override =
    BELEID_OVERRIDES[slug as keyof typeof BELEID_OVERRIDES] ?? {};
  return { ...DEFAULT_BELEID, ...override };
};

const MS_PER_DAY = 86_400_000;

/**
 * Read-side retention: contacts observed longer ago than the bron's
 * `retentieDagen` are masked out for display and export. The stored value is
 * left untouched, so extending the window later restores visibility.
 */
export const contactpersonenBinnenRetentie = <Contact extends object>(
  contactpersonen: readonly Contact[],
  laatstGezienOp: Date,
  retentieDagen: number,
  now: Date = new Date()
): Contact[] =>
  now.getTime() - laatstGezienOp.getTime() <= retentieDagen * MS_PER_DAY
    ? [...contactpersonen]
    : [];
