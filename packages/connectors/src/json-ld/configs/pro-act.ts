import type { JsonLdConnectorConfig } from "../types";

/**
 * Pro-Act IT (WordPress/Yoast, SSR). Discovery via `vacancy-sitemap.xml` (17-20 entries)
 * on the canonical www-less host — `www.pro-act.nl` 301-redirects to `pro-act.nl`
 * (live capture 2026-09-21). Detail pages carry a JobPosting JSON-LD node whose own
 * `description` embeds a "Start / Eind / Inzet / Tarief / Locatie" bullet block (tarief
 * is usually the literal text "marktconform", not a number) -- so the label-block
 * fields read from the JobPosting description text rather than the surrounding HTML.
 * Robots (https://pro-act.nl/robots.txt, 200 on 2026-09-21): `Crawl-delay: 10` inside
 * the `User-agent: Googlebot` group — the `User-agent: *` group is empty — plus
 * `Disallow: /wp-admin/` and the sitemap index. The `www` host serves no robots.txt
 * at all (404), matching its redirect-only role.
 */
export const proActConfig: JsonLdConnectorConfig = {
  detailFixtures: {
    "https://pro-act.nl/vacatures/iso-8783/": "pro-act/detail-2.json",
    "https://pro-act.nl/vacatures/senior-azure-operations-engineer-8793/":
      "pro-act/detail-1.json",
  },
  discovery: {
    kind: "sitemap",
    url: "https://pro-act.nl/vacancy-sitemap.xml",
  },
  labelBlock: {
    eindDatum: { pattern: /Eind:\s*(?<value>[^<\t]+)/u, source: "description" },
    // "Voor onze directe eindklant, <naam>," or "...eindklant de <naam>,"
    // (confirmed in both live captures, 2026-08-31) -- an explicit label,
    // not free-text mining: `hiringOrganization` is always "Pro-Act IT"
    // itself (the broker), never the real client (docs/sources/pro-act.md).
    // No `i` flag and the value must start with an uppercase letter
    // (2-60 chars, no leading digit): guards against sentences like "Voor
    // onze eindklant zoeken wij een senior developer," where there is no
    // explicit name at all -- a lowercase-starting capture there must stay
    // unmatched, not become a fake opdrachtgeverNaam (codex review). A digit
    // start is excluded too: "eindklant, 1 van de grootste banken van
    // Nederland," would otherwise be captured as the client name (advisor
    // review) -- no digit-led Pro-Act client name has been observed.
    // Residual risk (accepted, docs/sources/pro-act.md): a city name after
    // "eindklant," (e.g. "eindklant, Den Haag,") would still match -- the
    // template is confirmed on 2/2 live captures and the result is always
    // provenance-tagged `labelBlock.eindklant`, so a wrong capture is
    // auditable rather than silent.
    eindklant: {
      pattern:
        /[Ee]indklant,?\s+(?:de\s+|het\s+)?(?<value>[A-Z][^,.<]{1,59}?),/u,
      source: "description",
    },
    locatie: {
      pattern: /Locatie:\s*(?<value>[^<\t]+)/u,
      source: "description",
    },
    startDatum: {
      pattern: /Start:\s*(?<value>[^<\t]+)/u,
      source: "description",
    },
    tarief: { pattern: /Tarief:\s*(?<value>[^<\t]+)/u, source: "description" },
    urenPerWeek: {
      pattern: /Inzet:\s*(?<value>[^<\t]+)/u,
      source: "description",
    },
  },
  listingFixturePath: "pro-act/listing-page-0.json",
  liveEnvVar: "PROACT_LIVE",
  parserVersion: "pro-act/v2",
  slug: "pro-act",
};
