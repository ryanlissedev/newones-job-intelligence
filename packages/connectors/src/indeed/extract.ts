import type {
  IndeedExtractedSalary,
  IndeedJobCard,
  IndeedRemoteWorkModel,
  IndeedSalaryInfoModel,
  IndeedSalarySnippet,
  IndeedSearchPage,
  IndeedViewJob,
} from "./types";

/**
 * Raw upstream shapes inside the embedded JS assignments — typed after the
 * real 2026-09-18 capture, every field optional because Indeed omits keys it
 * does not populate. The SAFETY casts below stand for "the capture showed
 * these names and value types"; anything upstream changes simply lands as
 * undefined and the projections keep working field-by-field.
 */
interface IndeedRawSalarySnippet {
  currency?: string | null;
  source?: string | null;
  text?: string | null;
}

interface IndeedRawExtractedSalary {
  max?: number | null;
  min?: number | null;
  type?: string | null;
}

interface IndeedRawRemoteWorkModel {
  text?: string | null;
  type?: string | null;
}

interface IndeedRawRequirement {
  label?: string | null;
}

interface IndeedRawRequirementsModel {
  jobOnlyRequirements?: IndeedRawRequirement[] | null;
}

interface IndeedRawHiresModel {
  hiresNeededExact?: string | null;
}

interface IndeedRawJobCard {
  company?: string | null;
  companyRating?: number | null;
  companyReviewCount?: number | null;
  country?: string | null;
  createDate?: number | null;
  displayTitle?: string | null;
  expired?: boolean | null;
  extractedSalary?: IndeedRawExtractedSalary | null;
  formattedLocation?: string | null;
  formattedRelativeTime?: string | null;
  hiringMultipleCandidatesModel?: IndeedRawHiresModel | null;
  indeedApplyable?: boolean | null;
  jobCardRequirementsModel?: IndeedRawRequirementsModel | null;
  jobkey?: string | null;
  jobLocationCity?: string | null;
  jobLocationState?: string | null;
  jobTypes?: string[] | null;
  newJob?: boolean | null;
  normTitle?: string | null;
  pubDate?: number | null;
  redirectToThirdPartySite?: boolean | null;
  remoteWorkModel?: IndeedRawRemoteWorkModel | null;
  salarySnippet?: IndeedRawSalarySnippet | null;
  snippet?: string | null;
  sponsored?: boolean | null;
  title?: string | null;
  truncatedCompany?: string | null;
  urgentlyHiring?: boolean | null;
  viewJobLink?: string | null;
}

interface IndeedRawJobCardsModel {
  pageNumber?: number | null;
  results?: IndeedRawJobCard[] | null;
}

interface IndeedRawProviderData {
  metaData?: {
    mosaicProviderJobCardsModel?: IndeedRawJobCardsModel | null;
  } | null;
}

interface IndeedRawPageLink {
  href?: string | null;
  label?: number | null;
}

interface IndeedRawSalaryInfoModel {
  salaryCurrency?: string | null;
  salaryMax?: number | null;
  salaryMin?: number | null;
  salarySource?: string | null;
  salaryText?: string | null;
  salaryType?: string | null;
}

interface IndeedRawJobInfoHeaderModel {
  companyName?: string | null;
  formattedLocation?: string | null;
  jobTitle?: string | null;
  remoteWorkModel?: IndeedRawRemoteWorkModel | null;
}

interface IndeedRawJobInfoModel {
  jobInfoHeaderModel?: IndeedRawJobInfoHeaderModel | null;
  sanitizedJobDescription?: string | null;
}

interface IndeedRawJobMetadataFooterModel {
  advertiserName?: string | null;
  age?: string | null;
}

interface IndeedRawViewJobBody {
  jobInfoWrapperModel?: {
    jobInfoModel?: IndeedRawJobInfoModel | null;
  } | null;
  jobKey?: string | null;
  jobLanguage?: string | null;
  jobLocation?: string | null;
  jobMetadataFooterModel?: IndeedRawJobMetadataFooterModel | null;
  jobOccupations?: string[] | null;
  jobTitle?: string | null;
  remoteWorkModel?: IndeedRawRemoteWorkModel | null;
  salaryInfoModel?: IndeedRawSalaryInfoModel | null;
}

interface IndeedRawInitialData {
  autoOpenTwoPaneViewjobResponse?: {
    body?: IndeedRawViewJobBody | null;
  } | null;
  pageLinks?: IndeedRawPageLink[] | null;
  pageNum?: number | null;
  searchTitleBarModel?: {
    totalNumResults?: number | null;
  } | null;
}

/**
 * Server-rendered Indeed pages embed their data as JavaScript assignments
 * (`window._initialData={…}`, `window.mosaic.providerData["…"]={…}`) rather
 * than fetching an API. Extraction finds the `=` after the marker and
 * brace-matches the object literal, skipping string contents and escapes.
 */
const readObjectLiteral = (html: string, fromIndex: number): string | null => {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = fromIndex; i < html.length; i += 1) {
    const c = html.charAt(i);
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (c === "\\") {
        escaped = true;
      } else if (c === '"') {
        inString = false;
      }
      continue;
    }
    if (c === '"') {
      inString = true;
    } else if (c === "{") {
      depth += 1;
    } else if (c === "}") {
      depth -= 1;
      if (depth === 0) {
        return html.slice(fromIndex, i + 1);
      }
    }
  }
  return null;
};

const extractAssignedJson = <Embedded>(
  html: string,
  marker: RegExp
): Embedded | null => {
  const match = marker.exec(html);
  if (!match) {
    return null;
  }
  const objectStart = match.index + match[0].length;
  if (html.charAt(objectStart) !== "{") {
    return null;
  }
  const literal = readObjectLiteral(html, objectStart);
  if (literal === null) {
    return null;
  }
  try {
    // SAFETY: literal is an object literal embedded in the page's own
    // script; Embedded is the observed upstream contract (all fields
    // optional).
    return JSON.parse(literal) as Embedded;
  } catch {
    return null;
  }
};

const INITIAL_DATA_MARKER = /window\._initialData\s*=\s*/u;
const JOBCARDS_MARKER =
  /providerData\[(?:"|')mosaic-provider-jobcards(?:"|')\]\s*=\s*/u;

/** Cloudflare managed challenge / Indeed bot-detection interstitials,
 * observed 2026-09-18 (fixtures/connectors/indeed/blocked-*.json):
 * - curl /jobs → 403 `cf-mitigated: challenge` page (`cf_chl`,
 *   `/cdn-cgi/challenge-platform/`).
 * - headed turnstile "Security Check" page (`cf_chl`, `turnstile`).
 * - curl /viewjob → 401 "Authenticating..." page that bounces to
 *   `from=bot-detection-anonymous` login (`__CF$cv$params`).
 * A blocked page must NEVER read as "zero results" — that would reconcile
 * every known record as missed. */
const BLOCKED_PAGE_MARKERS = [
  "/cdn-cgi/challenge-platform/",
  "cf_chl_",
  "__CF$cv$params",
  "from=bot-detection-anonymous",
  "challenge-platform/scripts/jsd/main.js",
  "Security Check - Indeed.com",
] as const;

export const isIndeedBlockedPage = (html: string): boolean =>
  BLOCKED_PAGE_MARKERS.some((marker) => html.includes(marker));

const keep = <Value>(value: Value | null | undefined): Value | null =>
  value ?? null;

const projectSalarySnippet = (
  raw: IndeedRawSalarySnippet | null | undefined
): IndeedSalarySnippet | null =>
  raw
    ? {
        currency: keep(raw.currency),
        source: keep(raw.source),
        text: keep(raw.text),
      }
    : null;

const projectExtractedSalary = (
  raw: IndeedRawExtractedSalary | null | undefined
): IndeedExtractedSalary | null =>
  raw ? { max: keep(raw.max), min: keep(raw.min), type: keep(raw.type) } : null;

const projectRemoteWork = (
  raw: IndeedRawRemoteWorkModel | null | undefined
): IndeedRemoteWorkModel | null =>
  raw ? { text: keep(raw.text), type: keep(raw.type) } : null;

/** `jobCardRequirementsModel.jobOnlyRequirements[].label` — display labels
 * only; suid/strictness/attrId never leave the connector (DEC-008). */
const projectRequirementLabels = (
  raw: IndeedRawRequirementsModel | null | undefined
): string[] => {
  const labels: string[] = [];
  for (const requirement of raw?.jobOnlyRequirements ?? []) {
    if (requirement.label) {
      labels.push(requirement.label);
    }
  }
  return labels;
};

const projectSalaryInfo = (
  raw: IndeedRawSalaryInfoModel | null | undefined
): IndeedSalaryInfoModel | null =>
  raw
    ? {
        salaryCurrency: keep(raw.salaryCurrency),
        salaryMax: keep(raw.salaryMax),
        salaryMin: keep(raw.salaryMin),
        salarySource: keep(raw.salarySource),
        salaryText: keep(raw.salaryText),
        salaryType: keep(raw.salaryType),
      }
    : null;

/** DEC-008: whitelist one `mosaicProviderJobCardsModel.results[]` entry.
 * Drops tracking (`link`, `mouseDownHandlerOption`, `thirdPartyApplyUrl`,
 * `extractTrackingUrls`, `encryptedResultData`, `screenerQuestionsURL`),
 * encrypted company/ad ids, ranking scores, resume/match models and the
 * remaining ~70 upstream fields. */
export const projectIndeedJobCard = (
  raw: IndeedRawJobCard
): IndeedJobCard | null => {
  const jobkey = raw.jobkey ?? null;
  if (jobkey === null) {
    return null;
  }
  return {
    company: keep(raw.company),
    companyRating: keep(raw.companyRating),
    companyReviewCount: keep(raw.companyReviewCount),
    country: keep(raw.country),
    createDate: keep(raw.createDate),
    displayTitle: keep(raw.displayTitle),
    expired: raw.expired === true,
    extractedSalary: projectExtractedSalary(raw.extractedSalary),
    formattedLocation: keep(raw.formattedLocation),
    formattedRelativeTime: keep(raw.formattedRelativeTime),
    hiresNeededExact: keep(raw.hiringMultipleCandidatesModel?.hiresNeededExact),
    indeedApplyable: raw.indeedApplyable === true,
    jobLocationCity: keep(raw.jobLocationCity),
    jobLocationState: keep(raw.jobLocationState),
    jobTypes: raw.jobTypes ?? [],
    jobkey,
    newJob: raw.newJob === true,
    normTitle: keep(raw.normTitle),
    pubDate: keep(raw.pubDate),
    redirectToThirdPartySite: raw.redirectToThirdPartySite === true,
    remoteWorkModel: projectRemoteWork(raw.remoteWorkModel),
    requirementLabels: projectRequirementLabels(raw.jobCardRequirementsModel),
    salarySnippet: projectSalarySnippet(raw.salarySnippet),
    snippet: keep(raw.snippet),
    sponsored: raw.sponsored === true,
    title: keep(raw.title),
    truncatedCompany: keep(raw.truncatedCompany),
    urgentlyHiring: raw.urgentlyHiring === true,
    viewJobLink: keep(raw.viewJobLink),
  };
};

export const parseIndeedInitialData = (
  html: string
): IndeedRawInitialData | null =>
  extractAssignedJson<IndeedRawInitialData>(html, INITIAL_DATA_MARKER);

/**
 * Parses a `/jobs` SERP page. Returns `null` when the jobcards providerData
 * is absent — fail closed, never an empty page (an empty page would read
 * as "source ran out" and stale the remaining records).
 */
export const parseIndeedSearchPage = (
  html: string
): IndeedSearchPage | null => {
  const providerData = extractAssignedJson<IndeedRawProviderData>(
    html,
    JOBCARDS_MARKER
  );
  const model = providerData?.metaData?.mosaicProviderJobCardsModel;
  if (!model) {
    return null;
  }
  const cards: IndeedJobCard[] = [];
  for (const raw of model.results ?? []) {
    const card = projectIndeedJobCard(raw);
    if (card) {
      cards.push(card);
    }
  }

  const initialData = parseIndeedInitialData(html);
  return {
    cards,
    pageLinks: (initialData?.pageLinks ?? []).map((link) => ({
      href: keep(link.href),
      label: keep(link.label),
    })),
    pageNum: keep(initialData?.pageNum) ?? keep(model.pageNumber),
    totalNumResults: keep(initialData?.searchTitleBarModel?.totalNumResults),
  };
};

/** DEC-008: whitelist `_initialData.autoOpenTwoPaneViewjobResponse.body`.
 * Drops the ~130 account/session/tracking/promo models that body also
 * carries (`accountKey`, `ctk`, `mobtk`, `oneGraphApiKey`,
 * `deploymentGroupToken`, `segmentId`, proctor groups, resume models, …). */
export const projectIndeedViewJob = (
  raw: IndeedRawViewJobBody | null | undefined
): IndeedViewJob | null => {
  if (!raw) {
    return null;
  }
  const jobInfoModel = raw.jobInfoWrapperModel?.jobInfoModel;
  const headerModel = jobInfoModel?.jobInfoHeaderModel;
  const footerModel = raw.jobMetadataFooterModel;
  return {
    advertiserName: keep(footerModel?.advertiserName),
    age: keep(footerModel?.age),
    companyName: keep(headerModel?.companyName),
    formattedLocation:
      keep(headerModel?.formattedLocation) ?? keep(raw.jobLocation),
    jobKey: keep(raw.jobKey),
    jobLanguage: keep(raw.jobLanguage),
    jobLocation: keep(raw.jobLocation),
    jobOccupations: raw.jobOccupations ?? [],
    jobTitle: keep(headerModel?.jobTitle) ?? keep(raw.jobTitle),
    remoteWorkModel:
      projectRemoteWork(headerModel?.remoteWorkModel) ??
      projectRemoteWork(raw.remoteWorkModel),
    salaryInfoModel: projectSalaryInfo(raw.salaryInfoModel),
    sanitizedJobDescription: keep(jobInfoModel?.sanitizedJobDescription),
  };
};

/**
 * Parses the viewjob payload a SERP embeds for its auto-opened card
 * (`_initialData.autoOpenTwoPaneViewjobResponse`, observed 2026-09-18 with
 * `from: "tp-sponfirstjob"`). Returns `null` when no embedded body exists or
 * its `jobKey` does not match `jobkey` — fail closed, never attribute one
 * job's payload to another card.
 */
export const parseIndeedEmbeddedViewJob = (
  html: string,
  jobkey: string
): IndeedViewJob | null => {
  const initialData = parseIndeedInitialData(html);
  const viewJob = projectIndeedViewJob(
    initialData?.autoOpenTwoPaneViewjobResponse?.body
  );
  if (!viewJob?.jobKey || viewJob.jobKey !== jobkey) {
    return null;
  }
  return viewJob;
};

const LD_JSON_SCRIPT =
  /<script[^>]*type=(?:"|')application\/ld\+json(?:"|')[^>]*>(?<body>[\s\S]*?)<\/script>/giu;

interface IndeedRawLdJsonNode {
  "@type"?: string | string[] | null;
  "@graph"?: IndeedRawLdJsonNode[] | null;
}

/**
 * JobPosting `application/ld+json` extractor for `GET /viewjob?jk=` pages.
 * UNVERIFIED: the route currently redirects anonymous clients to login
 * (`from=bot-detection-anonymous`, probed 2026-09-18), so no real capture
 * exists to test against — wired for the day the route serves anonymous
 * HTML again; returns `null` on anything else.
 */
export const parseIndeedJobPosting = (
  html: string
): IndeedRawLdJsonNode | null => {
  for (const match of html.matchAll(LD_JSON_SCRIPT)) {
    const text = match.groups?.body?.trim();
    if (!text) {
      continue;
    }
    try {
      const parsed: unknown = JSON.parse(text);
      const nodes = Array.isArray(parsed) ? parsed : [parsed];
      for (const node of nodes) {
        // SAFETY: ld+json nodes are upstream-owned; fields are optional so
        // an unexpected shape simply fails the @type check below.
        const record = node as IndeedRawLdJsonNode | null;
        const type = record?.["@type"];
        if (
          type === "JobPosting" ||
          (Array.isArray(type) && type.includes("JobPosting"))
        ) {
          return record;
        }
        for (const graphNode of record?.["@graph"] ?? []) {
          if (graphNode["@type"] === "JobPosting") {
            return graphNode;
          }
        }
      }
    } catch {
      // Not JSON — try the next ld+json block.
    }
  }
  return null;
};
