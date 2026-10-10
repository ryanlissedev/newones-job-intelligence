/**
 * Builds the experiment corpus: every connector fixture under
 * fixtures/connectors/ replayed through the REAL connectors and normalisers
 * (same path scripts/replay-run.ts uses), dumped as corpus.json.
 *
 * Run from the repo root with bun so @ji/* workspace resolution and the
 * connectors' fixture-path resolution both work:
 *   bun run experiments/convex-search/build-corpus.ts
 */
import { writeFile } from "node:fs/promises";
import path from "node:path";

// Relative imports: experiments/ is deliberately not a workspace member, so
// @ji/* specifiers do not resolve from here. Importing the source files
// directly still routes through the real registry and normalisers.
import type { NormalisedAanvraagDraft } from "../../packages/application/src/normalise/types";
import {
  SOURCES,
  SUPPORTED_BRON_SLUGS,
} from "../../packages/application/src/sources/index";
import { UNKNOWN } from "../../packages/domain/src/unknown";

export interface CorpusDocument {
  beschrijving: string;
  bronId: string;
  contracttype: string;
  documentId: string;
  laatstGezienOp: number;
  locatieLand: string;
  status: string;
  tariefMax: number;
  tariefMin: number;
  titel: string;
  zoektekst: string;
}

const toNumber = (value: string | typeof UNKNOWN): number => {
  if (value === UNKNOWN) {
    return 0;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
};

const toDocument = (
  slug: keyof typeof SOURCES,
  draft: NormalisedAanvraagDraft
): CorpusDocument => ({
  beschrijving: draft.beschrijving.value,
  bronId: SOURCES[slug].bronId,
  // The draft has no contracttype (it comes from the canonical row later in
  // the real pipeline). UNKNOWN is the codebase's honest missing-value
  // convention — do not invent one.
  contracttype: "UNKNOWN",
  documentId: `${slug}:${draft.bronReferentie.value}`,
  // Experiment timestamp, not source data: drafts carry no laatst_gezien_op.
  laatstGezienOp: Math.floor(Date.now() / 1000),
  locatieLand: draft.locatieLand.value,
  status: draft.status,
  tariefMax: toNumber(draft.tarief.max),
  tariefMin: toNumber(draft.tarief.min),
  titel: draft.titel.value,
  zoektekst: `${draft.titel.value} ${draft.beschrijving.value}`,
});

const MAX_PAGES = 20;

const main = async (): Promise<void> => {
  const documents: CorpusDocument[] = [];
  const perSource: Record<string, number> = {};

  for (const slug of SUPPORTED_BRON_SLUGS) {
    const source = SOURCES[slug];
    const connector = source.createConnector({
      bronId: source.bronId,
      listingFixturePath: `${slug}/listing-page-0.json`,
      live: false,
      runKind: "test",
    });

    let checkpoint = null;
    let count = 0;
    for (let page = 0; page < MAX_PAGES; page += 1) {
      // oxlint-disable-next-line no-await-in-loop -- sequential pagination
      const discovered = await connector.discover(checkpoint);
      for (const item of discovered.items) {
        // oxlint-disable-next-line no-await-in-loop -- fixture reads, sequential is fine
        const fetched = await connector.fetch(item);
        if (!fetched || fetched.status !== "fetched") {
          continue;
        }
        const draft = source.normalise(fetched.body, fetched.contentHash);
        documents.push(toDocument(slug, draft));
        count += 1;
      }
      if (!discovered.hasMore) {
        break;
      }
      ({ checkpoint } = discovered);
    }
    perSource[slug] = count;
  }

  const outPath = path.join(
    process.cwd(),
    "experiments/convex-search/corpus.json"
  );
  await writeFile(outPath, JSON.stringify(documents, null, 1));
  console.log(JSON.stringify({ perSource, total: documents.length }, null, 2));
};

await main();
