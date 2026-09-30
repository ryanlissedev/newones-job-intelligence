import path from "node:path";

import { resolveCanonicalContractType } from "@ji/application/normalise";
import type {
  JsonValue,
  NormalisedAanvraagDraft,
} from "@ji/application/normalise";
import { SOURCES, SUPPORTED_BRON_SLUGS } from "@ji/application/sources";
import type { SourceDefinition } from "@ji/application/sources";
import * as jsonLd from "@ji/connectors/json-ld";
import type { JsonLdConnectorConfig } from "@ji/connectors/json-ld";
import { readAanvraagBronFacts } from "@ji/db/aanvraag-read-mapping";
import { CLEARED, UNKNOWN } from "@ji/domain";

/**
 * Field-coverage audit: replays every source's committed fixtures through its
 * real connector + normaliser and reports which detail-page fields land per
 * bron. Read-only; writes nothing.
 *
 * Usage: bun run scripts/field-coverage.ts [--bron <slug>] [--json]
 */

export const FIELDS = [
  "organisatie",
  "locatie",
  "tarief",
  "contract",
  "werkvorm",
  "gepubliceerd",
  "sluit",
  "uren",
  "opleiding",
  "startdatum",
  "einddatum",
  "duur",
  "provincie",
  "skills",
] as const;

export type FieldName = (typeof FIELDS)[number];

/** Mapping from canonical detail-page field to the bronSpecifiek keys that
 * can land it. Empty arrays mean the field is driven by top-level
 * NormalisedAanvraagDraft fields only. */
export const FIELD_KEY_ALIASES = {
  contract: ["contracttype", "contract_type", "employment_type"],
  duur: ["duration", "duur", "looptijd_tekst", "periode", "verwachte_duur"],
  einddatum: ["eind_datum", "eindDatum"],
  gepubliceerd: [
    "publicatiedatum",
    "gepubliceerd_op",
    "publicatie_datum",
    "json_ld_date_posted",
  ],
  locatie: [],
  opleiding: ["opleidingsniveau", "education_level"],
  organisatie: ["opdrachtgever_naam", "opdrachtgeverNaam"],
  provincie: ["provincie"],
  skills: ["skills"],
  sluit: [],
  startdatum: ["start_datum", "startDatum"],
  tarief: [],
  uren: ["uren_per_week", "uren_per_week_raw"],
  werkvorm: ["werkvorm"],
} as const satisfies Record<FieldName, readonly string[]>;

/* oxlint-disable anti-slop/no-unknown-parameters, anti-slop/no-runtime-typeof -- these guards are the script's own I/O boundary: bronSpecifiek is a free-form JsonValue map whose shape is established here before any field evaluation reads it. */
const isRecord = (value: unknown): value is Record<string, JsonValue> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** A bronSpecifiek scalar counts as "field landed" when it is a non-zero
 * number or a non-blank, non-sentinel string. */
const isLiveValue = (value: unknown): value is number | string =>
  (typeof value === "number" && value !== 0) ||
  (typeof value === "string" &&
    value.trim() !== "" &&
    value !== UNKNOWN &&
    value !== CLEARED);

/** Blank or sentinel string keys do not count toward key coverage. */
const isBlankText = (value: unknown): value is string =>
  typeof value === "string" &&
  (value.trim() === "" || value === UNKNOWN || value === CLEARED);

const liveText = (
  record: Record<string, JsonValue>,
  keys: readonly string[]
): boolean => keys.some((key) => isLiveValue(record[key]));

const draftText = (value: string): boolean =>
  value.trim() !== "" && value !== UNKNOWN && value !== CLEARED;

const tariefBound = (v: string): boolean =>
  v !== UNKNOWN && v !== CLEARED && v.trim() !== "";

/**
 * The contract field only reaches the UI when the source value maps to one
 * of the canonical contract forms. Mirrors the canonicalisation used by
 * curation/read path so coverage counts reflect actual displayed values.
 */
export const evaluateContractCoverage = (
  bron: Record<string, JsonValue>
): boolean => {
  const text = (key: string): string | null => {
    const value = bron[key];
    return typeof value === "string" && value.trim() !== "" ? value : null;
  };
  return (
    resolveCanonicalContractType(
      text("contracttype"),
      text("contract_type"),
      text("employment_type")
    ) !== null
  );
};

/**
 * The publication-date field only reaches the UI when the value parses as a
 * valid date. Mirrors the validation used by `readAanvraagBronFacts`.
 */
export const evaluatePublicationDateCoverage = (
  bron: Record<string, JsonValue>
): boolean => readAanvraagBronFacts(bron).publicatiedatum !== null;

/**
 * The province field only reaches the UI when the value is one of the twelve
 * canonical Dutch province names. Mirrors the validation used by
 * `readAanvraagBronFacts`.
 */
export const evaluateProvinceCoverage = (
  bron: Record<string, JsonValue>
): boolean => readAanvraagBronFacts(bron).provincie !== null;

/**
 * The skills field only reaches the UI when normalisation yields at least one
 * valid skill. Mirrors the shaping done by `readAanvraagBronFacts`.
 */
export const evaluateSkillsCoverage = (
  bron: Record<string, JsonValue>
): boolean => readAanvraagBronFacts(bron).skills.length > 0;

const evaluateDraft = (draft: NormalisedAanvraagDraft) => {
  const bronValue = draft.bronSpecifiek.value;
  const bron: Record<string, JsonValue> = isRecord(bronValue) ? bronValue : {};
  return {
    contract: evaluateContractCoverage(bron),
    duur: liveText(bron, FIELD_KEY_ALIASES.duur),
    einddatum: liveText(bron, FIELD_KEY_ALIASES.einddatum),
    gepubliceerd: evaluatePublicationDateCoverage(bron),
    locatie: draftText(draft.locatieTekst.value),
    opleiding: liveText(bron, FIELD_KEY_ALIASES.opleiding),
    organisatie:
      draftText(draft.opdrachtgeverNaam.value) ||
      liveText(bron, FIELD_KEY_ALIASES.organisatie),
    provincie: evaluateProvinceCoverage(bron),
    skills: evaluateSkillsCoverage(bron),
    sluit: draft.sluitingsdatum !== undefined,
    startdatum:
      draftText(draft.startDatum.value) ||
      liveText(bron, FIELD_KEY_ALIASES.startdatum),
    tarief:
      tariefBound(draft.tarief.min) ||
      tariefBound(draft.tarief.max) ||
      tariefBound(draft.tarief.eenheid),
    uren: liveText(bron, FIELD_KEY_ALIASES.uren),
    werkvorm: liveText(bron, FIELD_KEY_ALIASES.werkvorm),
  };
};

const KEY_DENYLIST = new Set(["_cleared", "label_block"]);

const bronKeysPresent = (draft: NormalisedAanvraagDraft): string[] => {
  const bron = draft.bronSpecifiek.value;
  if (!isRecord(bron)) {
    return [];
  }
  return Object.entries(bron)
    .filter(([key, value]) => {
      if (KEY_DENYLIST.has(key) || value === null || isBlankText(value)) {
        return false;
      }
      if (Array.isArray(value)) {
        return value.length > 0;
      }
      return true;
    })
    .map(([key]) => key)
    .toSorted();
};

export interface SourceReport {
  bronId: string;
  errors: string[];
  fields: Record<FieldName, number>;
  keys: Record<string, number>;
  records: number;
  rejected: number;
  /** Discovered detail URLs skipped because no detail fixture is committed
   * for them (CTP-647): the listing fixture stays the real recording, but
   * replay only enumerates the detail-backed slice. */
  skippedDetails: number;
  slug: string;
}

/** CTP-647: every exported json-ld config, keyed by slug, so the audit can
 * scope replay to URLs with a committed detail fixture instead of erroring
 * on each unrecorded listing entry. */
const JSON_LD_CONFIGS = new Map<string, JsonLdConnectorConfig>(
  Object.values(jsonLd)
    .filter(
      (value): value is JsonLdConnectorConfig =>
        isRecord(value) &&
        typeof value["slug"] === "string" &&
        "discovery" in value
    )
    .map((config) => [config.slug, config])
);

const auditSource = async (source: SourceDefinition): Promise<SourceReport> => {
  const report: SourceReport = {
    bronId: source.bronId,
    errors: [],
    // SAFETY: FIELDS is the literal tuple behind FieldName, so fromEntries
    // produces exactly one entry per FieldName key.
    fields: Object.fromEntries(FIELDS.map((f) => [f, 0])) as Record<
      FieldName,
      number
    >,
    keys: {},
    records: 0,
    rejected: 0,
    skippedDetails: 0,
    slug: source.slug,
  };
  const listingFixturePath = path.join(source.slug, "listing-page-0.json");
  // CTP-647: json-ld sources replay with `onMissingDetailFixture: "skip"` so
  // a listing fixture that names hundreds of detail URLs only enumerates the
  // ones with a committed detail fixture. The connector is built directly —
  // same wiring as `source.createConnector`'s fixture branch — because the
  // `CreateSourceConnectorInput` seam does not carry the skip flag.
  const jsonLdConfig = JSON_LD_CONFIGS.get(source.slug);
  const connector =
    jsonLdConfig === undefined
      ? source.createConnector({
          bronId: source.bronId,
          listingFixturePath,
          live: false,
          runKind: "test",
        })
      : jsonLd.createJsonLdConnector({
          bronId: source.bronId,
          client: jsonLd.createJsonLdClient({
            config: jsonLdConfig,
            listingFixturePath,
            liveEnabled: false,
            onMissingDetailFixture: "skip",
          }),
          config: jsonLdConfig,
        });

  const items: {
    bronReferentie: string;
    contentHash: string;
    listingPayload?: unknown;
  }[] = [];
  let checkpoint: Parameters<typeof connector.discover>[0] = null;
  // CTP-624: paged connectors (sitemap-index batchSize) emit their corpus over
  // many pages, so the audit follows hasMore to exhaustion. The bound exists
  // only to catch a connector that never stops paging — hitting it is an
  // error, not a silent truncation.
  const maxDiscoveryPages = 500;
  let exhausted = false;
  try {
    for (let page = 0; page < maxDiscoveryPages; page += 1) {
      // oxlint-disable-next-line no-await-in-loop -- discovery is checkpoint-dependent: each page needs the previous discover() checkpoint.
      const result = await connector.discover(checkpoint);
      items.push(...result.items);
      if (!result.hasMore) {
        exhausted = true;
        break;
      }
      ({ checkpoint } = result);
    }
    if (!exhausted) {
      report.errors.push(
        `discover: still hasMore after ${maxDiscoveryPages} pages`
      );
    }
  } catch (error) {
    // A malformed listing fixture reports as a source error instead of
    // dropping the source from the report table entirely.
    report.errors.push(
      `discover: ${error instanceof Error ? error.message : String(error)}`
    );
  }

  for (const item of items) {
    let fetched: Awaited<ReturnType<typeof connector.fetch>>;
    try {
      // oxlint-disable-next-line no-await-in-loop -- fixture fetches replay sequentially so errors map to the item being processed.
      fetched = await connector.fetch(item);
    } catch (error) {
      report.errors.push(
        `fetch ${item.bronReferentie}: ${error instanceof Error ? error.message : String(error)}`
      );
      continue;
    }
    if (!fetched) {
      // A null fetch is a replay-scope skip (no committed detail fixture);
      // known-hash skips cannot occur here because no store is passed.
      report.skippedDetails += 1;
      continue;
    }
    if (fetched.status === "rejected") {
      report.rejected += 1;
      continue;
    }
    try {
      const draft = source.normalise(fetched.body, fetched.contentHash);
      report.records += 1;
      const coverage = evaluateDraft(draft);
      for (const field of FIELDS) {
        if (coverage[field]) {
          report.fields[field] += 1;
        }
      }
      for (const key of bronKeysPresent(draft)) {
        report.keys[key] = (report.keys[key] ?? 0) + 1;
      }
    } catch (error) {
      report.errors.push(
        `${item.bronReferentie}: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }
  return report;
};

const CELL_WIDTH = 4;

const printTable = (reports: readonly SourceReport[]): void => {
  const header = [
    "bron".padEnd(24),
    "n".padStart(3),
    ...FIELDS.map((f) => f.slice(0, 3).padStart(CELL_WIDTH)),
  ].join(" ");
  console.log(header);
  console.log("-".repeat(header.length));
  for (const report of reports) {
    const cells = FIELDS.map((field) => {
      const count = report.fields[field];
      let mark = `${count}`;
      if (report.records === 0) {
        mark = "·";
      } else if (count === report.records) {
        mark = "✓";
      } else if (count === 0) {
        mark = "✗";
      }
      return mark.padStart(CELL_WIDTH);
    });
    console.log(
      [
        report.slug.padEnd(24),
        String(report.records).padStart(3),
        ...cells,
      ].join(" ")
    );
  }
  console.log(
    `\nvelden: ${FIELDS.map((f) => `${f.slice(0, 3)}=${f}`).join("  ")}`
  );
};

const printDetails = (reports: readonly SourceReport[]): void => {
  for (const report of reports) {
    console.log(
      `\n== ${report.slug} (${report.records} records, ${report.rejected} rejected, ${report.skippedDetails} skipped: no detail fixture)`
    );
    const keys = Object.entries(report.keys).toSorted((a, b) =>
      a[0].localeCompare(b[0])
    );
    console.log(
      `   bronSpecifiek keys: ${keys.map(([k, n]) => `${k}×${n}`).join(", ") || "(none)"}`
    );
    for (const error of report.errors) {
      console.log(`   ERROR ${error}`);
    }
  }
};

export interface CliArgs {
  asJson: boolean;
  bron?: string;
}

/**
 * Strict CLI parser shared by the field-coverage and source-to-ui-gap
 * scripts: `--json`, `--bron <slug>` at most once, anything else throws so a
 * typo never silently audits every source.
 */
export const parseArgs = (args: readonly string[]): CliArgs => {
  let bron: string | undefined;
  let asJson = false;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--json") {
      asJson = true;
      continue;
    }
    if (arg === "--bron") {
      const value = args[index + 1];
      if (!value || value.startsWith("--")) {
        throw new Error("--bron requires a source slug");
      }
      if (bron !== undefined) {
        throw new Error("--bron may only be provided once");
      }
      bron = value;
      index += 1;
      continue;
    }
    throw new Error(`unknown argument: ${arg}`);
  }
  return { asJson, bron };
};

/**
 * Replay the committed fixtures of the given bron slugs (default: every
 * supported bron) and return one report per source. Throws on an unknown
 * slug; a source whose audit itself fails is reported on stderr and skipped,
 * matching the CLI's historical behaviour.
 */
export const replaySources = async (
  slugs: readonly string[] = SUPPORTED_BRON_SLUGS
): Promise<SourceReport[]> => {
  const reports: SourceReport[] = [];
  for (const slug of slugs) {
    // SAFETY: SOURCES is keyed by bron slug; the guard below rejects unknown slugs.
    const source = (SOURCES as Record<string, SourceDefinition>)[slug];
    if (!source) {
      throw new Error(`unknown bron slug: ${slug}`);
    }
    try {
      // oxlint-disable-next-line no-await-in-loop -- sources audit sequentially so report order matches the slug order.
      reports.push(await auditSource(source));
    } catch (error) {
      console.error(
        `== ${slug}: audit failed: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }
  return reports;
};

if (import.meta.main) {
  try {
    const { asJson, bron } = parseArgs(process.argv.slice(2));
    const reports = await replaySources(bron ? [bron] : undefined);
    if (asJson) {
      console.log(JSON.stringify(reports, null, 2));
    } else {
      printTable(reports);
      printDetails(reports);
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
