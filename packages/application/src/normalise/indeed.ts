import { decodeHtmlEntities } from "@ji/connectors";
import { INDEED_PARSER_VERSION } from "@ji/connectors/indeed";
import type {
  IndeedExtractedSalary,
  IndeedFetchedPayload,
  IndeedSalaryInfoModel,
} from "@ji/connectors/indeed";
import { UNKNOWN } from "@ji/domain";
import { resolveLifecycleStatus } from "@ji/domain/lifecycle";

import { findProvincieInText } from "./provincie";
import { field, stripHtml } from "./types";
import type { NormalisedAanvraagDraft, NormalisedTarief } from "./types";

type Card = NonNullable<IndeedFetchedPayload["card"]>;
type Detail = IndeedFetchedPayload["detail"];

const INDEED_VIEWJOB_BASE = "https://nl.indeed.com/viewjob";

/** Canonical public detail URL — the card's `viewJobLink` carries click
 * tracking (`tk`, `advn`, `adid`, `ad`), so only the `jk` parameter is kept.
 * The page itself is login-gated today (docs/sources/indeed.md) but remains
 * the canonical public identity of the posting. */
const resolveBronUrl = (jobkey: string): string =>
  `${INDEED_VIEWJOB_BASE}?jk=${jobkey}`;

const resolveBeschrijving = (detail: Detail, card: Card | null): string => {
  const html = detail.sanitizedJobDescription?.trim();
  if (html) {
    const stripped = stripHtml(decodeHtmlEntities(html));
    if (stripped) {
      return stripped;
    }
  }
  // A detail body without description text still falls back to the card's
  // SERP snippet before degrading to the title.
  const snippet = card?.snippet?.trim();
  if (snippet) {
    const stripped = stripHtml(decodeHtmlEntities(snippet));
    if (stripped) {
      return stripped;
    }
  }
  return detail.jobTitle ?? card?.title ?? "";
};

const resolveTitel = (detail: Detail, card: Card | null): string =>
  detail.jobTitle?.trim() ||
  card?.title?.trim() ||
  card?.displayTitle?.trim() ||
  card?.normTitle?.trim() ||
  "";

/** Indeed salary types map onto tarief eenheden only for uur/dag/maand;
 * "YEARLY" (and anything unrecognised) stays honest UNKNOWN — converting a
 * jaarsalaris to maand would be inferring a number the source never
 * published. Raw min/max/type/text still land in bronSpecifiek. */
const salaryEenheid = (
  type: string | null | undefined
): "uur" | "dag" | "maand" | typeof UNKNOWN => {
  switch (type) {
    case "HOURLY": {
      return "uur";
    }
    case "DAILY": {
      return "dag";
    }
    case "MONTHLY": {
      return "maand";
    }
    default: {
      return UNKNOWN;
    }
  }
};

const amount = (value: number | null | undefined): string | null =>
  value !== null && value !== undefined && Number.isFinite(value) && value > 0
    ? String(value)
    : null;

const resolveTarief = (detail: Detail, card: Card | null): NormalisedTarief => {
  const info: IndeedSalaryInfoModel | IndeedExtractedSalary | null =
    detail.salaryInfoModel ?? card?.extractedSalary ?? null;
  if (info) {
    const eenheid = salaryEenheid(
      "salaryType" in info ? info.salaryType : info.type
    );
    if (eenheid !== UNKNOWN) {
      const min = amount("salaryMin" in info ? info.salaryMin : info.min);
      const max = amount("salaryMax" in info ? info.salaryMax : info.max);
      if (min !== null || max !== null) {
        return {
          eenheid,
          max: max ?? UNKNOWN,
          min: min ?? UNKNOWN,
          valuta:
            ("salaryCurrency" in info ? info.salaryCurrency : null) ?? "EUR",
        };
      }
    }
  }
  return { eenheid: UNKNOWN, max: UNKNOWN, min: UNKNOWN, valuta: "EUR" };
};

const epochMsToIso = (value: number | null | undefined): string | null =>
  value !== null && value !== undefined && Number.isFinite(value) && value > 0
    ? new Date(value).toISOString()
    : null;

// oxlint-disable-next-line eslint/complexity -- one branch per bronSpecifiek field
export const parseIndeedPayload = (
  payload: IndeedFetchedPayload,
  contentHash: string
): NormalisedAanvraagDraft => {
  const { card, detail, jobkey } = payload;
  const parserVersion = INDEED_PARSER_VERSION;
  const beschrijving = resolveBeschrijving(detail, card);
  const locatieTekst =
    detail.formattedLocation?.trim() || card?.formattedLocation?.trim() || "";
  const salaryInfo = detail.salaryInfoModel ?? null;
  const extracted = card?.extractedSalary ?? null;
  // `expired` is the source's own "this posting expired" flag on the card.
  // Indeed publishes no closing date anywhere (docblock below).
  const lifecycle = resolveLifecycleStatus({
    bronSaysClosed: card?.expired === true,
    current: "unknown",
    missedPolls: 0,
    seenOpen: true,
    sluitingsdatumPassed: false,
  });

  return {
    beschrijving: field(
      beschrijving,
      parserVersion,
      "detail.sanitizedJobDescription"
    ),
    bronReferentie: field(jobkey, parserVersion, "jobkey"),
    bronSpecifiek: field(
      {
        bedrijf_beoordelingen: card?.companyReviewCount ?? null,
        bedrijf_rating: card?.companyRating ?? null,
        dienstverband_labels: card?.jobTypes ?? [],
        functie_categorieen: detail.jobOccupations,
        gepubliceerd_op: epochMsToIso(card?.pubDate),
        gesponsord: card?.sponsored ?? null,
        indeed_apply: card?.indeedApplyable ?? null,
        // `findProvincieInText` resolves only an explicit province token in
        // the text ("Zuid-Holland"), never derives one from a city name.
        provincie: findProvincieInText(locatieTekst),
        relatieve_datum: detail.age ?? card?.formattedRelativeTime ?? null,
        remote:
          detail.remoteWorkModel?.text ?? card?.remoteWorkModel?.text ?? null,
        remote_type:
          detail.remoteWorkModel?.type ?? card?.remoteWorkModel?.type ?? null,
        salaris_max: salaryInfo?.salaryMax ?? extracted?.max ?? null,
        salaris_min: salaryInfo?.salaryMin ?? extracted?.min ?? null,
        salaris_tekst:
          salaryInfo?.salaryText ?? card?.salarySnippet?.text ?? null,
        salaris_type: salaryInfo?.salaryType ?? extracted?.type ?? null,
        staat_code: card?.jobLocationState ?? null,
        stad: card?.jobLocationCity ?? null,
        urgent: card?.urgentlyHiring ?? null,
        vacatures_in_rol: card?.hiresNeededExact ?? null,
        vereisten_labels: card?.requirementLabels ?? [],
      },
      parserVersion,
      "detail+card"
    ),
    bronUrl: field(resolveBronUrl(jobkey), parserVersion, "jobkey"),
    contentHash,
    extractieMethode: "html_parser",
    lifecycle,
    locatieLand: field(
      card?.country?.trim() || "NL",
      parserVersion,
      "card.country"
    ),
    locatieTekst: field(
      locatieTekst || UNKNOWN,
      parserVersion,
      "detail.formattedLocation"
    ),
    opdrachtgeverNaam: field(
      detail.companyName?.trim() || card?.company?.trim() || UNKNOWN,
      parserVersion,
      "detail.companyName"
    ),
    parserVersion,
    // Indeed NL publishes no sluitingsdatum, geen startdatum, geen
    // contactpersoon and no uren/week anywhere on the anonymous surface
    // (verified against the 2026-09-18 capture): these stay absent with
    // honest provenance rather than being inferred from neighbouring fields.
    startDatum: field(UNKNOWN, parserVersion, "absent-at-source"),
    status: lifecycle,
    tarief: resolveTarief(detail, card),
    titel: field(resolveTitel(detail, card), parserVersion, "detail.jobTitle"),
  };
};

export const decodeIndeedPayload = (body: Uint8Array): IndeedFetchedPayload =>
  // SAFETY: Observations store connector-serialised JSON from Indeed fetch.
  JSON.parse(new TextDecoder().decode(body)) as IndeedFetchedPayload;

export const normaliseIndeedObservation = (
  body: Uint8Array,
  contentHash: string
): NormalisedAanvraagDraft =>
  parseIndeedPayload(decodeIndeedPayload(body), contentHash);
