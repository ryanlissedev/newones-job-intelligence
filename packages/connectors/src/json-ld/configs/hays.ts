import { synthesizeContactsFromHaysPage } from "../extract";
import type { JsonLdConnectorConfig } from "../types";

/** Hays exposes a static search page whose links carry stable tracking query
 * parameters. The keys below intentionally preserve those exact fixture URLs. */
export const haysConfig: JsonLdConnectorConfig = {
  detailBaseUrl: "https://www.hays.nl",
  detailFixtures: {
    "https://www.hays.nl/vacature-details/buyer-sports-and-outdoor-amsterdam_1050471?q=&location=&applyId=JOB_5411289&jobSource=HaysGCJ&isSponsored=N&specialismId=&subSpecialismId=&jobName=projects/mineral-balm-174308/tenants/ab5d683d-f9a5-4b85-bfe0-eb74881e24cf/jobs/134360935685857990&lang=nl":
      "hays/detail-buyer-sports-and-outdoor-amsterdam-1050471.json",
    "https://www.hays.nl/vacature-details/finance-business-partner-rotterdam_1050462?q=&location=&applyId=JOB_5412125&jobSource=HaysGCJ&isSponsored=N&specialismId=&subSpecialismId=&jobName=projects/mineral-balm-174308/tenants/ab5d683d-f9a5-4b85-bfe0-eb74881e24cf/jobs/96725423613715142&lang=nl":
      "hays/detail-finance-business-partner-rotterdam-1050462.json",
    "https://www.hays.nl/vacature-details/scrum-master-provincie-utrecht_1049921?q=&location=&applyId=JOB_5377570&jobSource=HaysGCJ&isSponsored=N&specialismId=&subSpecialismId=&jobName=projects/mineral-balm-174308/tenants/ab5d683d-f9a5-4b85-bfe0-eb74881e24cf/jobs/103039416380859078&lang=nl":
      "hays/detail-scrum-master-provincie-utrecht-1049921.json",
  },
  detailSynthesizer: (body) => synthesizeContactsFromHaysPage(body),
  discovery: {
    kind: "listing",
    linkPattern: /^\/vacature-details\/[^/?]+$/u,
    url: "https://www.hays.nl/vacatures-zoeken",
  },
  listingFixturePath: "hays/listing-page-0.json",
  liveEnvVar: "HAYS_LIVE",
  parserVersion: "hays/v2",
  slug: "hays",
};
