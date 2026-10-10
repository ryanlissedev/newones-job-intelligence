import { synthesizeContactsFromProrailPage } from "../extract";
import type { JsonLdConnectorConfig } from "../types";

export const prorailConfig: JsonLdConnectorConfig = {
  detailBaseUrl: "https://www.werkenbijprorail.nl/",
  detailFixtures: {
    "https://www.werkenbijprorail.nl/vacatures/functie/medior-data-engineer":
      "prorail/detail-medior-data-engineer.json",
    "https://www.werkenbijprorail.nl/vacatures/functie/sollicitatie":
      "prorail/detail-sollicitatie-soft-404.json",
    "https://www.werkenbijprorail.nl/vacatures/functie/woordvoerder":
      "prorail/detail-woordvoerder.json",
    "https://www.werkenbijprorail.nl/vacatures/verkeersleiding/treinverkeersleider-maastricht":
      "prorail/detail-treinverkeersleider-maastricht.json",
  },
  detailSynthesizer: (body) => synthesizeContactsFromProrailPage(body),
  discovery: {
    kind: "json-listing",
    linkPattern: /^\/vacatures\/[^/]+\/[^/]+\/?$/u,
    pagination: {
      pageParam: "page",
      pagePointer: "pagination.page",
      pageSizeParam: "pageSize",
      pageSizePointer: "pagination.pageSize",
      totalPointer: "pagination.totalMatching",
    },
    url: "https://www.prorail.nl/nl/api/v1/vacancysearch?page=1&pageSize=50",
    urlPointer: "hits[].pageUrl",
  },
  listingFixturePath: "prorail/listing-page-0.json",
  liveEnvVar: "PRORAIL_LIVE",
  parserVersion: "prorail/v2",
  slug: "prorail",
};
