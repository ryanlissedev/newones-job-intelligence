import { synthesizeContactsFromCircle8Page } from "../extract";
import type { JsonLdConnectorConfig } from "../types";

/**
 * Circle8 (Teamtailor, werkenbij.circle8.nl). The `/jobs` listing renders
 * every vacancy as a `/jobs/<id>-<slug>` anchor — two internal Circle8
 * vacancies at capture time (IT Recruiter, Bedrijfsjurist); the site lists
 * no klantopdrachten, only werken-bij roles (see docs/sources/circle8.md).
 * Each detail page carries a JobPosting JSON-LD node plus a "Contact" card
 * that `detailSynthesizer` folds into `contactpersonen`.
 *
 * The detail `<dl>` publishes Afdeling/Rol/Locaties/Status werken op afstand;
 * they are kept verbatim under their own label_block keys (no typed draft
 * slot exists for them). "Locaties" is deliberately NOT mapped to canonical
 * `locatie`: the source value is the employer entity "Circle8 Nederland",
 * while `jobLocation.address.addressLocality` carries the real work city
 * (Nieuwegein) that locatieTekst should keep. `tarief`/`urenPerWeek` come
 * from the description's own benefits prose ("Een salaris tussen de €3656 -
 * €4500…", "Je werkt tussen de 32 en 40 uur…"); "salaris" stays inside the
 * captured tarief value so the shared parser reads the band as per-maand,
 * never as a bare-euro hourly rate. validThrough, start- and einddatum are
 * not published and stay UNKNOWN.
 */
export const circle8Config: JsonLdConnectorConfig = {
  detailBaseUrl: "https://werkenbij.circle8.nl",
  detailFixtures: {
    "https://werkenbij.circle8.nl/jobs/7851475-bedrijfsjurist":
      "circle8/detail-bedrijfsjurist-7851475.json",
    "https://werkenbij.circle8.nl/jobs/8338072-it-recruiter":
      "circle8/detail-it-recruiter-8338072.json",
  },
  detailSynthesizer: (body) => synthesizeContactsFromCircle8Page(body),
  discovery: {
    kind: "listing",
    linkPattern: /^\/jobs\/\d+-[^/?#]+$/u,
    url: "https://werkenbij.circle8.nl/jobs",
  },
  labelBlock: {
    afdeling: {
      pattern: /<dt[^>]*>\s*Afdeling\s*<\/dt>\s*<dd[^>]*>\s*(?<value>[^<]+)/u,
    },
    locaties: {
      pattern: /<dt[^>]*>\s*Locaties\s*<\/dt>\s*<dd[^>]*>\s*(?<value>[^<]+)/u,
    },
    rol: {
      pattern: /<dt[^>]*>\s*Rol\s*<\/dt>\s*<dd[^>]*>\s*(?<value>[^<]+)/u,
    },
    statusWerkenOpAfstand: {
      pattern:
        /<dt[^>]*>\s*Status werken op afstand\s*<\/dt>\s*<dd[^>]*>\s*(?<value>[^<]+)/u,
    },
    tarief: {
      pattern:
        /(?<value>(?:maand)?salaris\b[^<.]{0,80}?€\s*[\d.,]+(?:\s*(?:[-–]|en|tot|t\/m)\s*€?\s*[\d.,]+)?)/iu,
      source: "description",
    },
    urenPerWeek: {
      pattern:
        /werkt\s+tussen\s+de\s+(?<value>\d+\s*(?:en|tot|t\/m|[-–])\s*\d+\s*uur)/iu,
      source: "description",
    },
  },
  listingFixturePath: "circle8/listing-page-0.json",
  liveEnvVar: "CIRCLE8_LIVE",
  parserVersion: "circle8/v2",
  slug: "circle8",
};
