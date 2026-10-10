import type { JsonLdConnectorConfig } from "../types";

/**
 * BlueTrail (WordPress, SSR). Discovery via `job-sitemap.xml` (145 <url> entries whose
 * `lastmod` refreshes on change). Detail pages carry a full JobPosting JSON-LD node plus
 * a "In het kort" sidebar label table (`<b>Label</b>value</span>`) with Startdatum,
 * Einddatum, Uren per week, Sluitingsdatum, Referentienummer, and Locatie. Robots:
 * `Crawl-delay: 5`; the sitemap's own listing root and known filter/order/facet URLs
 * are excluded so only real vacancy detail pages are discovered.
 */
export const bluetrailConfig: JsonLdConnectorConfig = {
  detailFixtures: {
    "https://www.bluetrail.nl/opdrachten/Interim/adviseur-privacy-ibd/":
      "bluetrail/detail-adviseur-privacy-ibd.json",
    "https://www.bluetrail.nl/opdrachten/Interim/adviseur-security-privacy/":
      "bluetrail/detail-adviseur-security-privacy-2026-09-16.json",
    "https://www.bluetrail.nl/opdrachten/Interim/architect-ict-en-informatielandschap/":
      "bluetrail/detail-architect-ict-en-informatielandschap-2026-09-16.json",
    "https://www.bluetrail.nl/opdrachten/Interim/ciam-tester/":
      "bluetrail/detail-1.json",
    "https://www.bluetrail.nl/opdrachten/Interim/ontwikkelmanager/":
      "bluetrail/detail-ontwikkelmanager-2026-09-16.json",
    "https://www.bluetrail.nl/opdrachten/Interim/systeembeheerder/":
      "bluetrail/detail-2.json",
    "https://www.bluetrail.nl/opdrachten/Interim/teamlead-procesbeschrijver-sr/":
      "bluetrail/detail-teamlead-procesbeschrijver-sr-2026-09-16.json",
  },
  discovery: {
    kind: "sitemap",
    url: "https://www.bluetrail.nl/job-sitemap.xml",
  },
  // Live capture (2026-08-31) confirms `?order=` sort links
  // (/opdrachten/?order=date:desc etc.) are real, but no real facet/filter URL
  // matching bare "or-" was ever found on the listing page or in the sitemap -- the
  // only observed "or-" hits are accidental substrings inside legitimate job-title
  // slugs (e.g. "senior-*"). Excluding on that bare substring would also drop a real
  // Dutch job title like "OR-adviseur" (Ondernemingsraad-adviseur, a works-council
  // advisor role), so only the two confirmed filter shapes are excluded here.
  excludePatterns: [/\/opdrachten\/?$/u, /[?&]order=/u, /[?&]_sft_/u],
  labelBlock: {
    // "Wat wordt er van jou gevraagd? > Competenties:" list (confirmed on a
    // live capture, 2026-09-15, detail-adviseur-privacy-ibd fixture) -- the
    // one structured, tag-like list on the page. The raw `<ul>` inner HTML is
    // captured here; `parseListItems`/`normaliseSkills` in the shared
    // normaliser turn it into the final `skills` list. "Eisen"/"Wensen" on
    // the same page are full requirement sentences, not tags -- deliberately
    // not mapped (see json-ld.ts).
    competenties: {
      pattern: /Competenties:<\/strong><br><br><ul>(?<value>[\s\S]*?)<\/ul>/u,
    },
    eindDatum: { pattern: /<b>Einddatum<\/b>(?<value>[^<]+)/u },
    // Broker-fronted postings name the end client only in the opening
    // "Voor [de] <Naam> zoeken wij" sentence; `hiringOrganization` is the
    // broker. Anchored to the description start. Live measurement and the
    // accepted "Voor Directie IV" risk: docs/sources/bluetrail.md.
    eindklant: {
      pattern:
        /^\s*(?:<[^>]+>\s*)*Voor (?:de |het )?(?<value>[A-Z][^,.<]{1,59}?) zoeken wij/u,
      source: "description",
    },
    locatie: { pattern: /<b>Locatie<\/b>(?<value>[^<]+)/u },
    referentienummer: { pattern: /<b>Referentienummer<\/b>(?<value>[^<]+)/u },
    sluitingsDatum: { pattern: /<b>Sluitingsdatum<\/b>(?<value>[^<]+)/u },
    startDatum: { pattern: /<b>Startdatum<\/b>(?<value>[^<]+)/u },
    urenPerWeek: { pattern: /<b>Uren per week<\/b>(?<value>[^<]+)/u },
  },
  listingFixturePath: "bluetrail/listing-page-0.json",
  liveEnvVar: "BLUETRAIL_LIVE",
  parserVersion: "bluetrail/v3",
  slug: "bluetrail",
};
