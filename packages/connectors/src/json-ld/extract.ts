/* oxlint-disable anti-slop/no-unknown-parameters, anti-slop/no-runtime-typeof -- This is the JSON-LD extraction I/O boundary: <script type="application/ld+json"> blocks on arbitrary source HTML carry untyped, source-specific JobPosting shapes (plain object, array, or @graph-wrapped), so the object/array narrowing contract is established here. */
import { decodeHtmlEntities } from "../html-entities";
import type {
  DetailSynthesis,
  JsonLdLabelBlockField,
  JsonLdNode,
  JsonLdValue,
  SourceContact,
} from "./types";

const SCRIPT_PATTERN =
  /<script[^>]*type=["']application\/ld\+json["'][^>]*>(?<content>[\s\S]*?)<\/script>/giu;
const NEXT_DATA_PATTERN =
  /<script[^>]*id=["']__NEXT_DATA__["'][^>]*>(?<content>[\s\S]*?)<\/script>/iu;
const VIKE_PAGE_CONTEXT_PATTERN =
  /<script[^>]*id=["']vike_pageContext["'][^>]*>(?<content>[\s\S]*?)<\/script>/iu;
const WORKDAY_APPLY_HREF_PATTERN =
  /href=["'](?<href>https?:\/\/[^"']*myworkdayjobs\.com[^"']*)["']/iu;

const isJsonLdNode = (value: unknown): value is JsonLdNode =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const collectNodes = (value: unknown, out: JsonLdNode[]): void => {
  if (Array.isArray(value)) {
    for (const entry of value) {
      collectNodes(entry, out);
    }
    return;
  }
  if (!isJsonLdNode(value)) {
    return;
  }
  const graph = value["@graph"];
  if (Array.isArray(graph)) {
    collectNodes(graph, out);
    return;
  }
  out.push(value);
};

/** Extracts every JSON-LD node from `<script type="application/ld+json">` blocks in `html`,
 * expanding `@graph` wrappers and tolerating malformed JSON blocks by skipping them. */
export const extractJsonLdNodes = (html: string): JsonLdNode[] => {
  const nodes: JsonLdNode[] = [];
  SCRIPT_PATTERN.lastIndex = 0;
  let match = SCRIPT_PATTERN.exec(html);
  while (match) {
    const raw = match.groups?.content?.trim();
    if (raw) {
      try {
        collectNodes(JSON.parse(raw), nodes);
      } catch {
        // Malformed JSON-LD block on the source page: skip it rather than fail the fetch.
      }
    }
    match = SCRIPT_PATTERN.exec(html);
  }
  return nodes;
};

const isJobPostingType = (value: JsonLdValue | undefined): boolean => {
  if (typeof value === "string") {
    return value === "JobPosting";
  }
  if (Array.isArray(value)) {
    return value.some((entry) => entry === "JobPosting");
  }
  return false;
};

/** Picks the first `JobPosting` node out of a set of extracted JSON-LD nodes. */
export const pickJobPosting = (nodes: JsonLdNode[]): JsonLdNode | null =>
  nodes.find((node) => isJobPostingType(node["@type"])) ?? null;

/** Extracts the first `JobPosting` JSON-LD node directly from a detail page's HTML. */
export const extractJobPosting = (html: string): JsonLdNode | null =>
  pickJobPosting(extractJsonLdNodes(html));

const asRecord = (value: unknown): JsonLdNode | null =>
  isJsonLdNode(value) ? value : null;

const asString = (value: JsonLdValue | undefined): string | undefined =>
  typeof value === "string" && value.trim() ? value : undefined;

const asFiniteId = (value: JsonLdValue | undefined): string | undefined => {
  if (typeof value === "number" && Number.isFinite(value)) {
    return String(value);
  }
  return asString(value);
};

const countryCode = (country: string): string =>
  country.toLowerCase() === "netherlands" ? "NL" : country;

const employmentType = (timeType: string): string => {
  const normalised = timeType.trim().toLowerCase();
  if (normalised === "full time" || normalised === "full-time") {
    return "FULL_TIME";
  }
  if (normalised === "part time" || normalised === "part-time") {
    return "PART_TIME";
  }
  return timeType;
};

const extractNextJobData = (html: string): JsonLdNode | null => {
  NEXT_DATA_PATTERN.lastIndex = 0;
  const raw = NEXT_DATA_PATTERN.exec(html)?.groups?.content?.trim();
  if (!raw) {
    return null;
  }

  try {
    const parsed = JSON.parse(raw);
    const root = asRecord(parsed);
    const props = asRecord(root?.props);
    const pageProps = asRecord(props?.pageProps);
    return asRecord(pageProps?.jobData);
  } catch {
    return null;
  }
};

interface NextJobPostingBuild {
  applyUrl?: string;
  id?: string;
  jobPosting: JsonLdNode;
}

const buildNextJobPosting = (
  jobData: JsonLdNode,
  detailUrl: string
): NextJobPostingBuild => {
  const id = asString(jobData.id);
  const title = asString(jobData.displayJobTitle);
  const datePosted = asString(jobData.datePosted);
  const description = asString(jobData.descriptionExternal);
  const city = asString(jobData.city);
  const country = asString(jobData.country);
  const applyUrl = asString(jobData.applyUrl);
  const detailPageUrl = asString(jobData.detailPageUrl) ?? detailUrl;
  const timeType = asString(jobData.timeType);
  const address: JsonLdNode = { "@type": "PostalAddress" };
  if (city) {
    address.addressLocality = city;
  }
  if (country) {
    address.addressCountry = countryCode(country);
  }

  const jobPosting: JsonLdNode = {
    "@type": "JobPosting",
    description: description ?? "",
    employmentType: timeType ? employmentType(timeType) : "",
    hiringOrganization: { "@type": "Organization", name: "ASML" },
    identifier: {
      "@type": "PropertyValue",
      name: "ASML",
      value: id ?? "",
    },
    jobLocation: { "@type": "Place", address },
    title: title ?? "",
    url: detailPageUrl,
  };
  if (datePosted) {
    jobPosting.datePosted = datePosted;
  }
  return { applyUrl, id, jobPosting };
};

/**
 * Builds the minimum schema.org JobPosting shape from a Next.js page's jobData.
 * This is deliberately a separate, config-gated path: most JSON-LD sources must
 * continue to fail closed when a detail page has no explicit JobPosting node.
 */
export const synthesizeJobPostingFromNextData = (
  html: string,
  detailUrl: string
): DetailSynthesis | null => {
  const jobData = extractNextJobData(html);
  if (!jobData) {
    return null;
  }

  const fallbackApplyUrl =
    WORKDAY_APPLY_HREF_PATTERN.exec(html)?.groups?.href?.trim();
  const { applyUrl, id, jobPosting } = buildNextJobPosting(jobData, detailUrl);
  const labelBlock: Record<string, string> = {};
  if (id) {
    labelBlock.referentienummer = id;
  }
  if (applyUrl ?? fallbackApplyUrl) {
    labelBlock.workdayApplyUrl = applyUrl ?? fallbackApplyUrl ?? "";
  }

  // CTP-610: ASML's jobData carries the hiring manager's name (no email).
  const hiringManager = asString(jobData.hiringManager);
  const contactpersonen: SourceContact[] = hiringManager
    ? [{ naam: hiringManager, rol: "hiring manager" }]
    : [];

  return { contactpersonen, jobPosting, labelBlock };
};

const extractVikeJob = (html: string): JsonLdNode | null => {
  VIKE_PAGE_CONTEXT_PATTERN.lastIndex = 0;
  const raw = VIKE_PAGE_CONTEXT_PATTERN.exec(html)?.groups?.content?.trim();
  if (!raw) {
    return null;
  }

  try {
    const parsed = JSON.parse(raw);
    const root = asRecord(parsed);
    const pageProps = asRecord(root?.pageProps);
    return asRecord(pageProps?.job);
  } catch {
    return null;
  }
};

const facetNames = (value: JsonLdValue | undefined): string[] => {
  if (!Array.isArray(value)) {
    return [];
  }
  const names: string[] = [];
  for (const entry of value) {
    const name = asString(asRecord(entry)?.name);
    if (name) {
      names.push(name);
    }
  }
  return names;
};

/**
 * Builds the minimum schema.org JobPosting shape from a Vike page's
 * `vike_pageContext.pageProps.job` (Techniekwerkt). Same config-gated contract
 * as `synthesizeJobPostingFromNextData`: the source publishes no explicit
 * JobPosting node, so only opted-in sources take this path. `salary` and
 * `contract` facets were empty on every sampled detail page (2026-09-17) —
 * they map to labelBlock only when the source actually populates them, and
 * never to `tarief`/`employmentType` because their value shape is unverified.
 */
export const synthesizeJobPostingFromVike = (
  html: string,
  detailUrl: string
): DetailSynthesis | null => {
  const job = extractVikeJob(html);
  if (!job) {
    return null;
  }

  const id = asFiniteId(job.id);
  const jobPosting: JsonLdNode = {
    "@type": "JobPosting",
    description: asString(job.description) ?? "",
    hiringOrganization: {
      "@type": "Organization",
      name: asString(job.original_companyname) ?? "",
    },
    identifier: {
      "@type": "PropertyValue",
      name: "Techniekwerkt",
      value: id ?? "",
    },
    jobLocation: {
      "@type": "Place",
      address: {
        "@type": "PostalAddress",
        addressCountry: "NL",
        addressLocality: asString(job.city) ?? "",
      },
    },
    title: asString(job.original_functiontitle) ?? "",
    url: detailUrl,
  };

  const labelBlock: Record<string, string> = {};
  if (id) {
    labelBlock.referentienummer = id;
  }
  const updatedAt = asString(job.updated_at);
  if (updatedAt) {
    labelBlock.gewijzigdOp = updatedAt;
  }
  const facetLabels = {
    branche: job.industry,
    dienstverband: job.contract,
    ervaring: job.experience,
    opleiding: job.education,
    salaris: job.salary,
  };
  for (const [key, facet] of Object.entries(facetLabels)) {
    const names = facetNames(facet);
    if (names.length > 0) {
      labelBlock[key] = names.join(", ");
    }
  }

  // CTP-610: the vike job object carries the recruiter contact. The
  // `show_contact_*` flags mark which fields the page actually displays, so a
  // flag of 0 keeps that field out even though the API object still holds it.
  // `apply_email` is the public application channel and is always taken.
  const contactNaam =
    job.show_contact_name === 1 ? asString(job.contact_name) : undefined;
  const contactTelefoon =
    job.show_contact_phone === 1
      ? asString(job.contact_phone_number)
      : undefined;
  const contactEmail = asString(job.apply_email);
  const contactpersonen: SourceContact[] =
    contactNaam || contactEmail || contactTelefoon
      ? [
          {
            email: contactEmail ?? null,
            naam: contactNaam ?? null,
            telefoon: contactTelefoon ?? null,
          },
        ]
      : [];

  return { contactpersonen, jobPosting, labelBlock };
};

const asPlainText = (value: JsonLdValue | undefined): string =>
  typeof value === "string" ? value : "";

/** Applies each configured label-block pattern against either the raw detail HTML or the
 * JobPosting's own `description` text, returning only the fields that matched. */
export const extractLabelBlock = (
  html: string,
  jobPosting: JsonLdNode | null,
  fields?: Record<string, JsonLdLabelBlockField>
) => {
  const result: Record<string, string> = {};
  if (!fields) {
    return result;
  }
  const description = asPlainText(jobPosting?.description);
  for (const [key, config] of Object.entries(fields)) {
    const haystack = config.source === "description" ? description : html;
    config.pattern.lastIndex = 0;
    const match = config.pattern.exec(haystack);
    const value = match?.groups?.value?.trim();
    if (value) {
      result[key] = value;
    }
  }
  return result;
};

const META_TAG_PATTERN = /<meta\b[^>]*>/giu;
const META_CONTENT_PATTERN =
  /content\s*=\s*(?:"(?<dq>[^"]*)"|'(?<sq>[^']*)'|(?<bare>[^\s>]+))/iu;

const escapeRegExp = (value: string): string =>
  value.replaceAll(/[.*+?^${}()|[\]\\]/gu, "\\$&");

/** Reads a `<meta>` tag's `content` attribute by its `property`/`name`, tolerating
 * the unquoted attributes and either attribute order Kentico/Avature pages emit. */
const metaContent = (html: string, property: string): string | undefined => {
  const propertyPattern = new RegExp(
    `\\b(?:property|name)\\s*=\\s*["']?${escapeRegExp(property)}["']?(?=\\s|>|/|$)`,
    "iu"
  );
  META_TAG_PATTERN.lastIndex = 0;
  let match = META_TAG_PATTERN.exec(html);
  while (match) {
    if (propertyPattern.test(match[0])) {
      const content = META_CONTENT_PATTERN.exec(match[0]);
      const value =
        content?.groups?.dq ?? content?.groups?.sq ?? content?.groups?.bare;
      if (value) {
        return decodeHtmlEntities(value).trim();
      }
    }
    match = META_TAG_PATTERN.exec(html);
  }
  return undefined;
};

const H1_PATTERN = /<h1[^>]*>(?<text>[\s\S]*?)<\/h1>/iu;
const STRIP_TAGS = /<[^>]+>/gu;

const firstText = (pattern: RegExp, html: string): string | undefined => {
  pattern.lastIndex = 0;
  const raw = pattern.exec(html)?.groups?.text;
  const text = raw
    ? decodeHtmlEntities(raw.replaceAll(STRIP_TAGS, "")).trim()
    : "";
  return text || undefined;
};

const TRAILING_ID_PATTERN = /\/(?<id>\d+)\/?$/u;

const trailingId = (url: string): string | undefined =>
  TRAILING_ID_PATTERN.exec(new URL(url).pathname)?.groups?.id;

const putIf = (
  target: JsonLdNode,
  key: string,
  value: JsonLdValue | undefined
): void => {
  if (value !== undefined && value !== "") {
    target[key] = value;
  }
};

/**
 * Alliander's vacancy API record (`/api/vacancy/<JR>` / a `vacancies[]` row)
 * carries the full vacancy as typed JSON — no HTML scraping needed. The page
 * at `/vacatures/<slug>/jr<id>` renders the same record client-side.
 * `contactPerson`/`contactPersonEmailAddress` are carried over as
 * `contactpersonen` (CTP-610: contact extraction is owner-approved for every
 * bron; the DEC-008 whitelist names the fields explicitly).
 * `compensationGrade` is a salarisschaal label, not a
 * tarief, so it lands in labelBlock only.
 */
export const synthesizeJobPostingFromAllianderVacancy = (
  body: string,
  detailUrl: string
): DetailSynthesis | null => {
  let vacancy: JsonLdNode | null = null;
  try {
    vacancy = asRecord(JSON.parse(body));
  } catch {
    return null;
  }
  const id = asString(vacancy?.id);
  const title = asString(vacancy?.jobTitle);
  if (!(vacancy && id && title)) {
    return null;
  }

  const location = asString(vacancy.location);
  const postalCode = asString(vacancy.primaryPostalCode);
  const address: JsonLdNode = {
    "@type": "PostalAddress",
    addressCountry: "NL",
  };
  putIf(address, "addressLocality", location);
  putIf(address, "postalCode", postalCode);

  // scheduledWeeklyHours is a number in the API record, not a string.
  const hours = asFiniteId(vacancy.scheduledWeeklyHours);
  const jobPosting: JsonLdNode = {
    "@type": "JobPosting",
    hiringOrganization: {
      "@type": "Organization",
      name: asString(vacancy.employer) ?? "Alliander",
    },
    identifier: { "@type": "PropertyValue", name: "Alliander", value: id },
    jobLocation: { "@type": "Place", address },
    title,
    url: detailUrl,
  };
  putIf(jobPosting, "description", asString(vacancy.description));
  putIf(jobPosting, "datePosted", asString(vacancy.publicationDate));
  putIf(jobPosting, "validThrough", asString(vacancy.endDate));
  putIf(jobPosting, "employmentType", asString(vacancy.contractType));
  putIf(jobPosting, "workHours", hours ? `${hours} uur` : undefined);

  const labelBlock: Record<string, string> = {};
  const labelFields: [string, string | undefined][] = [
    ["referentienummer", id],
    ["locatie", location],
    ["postcode", postalCode],
    ["vakgebied", asString(vacancy.field)],
    ["subvakgebied", asString(vacancy.subField)],
    ["opleiding", asString(vacancy.educationLevel)],
    ["salarisschaal", asString(vacancy.compensationGrade)],
  ];
  for (const [key, value] of labelFields) {
    if (value) {
      labelBlock[key] = value;
    }
  }
  if (hours) {
    labelBlock.urenPerWeek = `${hours} uur`;
  }

  const contactNaam = asString(vacancy.contactPerson);
  const contactEmail = asString(vacancy.contactPersonEmailAddress);
  const contactpersonen: SourceContact[] =
    contactNaam || contactEmail
      ? [{ email: contactEmail ?? null, naam: contactNaam ?? null }]
      : [];

  return { contactpersonen, jobPosting, labelBlock };
};

const DATA_URI_SCRIPT_PATTERN =
  /<script[^>]+src=["']?data:text\/javascript;base64,(?<b64>[A-Za-z0-9+/=]+)["']?/giu;
const DATA_ITEMS_START_PATTERN = /DataItems\s*:\s*\[/u;

/** Slices the JSON array that starts at `openBracket` — counts nested
 * brackets and skips string bodies, so a `]` inside a `Value` text or a
 * nested array doesn't truncate the slice (a lazy `\[.*?\]` regex would
 * stop at the first `]` and silently drop the whole item list). */
const sliceBalancedArray = (
  text: string,
  openBracket: number
): string | null => {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = openBracket; i < text.length; i += 1) {
    const ch = text[i];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === "\\") {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
    } else if (ch === "[") {
      depth += 1;
    } else if (ch === "]") {
      depth -= 1;
      if (depth === 0) {
        return text.slice(openBracket, i + 1);
      }
    }
  }
  return null;
};
const ESSENT_CONTENT_PATTERN =
  /<div\s+class=["']?content[^>]*>(?<body>[\s\S]*?)<\/div>/iu;
const ESSENT_VAC_ITEM_PATTERN =
  /<div\s+class=["']?vacItem["']?[^>]*>[\s\S]*?<span\s+class=["']?widgetHeader["']?[^>]*>(?<title>[\s\S]*?)<\/span>[\s\S]*?<div\s+class=["']?vac-text["']?[^>]*>(?<body>[\s\S]*?)<\/div>[\s\S]*?<\/div>/giu;

const ESSENT_ITEM_LABELS = new Map([
  ["calendar", "urenPerWeek"],
  ["field", "vakgebied"],
  ["location", "locatie"],
  ["salary", "salaris"],
]);

/** Decodes the first `data:text/javascript;base64` script whose Vue payload
 * carries a `DataItems` list; other data-URI scripts are ignored. */
const decodeEssentDataItems = (html: string): JsonLdNode[] => {
  DATA_URI_SCRIPT_PATTERN.lastIndex = 0;
  let script = DATA_URI_SCRIPT_PATTERN.exec(html);
  while (script) {
    const encoded = script.groups?.b64;
    if (encoded) {
      try {
        const decoded = Buffer.from(encoded, "base64").toString("utf-8");
        const start = DATA_ITEMS_START_PATTERN.exec(decoded);
        const raw = start
          ? sliceBalancedArray(decoded, start.index + start[0].length - 1)
          : null;
        if (raw) {
          const parsed: unknown = JSON.parse(raw);
          if (Array.isArray(parsed)) {
            return parsed.filter(isJsonLdNode);
          }
        }
      } catch {
        // Not the DataItems script or malformed payload — keep scanning.
      }
    }
    script = DATA_URI_SCRIPT_PATTERN.exec(html);
  }
  return [];
};

const essentDescription = (html: string): string => {
  const intro = ESSENT_CONTENT_PATTERN.exec(html)?.groups?.body?.trim();
  const sections: string[] = intro ? [intro] : [];
  ESSENT_VAC_ITEM_PATTERN.lastIndex = 0;
  let vacItem = ESSENT_VAC_ITEM_PATTERN.exec(html);
  while (vacItem) {
    const heading = vacItem.groups?.title?.trim();
    const body = vacItem.groups?.body?.trim();
    if (body) {
      sections.push(heading ? `<h3>${heading}</h3>${body}` : body);
    }
    vacItem = ESSENT_VAC_ITEM_PATTERN.exec(html);
  }
  return sections.join("\n");
};

/**
 * Essent (Kentico) detail pages carry the vacancy metadata in a
 * `data:text/javascript;base64` script that hydrates a Vue `features` list —
 * items shaped `{CssClass: "field"|"salary"|"location"|"calendar", Value: "…"}`.
 * Title and intro text come from the `<h1>`/`.content` block, the publication
 * date from `article:published_time`. The salary item is a monthly range
 * (vaste functie) → labelBlock.salaris only, never `tarief`/`baseSalary`.
 */
export const synthesizeJobPostingFromEssentFeatures = (
  html: string,
  detailUrl: string
): DetailSynthesis | null => {
  const items = decodeEssentDataItems(html);

  // `<h1>` wins over `og:title`: some pages carry the site-templated
  // "Vacatures - <titel> - Werken bij Essent" in the meta tag.
  const title = firstText(H1_PATTERN, html) ?? metaContent(html, "og:title");
  if (!title) {
    return null;
  }

  const labelBlock: Record<string, string> = {};
  let location: string | undefined;
  for (const item of items) {
    const cssClass = asString(item.CssClass);
    const value = asString(item.Value);
    const label = cssClass ? ESSENT_ITEM_LABELS.get(cssClass) : undefined;
    if (label && value) {
      labelBlock[label] = value;
      if (cssClass === "location") {
        location = value;
      }
    }
  }

  const slug = new URL(detailUrl).pathname.split("/").findLast(Boolean);
  const address: JsonLdNode = {
    "@type": "PostalAddress",
    addressCountry: "NL",
  };
  if (location) {
    address.addressLocality = location;
  }
  const jobPosting: JsonLdNode = {
    "@type": "JobPosting",
    description: essentDescription(html),
    hiringOrganization: { "@type": "Organization", name: "Essent" },
    identifier: {
      "@type": "PropertyValue",
      name: "Essent",
      value: slug ?? detailUrl,
    },
    jobLocation: { "@type": "Place", address },
    title,
    url: detailUrl,
  };
  putIf(jobPosting, "datePosted", metaContent(html, "article:published_time"));
  if (slug) {
    labelBlock.referentienummer = slug;
  }

  return { jobPosting, labelBlock };
};

const AVATURE_ARTICLE_PATTERN =
  /<article\s+class="article\s+article--details[^"]*"[^>]*>(?<body>[\s\S]*?)<\/article>/giu;
const AVATURE_JOB_ID_PATTERN = /jobId=(?<id>\d+)/iu;

/**
 * TenneT (Avature) JobDetail pages publish no JobPosting JSON-LD and no field
 * list — the vacancy is narrative `article--details` blocks plus `og:*` meta.
 * Title comes from `og:title`, the job id from `og:url`'s `jobId` param (or the
 * trailing URL segment), and the description is the concatenated article bodies.
 * Location/hours are absent at the source — they stay UNKNOWN, never mined from
 * prose.
 */
export const synthesizeJobPostingFromAvature = (
  html: string,
  detailUrl: string
): DetailSynthesis | null => {
  const title = metaContent(html, "og:title");
  if (!title) {
    return null;
  }

  const sections: string[] = [];
  AVATURE_ARTICLE_PATTERN.lastIndex = 0;
  let article = AVATURE_ARTICLE_PATTERN.exec(html);
  while (article) {
    const body = article.groups?.body?.trim();
    if (body) {
      sections.push(body);
    }
    article = AVATURE_ARTICLE_PATTERN.exec(html);
  }

  const ogUrl = metaContent(html, "og:url");
  const id =
    (ogUrl ? AVATURE_JOB_ID_PATTERN.exec(ogUrl)?.groups?.id : undefined) ??
    trailingId(detailUrl);

  const jobPosting: JsonLdNode = {
    "@type": "JobPosting",
    description: sections.join("\n"),
    hiringOrganization: { "@type": "Organization", name: "TenneT" },
    jobLocation: {
      "@type": "Place",
      address: { "@type": "PostalAddress", addressCountry: "NL" },
    },
    title,
    url: detailUrl,
  };
  if (id) {
    jobPosting.identifier = {
      "@type": "PropertyValue",
      name: "TenneT",
      value: id,
    };
  }

  const labelBlock: Record<string, string> = {};
  if (id) {
    labelBlock.referentienummer = id;
  }
  return { jobPosting, labelBlock };
};

const PRORAIL_RECRUITER_CARD_PATTERN =
  /Neem contact op met\s*<b>(?<naam>[^<]{1,80})<\/b>\s*via\s*<a[^>]*mailto:(?<email>[^"'>\s\\]{1,120})/iu;
const PRORAIL_INLINE_CONTACT_PATTERN =
  /(?:aan|met(?:\s+de\s+(?<rol>manager|recruiter))?)\s+(?<naam>[A-ZÀ-Þ][^<,.]{1,80}?)\s+via\s*<a[^>]*mailto:(?<email>[^"'>\s\\]{1,120})/giu;

const collapseWhitespace = (value: string | null | undefined): string | null =>
  value ? value.replaceAll(/\s+/gu, " ").trim() || null : null;

const mergeContact = (
  contacts: SourceContact[],
  contact: SourceContact | null
): void => {
  // Channel-only contacts (a bare tel/mailto link) are still reachable
  // contacts — match toContactpersoon, which drops only the fully empty
  // entry. Telefoon is part of the dedupe key so two phone-only contacts
  // don't collapse into one.
  if (!(contact?.naam || contact?.email || contact?.telefoon)) {
    return;
  }
  const naam = collapseWhitespace(contact.naam);
  const normalised = { ...contact, naam };
  if (
    !contacts.some(
      (entry) =>
        entry.naam === naam &&
        entry.email === normalised.email &&
        entry.telefoon === normalised.telefoon
    )
  ) {
    contacts.push(normalised);
  }
};

/**
 * ProRail detail pages publish a JobPosting JSON-LD node plus a recruiter card
 * (`div.recruiter`: "Neem contact op met <b>name</b> via mailto:") and may
 * name a hiring manager inline ("contact opnemen met de manager X via
 * mailto:"). Returns contact-only synthesis; the explicit JobPosting stays the
 * vacancy source.
 */
export const synthesizeContactsFromProrailPage = (
  html: string
): DetailSynthesis | null => {
  const contactpersonen: SourceContact[] = [];
  const card = PRORAIL_RECRUITER_CARD_PATTERN.exec(html);
  if (card?.groups?.email && card.groups.naam) {
    mergeContact(contactpersonen, {
      email: decodeHtmlEntities(card.groups.email).trim(),
      naam: decodeHtmlEntities(card.groups.naam).trim(),
      rol: "recruiter",
    });
  }
  PRORAIL_INLINE_CONTACT_PATTERN.lastIndex = 0;
  let inline = PRORAIL_INLINE_CONTACT_PATTERN.exec(html);
  while (inline?.groups?.email && inline.groups.naam) {
    mergeContact(contactpersonen, {
      email: decodeHtmlEntities(inline.groups.email).trim(),
      naam: decodeHtmlEntities(inline.groups.naam).trim(),
      rol: inline.groups.rol?.toLowerCase() ?? null,
    });
    inline = PRORAIL_INLINE_CONTACT_PATTERN.exec(html);
  }
  return contactpersonen.length > 0
    ? { contactpersonen, jobPosting: null, labelBlock: {} }
    : null;
};

const VOLKERWESSELS_CONTACT_PATTERN =
  /(?:recruiter|contact op(?:nemen)? met)\s+(?<naam>[A-ZÀ-Þ][^,<]{1,80}?),\s*(?<rol>[^<,.]{1,120}?)\s+via\s*<a[^>]*mailto:(?<email>[^"'>\s\\]{1,120})/iu;
const VOLKERWESSELS_PHONE_PATTERN =
  /mailto:[^"'>\s\\]{1,120}["'][^>]*>[^<]{0,120}<\/a>\s*of\s*(?<telefoon>\+?[\d][\d\s()-]{7,20})/iu;
/** Second VW shape: "contact opnemen met <naam>, <functietitel>, +31…" — the
 * generic CV mailto sits earlier in the paragraph, the named contact carries
 * only a phone number. */
const VOLKERWESSELS_PHONE_CONTACT_PATTERN =
  /contact op(?:nemen)? met\s+(?<naam>[A-ZÀ-Þ][^,<]{1,80}?),\s*(?<rol>[^<,.]{1,120}?),\s*(?<telefoon>\+?[\d][\d\s()-]{7,20})/iu;

/**
 * VolkerWessels detail pages publish a JobPosting JSON-LD node plus a recruiter
 * line — either "… <naam>, <functietitel> via <a mailto:…>… of +31…" or "…
 * <naam>, <functietitel>, +31…" without a personal mailto. Returns
 * contact-only synthesis; the explicit JobPosting stays the vacancy source.
 */
export const synthesizeContactsFromVolkerwesselsPage = (
  html: string
): DetailSynthesis | null => {
  const match = VOLKERWESSELS_CONTACT_PATTERN.exec(html);
  if (match?.groups?.email && match.groups.naam) {
    const telefoon = VOLKERWESSELS_PHONE_PATTERN.exec(html)?.groups?.telefoon;
    return {
      contactpersonen: [
        {
          email: decodeHtmlEntities(match.groups.email).trim(),
          naam: decodeHtmlEntities(match.groups.naam).trim(),
          rol: match.groups.rol?.trim() ?? null,
          telefoon: telefoon?.trim() ?? null,
        },
      ],
      jobPosting: null,
      labelBlock: {},
    };
  }
  const phoneMatch = VOLKERWESSELS_PHONE_CONTACT_PATTERN.exec(html);
  if (phoneMatch?.groups?.naam) {
    return {
      contactpersonen: [
        {
          naam: decodeHtmlEntities(phoneMatch.groups.naam).trim(),
          rol: phoneMatch.groups.rol?.trim() ?? null,
          telefoon: phoneMatch.groups.telefoon?.trim() ?? null,
        },
      ],
      jobPosting: null,
      labelBlock: {},
    };
  }
  return null;
};

const CIRCLE8_CONTACT_CARD_PATTERN =
  />\s*Contact\s*<\/span>\s*<a[^>]*href="\/people\/\d+-[^"]+"[^>]*>(?<naam>[^<]{1,120})<\/a>\s*<span[^>]*>(?<rol>[^<]{0,160})<\/span>/giu;

/**
 * werkenbij.circle8.nl (Teamtailor) detail pages publish a JobPosting JSON-LD
 * node plus a "Contact" card: the card's `/people/<id>-<slug>` anchor carries
 * the contact's naam and the trailing span their functietitel ("Corporate
 * Recruiter – HR"). The vacancy's own closing line ("neem dan contact op met
 * <naam> <titel> <telefoon>") carries the same person's direct number; it is
 * read only when anchored on the card's naam — the digit-free gap before the
 * number keeps it fail-closed, never free-mined. Returns contact-only
 * synthesis; the explicit JobPosting stays the vacancy source.
 */
export const synthesizeContactsFromCircle8Page = (
  html: string
): DetailSynthesis | null => {
  const contactpersonen: SourceContact[] = [];
  CIRCLE8_CONTACT_CARD_PATTERN.lastIndex = 0;
  let card = CIRCLE8_CONTACT_CARD_PATTERN.exec(html);
  while (card) {
    const naam = collapseWhitespace(
      decodeHtmlEntities(card.groups?.naam ?? "")
    );
    const rol = collapseWhitespace(decodeHtmlEntities(card.groups?.rol ?? ""));
    const telefoon = naam
      ? new RegExp(
          `contact op met\\s+${escapeRegExp(naam)}[^0-9+]{0,200}?(?<telefoon>\\+?\\d[\\d\\s()-]{7,20}\\d)`,
          "iu"
        ).exec(html)?.groups?.telefoon
      : undefined;
    mergeContact(contactpersonen, {
      naam,
      rol,
      telefoon: telefoon?.trim() ?? null,
    });
    card = CIRCLE8_CONTACT_CARD_PATTERN.exec(html);
  }
  return contactpersonen.length > 0
    ? { contactpersonen, jobPosting: null, labelBlock: {} }
    : null;
};

/** Depth-counted slice of the inner HTML of every `<div>` whose opening tag
 * starts with `marker`. Mirrors needstaffing's `extractBalancedDiv` — kept
 * local because the json-ld family shares this file, not that client. */
const sliceBalancedDivs = (html: string, marker: string): string[] => {
  const blocks: string[] = [];
  let from = 0;
  for (;;) {
    const start = html.indexOf(marker, from);
    if (start === -1) {
      return blocks;
    }
    const contentStart = start + marker.length;
    const tagPattern = /<\/?div\b[^>]*>/giu;
    tagPattern.lastIndex = contentStart;
    let depth = 1;
    let end = -1;
    let match = tagPattern.exec(html);
    while (match) {
      depth += match[0].startsWith("</") ? -1 : 1;
      if (depth === 0) {
        end = match.index;
        break;
      }
      match = tagPattern.exec(html);
    }
    if (end === -1) {
      return blocks;
    }
    blocks.push(html.slice(contentStart, end));
    from = end;
  }
};

const HAYS_JOBOWNER_PATTERN =
  /id="gtm_jobowner_name"[^>]*>(?<naam>[^<]{1,120})/iu;
const HAYS_TELEPHONE_PATTERN =
  /id="jd_telephone"[^>]*href="tel:(?<telefoon>[^"]{1,40})/iu;

/**
 * Hays detail pages publish a JobPosting JSON-LD node plus a "Spreek met
 * <strong id=gtm_jobowner_name>" consultant card whose phone sits in
 * `id="jd_telephone"` (confirmed live on three committed detail fixtures).
 * Returns contact-only synthesis; the explicit JobPosting stays the vacancy
 * source. `rol` reads "jobowner" — the source element's own name for the
 * contact's function.
 */
export const synthesizeContactsFromHaysPage = (
  html: string
): DetailSynthesis | null => {
  const naam = HAYS_JOBOWNER_PATTERN.exec(html)?.groups?.naam;
  const telefoon = HAYS_TELEPHONE_PATTERN.exec(html)?.groups?.telefoon;
  if (!(naam || telefoon)) {
    return null;
  }
  return {
    contactpersonen: [
      {
        naam: naam ? decodeHtmlEntities(naam).trim() : null,
        rol: naam ? "jobowner" : null,
        telefoon: telefoon?.trim() ?? null,
      },
    ],
    jobPosting: null,
    labelBlock: {},
  };
};

const RANDSTAD_CONTACTITEM_MARKER = '<div class="contactitem__container">';
const RANDSTAD_TEL_PATTERN = /href="tel:(?<telefoon>[^"]{1,40})/iu;
const RANDSTAD_MAILTO_PATTERN = /href="mailto:(?<email>[^"?]{1,120})/iu;

/**
 * Randstad detail pages publish a JobPosting JSON-LD node plus one or more
 * `contactitem__container` blocks — each holding a `contactblock_phonenumber`
 * tel: link and/or a `contactblock_email` mailto: link (the channel labels
 * come from the block's own `data-analytics-category`). No person name is
 * published in the block; it is a channel, so `naam`/`rol` stay null.
 * Returns contact-only synthesis; the explicit JobPosting stays the vacancy
 * source.
 */
export const synthesizeContactsFromRandstadPage = (
  html: string
): DetailSynthesis | null => {
  const contactpersonen: SourceContact[] = [];
  for (const block of sliceBalancedDivs(html, RANDSTAD_CONTACTITEM_MARKER)) {
    const email = RANDSTAD_MAILTO_PATTERN.exec(block)?.groups?.email?.trim();
    const telefoon = RANDSTAD_TEL_PATTERN.exec(block)?.groups?.telefoon?.trim();
    if (!(email || telefoon)) {
      continue;
    }
    if (
      contactpersonen.some(
        (entry) => entry.email === email && entry.telefoon === telefoon
      )
    ) {
      continue;
    }
    contactpersonen.push({ email: email ?? null, telefoon: telefoon ?? null });
  }
  return contactpersonen.length > 0
    ? { contactpersonen, jobPosting: null, labelBlock: {} }
    : null;
};

const RWS_CONTACT_MARKER = '<div class="contact-person">';
const RWS_NAME_PATTERN =
  /contact-person__body__text__name">(?<naam>[^<]{1,120})<\/span>/iu;
const RWS_ROLE_PATTERN =
  /contact-person__body__text__name">[^<]{1,120}<\/span>\s*\((?<rol>[^)]{1,120})\)/iu;
const RWS_TEL_PATTERN = /href="tel:(?<telefoon>[^"]{1,60})/iu;
const RWS_MAILTO_PATTERN = /href="mailto:(?<email>[^"?]{1,120})/iu;

/**
 * werkenbij.rijkswaterstaat.nl detail pages publish a JobPosting JSON-LD node
 * plus one `contact-person` block per contact (confirmed live: a procedure
 * contact and a content expert on the same page). The person's function sits
 * in parentheses directly after the name span when published ("(Expert
 * Vastgoed en Infrastructuur)"); the block's `<h2>` title is the question
 * topic, not a role, and is deliberately not read as `rol`. Returns
 * contact-only synthesis; the explicit JobPosting stays the vacancy source.
 */
export const synthesizeContactsFromRijkswaterstaatPage = (
  html: string
): DetailSynthesis | null => {
  const contactpersonen: SourceContact[] = [];
  for (const block of sliceBalancedDivs(html, RWS_CONTACT_MARKER)) {
    const naam = RWS_NAME_PATTERN.exec(block)?.groups?.naam;
    const rol = RWS_ROLE_PATTERN.exec(block)?.groups?.rol;
    const email = RWS_MAILTO_PATTERN.exec(block)?.groups?.email;
    const telefoon = RWS_TEL_PATTERN.exec(block)?.groups?.telefoon;
    if (!(naam || email || telefoon)) {
      continue;
    }
    mergeContact(contactpersonen, {
      email: email ? decodeHtmlEntities(email).trim() : null,
      naam: naam ? decodeHtmlEntities(naam).trim() : null,
      rol: rol ? decodeHtmlEntities(rol).trim() : null,
      telefoon: telefoon ? decodeHtmlEntities(telefoon).trim() : null,
    });
  }
  return contactpersonen.length > 0
    ? { contactpersonen, jobPosting: null, labelBlock: {} }
    : null;
};
