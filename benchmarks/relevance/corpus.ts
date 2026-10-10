import { SOURCES, SUPPORTED_BRON_SLUGS } from "@ji/application/sources";
import type { SupportedBronSlug } from "@ji/application/sources";
import type { ConnectorCheckpoint } from "@ji/connectors";
import { isUnknown } from "@ji/domain";
import type { SearchDocument } from "@ji/search";
import { z } from "zod";

/**
 * Loads the golden relevance corpus: every real capture fixture under
 * `fixtures/connectors/` run through its source's real connector (fixture
 * mode) and real normaliser — the same discover → fetch → normalise path
 * `executeBronRun` uses for live polling. No synthetic documents; the
 * corpus is exactly what the product would index from those captures
 * (deliberately NOT the meaningless `benchmarks/search` filler corpus).
 *
 * The corpus is small (tens of documents, one listing capture per source).
 * To grow it, swap `loadRelevanceCorpus` for a loader over a larger real
 * dump (e.g. the Motian backfill) — the runner only consumes
 * `RelevanceCorpusDocument[]`, so nothing else changes.
 */

/** Fixed so two runs on the same fixtures index byte-identical documents. */
const CORPUS_SEEN_AT = new Date("2026-08-31T00:00:00.000Z");

const MAX_DISCOVER_PAGES = 10;

const bronSpecifiekContracttypeSchema = z.object({
  contracttype: z.string().optional(),
});

export interface RelevanceCorpusDocument {
  document: SearchDocument;
  /** Stable human-readable id used in queries.jsonl judgments. */
  id: string;
  slug: SupportedBronSlug;
}

export interface RelevanceCorpusSummary {
  documents: RelevanceCorpusDocument[];
  /** Items a connector rejected or whose detail fixture is absent — counted,
   * never silently dropped. */
  skipped: { id: string; reason: string }[];
}

const tariefToNumber = (value: string): number | null =>
  isUnknown(value) ? null : Number(value);

const loadSourceDocuments = async (
  slug: SupportedBronSlug
): Promise<RelevanceCorpusSummary> => {
  const source = SOURCES[slug];
  const connector = source.createConnector({
    bronId: source.bronId,
    listingFixturePath: `${slug}/listing-page-0.json`,
    live: false,
    runKind: "test",
  });

  const documents: RelevanceCorpusDocument[] = [];
  const skipped: RelevanceCorpusSummary["skipped"] = [];

  let checkpoint: ConnectorCheckpoint | null = null;
  for (let page = 0; page < MAX_DISCOVER_PAGES; page += 1) {
    // oxlint-disable-next-line no-await-in-loop -- pages are sequential by contract (checkpoint chaining)
    const discovered = await connector.discover(checkpoint);
    for (const item of discovered.items) {
      const id = `${slug}:${item.bronReferentie}`;
      let fetched = null;
      try {
        // oxlint-disable-next-line no-await-in-loop -- fixture reads are cheap; sequential keeps output order stable
        fetched = await connector.fetch(item);
      } catch (error) {
        // A listing can reference more records than there are detail
        // fixtures on disk (fixtures capture a sample, not the site).
        skipped.push({
          id,
          reason: error instanceof Error ? error.message : "fetch failed",
        });
        continue;
      }
      if (fetched === null) {
        skipped.push({ id, reason: "known-hash skip" });
        continue;
      }
      if (fetched.status === "rejected") {
        skipped.push({ id, reason: fetched.reason });
        continue;
      }
      const draft = source.normalise(fetched.body, fetched.contentHash);
      const bronSpecifiek = bronSpecifiekContracttypeSchema.safeParse(
        draft.bronSpecifiek.value
      );
      documents.push({
        document: {
          beschrijving: draft.beschrijving.value,
          bronId: source.bronId,
          contracttype: bronSpecifiek.success
            ? (bronSpecifiek.data.contracttype ?? null)
            : null,
          eindklantNaam: null,
          id,
          laatstGezienOp: CORPUS_SEEN_AT,
          locatieLand: draft.locatieLand.value,
          opdrachtgeverNaam: null,
          provincie: null,
          publicatiedatum: null,
          skills: [],
          status: draft.status,
          tariefEenheid: null,
          tariefMax: tariefToNumber(draft.tarief.max),
          tariefMin: tariefToNumber(draft.tarief.min),
          titel: draft.titel.value,
          urenPerWeekMax: null,
          urenPerWeekMin: null,
          werkvorm: null,
        },
        id,
        slug,
      });
    }
    if (!discovered.hasMore) {
      break;
    }
    ({ checkpoint } = discovered);
  }

  return { documents, skipped };
};

export const loadRelevanceCorpus =
  async (): Promise<RelevanceCorpusSummary> => {
    const documents: RelevanceCorpusDocument[] = [];
    const skipped: RelevanceCorpusSummary["skipped"] = [];
    for (const slug of SUPPORTED_BRON_SLUGS) {
      // oxlint-disable-next-line no-await-in-loop -- deterministic corpus order matters more than load speed here
      const summary = await loadSourceDocuments(slug);
      documents.push(...summary.documents);
      skipped.push(...summary.skipped);
    }
    documents.sort((left, right) => left.id.localeCompare(right.id));
    skipped.sort((left, right) => left.id.localeCompare(right.id));
    return { documents, skipped };
  };
