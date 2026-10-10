import { mkdir } from "node:fs/promises";
import path from "node:path";

/**
 * Deterministic, seeded synthetic corpus generator for the RJC-344 200k
 * SearchAdapter benchmark. Produces JSONL records matching the
 * `@ji/search` `SearchDocument` shape (see packages/search/src/types.ts),
 * except `laatstGezienOp` is serialised as an ISO string instead of a
 * `Date` (JSON has no Date type) — the benchmark corpus loader in
 * `benchmarks/search/run.ts` parses it back with `new Date(...)`.
 */

export const DEFAULT_DOCUMENT_COUNT = 200_000;
export const DEFAULT_SEED = 1337;
export const DEFAULT_OUT_PATH = "fixtures/search/benchmark-corpus.jsonl";

// A fixed reference instant keeps output byte-identical across runs —
// ponytail: Date.now() would break determinism, so every date is derived
// from the seed instead of wall-clock time.
const REFERENCE_TIMESTAMP_MS = Date.parse("2026-08-30T00:00:00.000Z");

export interface CorpusRecord {
  beschrijving: string;
  bronId: string;
  contracttype: string | null;
  id: string;
  laatstGezienOp: string;
  eindklantNaam: null;
  opdrachtgeverNaam: null;
  provincie: null;
  publicatiedatum: null;
  skills: [];
  tariefEenheid: null;
  urenPerWeekMax: null;
  urenPerWeekMin: null;
  werkvorm: null;
  locatieLand: string;
  status: "active" | "closed" | "stale" | "unknown";
  tariefMax: number | null;
  tariefMin: number | null;
  titel: string;
}

export interface GenerateCorpusOptions {
  documents?: number;
  seed?: number;
}

// mulberry32 — tiny deterministic PRNG, good enough for synthetic fixtures.
// ponytail: no dependency for this; a few lines of stdlib-grade math beats
// pulling in a seeded-random package for a benchmark fixture generator.
/* oxlint-disable no-bitwise -- mulberry32's mixing function is defined in terms of bit operations */
const mulberry32 = (seed: number) => {
  let state = seed >>> 0;
  return (): number => {
    state = (state + 0x6d_2b_79_f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
};
/* oxlint-enable no-bitwise */

const BRON_IDS = [
  "bron-msp-1",
  "bron-msp-2",
  "bron-tender-1",
  "bron-global-1",
  "bron-das-1",
];
const CONTRACTTYPES: (string | null)[] = ["detachering", "interim", null];
const STATUSES: CorpusRecord["status"][] = [
  "active",
  "active",
  "active",
  "active",
  "stale",
  "closed",
  "unknown",
];
const LOCATIE_LANDEN = ["NL", "NL", "BE"];

// Filler vocabulary — synthetic role/skill words with no bearing on the
// five profile queries, so match-rate math below stays predictable.
const FILLER_TITLES = [
  "backend developer",
  "frontend developer",
  "data engineer",
  "product manager",
  "qa engineer",
  "solutions architect",
  "site reliability engineer",
  "cloud engineer",
  "security engineer",
  "business analyst",
];
const FILLER_WORDS = [
  "fulltime",
  "remote",
  "hybride",
  "senior",
  "medior",
  "opdracht",
  "team",
  "project",
  "roadmap",
  "stakeholder",
  "cloud",
  "migratie",
  "onboarding",
  "release",
  "sprint",
];

// Independent inclusion probabilities for the terms the profile queries
// (benchmarks/search/profile.json) search on. Chosen so each query's
// modelled match rate lands in the 1-15% band asserted in
// generate-corpus.spec.ts — see the derivation in that spec file.
const TERM_PROBABILITY = {
  amsterdam: 0.15,
  azure: 0.08,
  consultant: 0.1,
  devopsEngineer: 0.1,
  intern: 0.1,
  java: 0.15,
  kubernetes: 0.15,
  platformEngineer: 0.06,
  scrum: 0.15,
  spring: 0.15,
  trainee: 0.1,
  utrecht: 0.1,
} as const;

const pick = <T>(rng: () => number, values: readonly T[]): T => {
  const value = values[Math.floor(rng() * values.length)];
  if (value === undefined) {
    throw new Error("pick() called with an empty values array");
  }
  return value;
};

const roll = (rng: () => number, probability: number): boolean =>
  rng() < probability;

export const generateCorpus = function* generateCorpus(
  options: GenerateCorpusOptions = {}
): Generator<CorpusRecord> {
  const documents = options.documents ?? DEFAULT_DOCUMENT_COUNT;
  const seed = options.seed ?? DEFAULT_SEED;
  const rng = mulberry32(seed);

  for (let index = 0; index < documents; index += 1) {
    const titleTerms: string[] = [];
    const descriptionTerms: string[] = [pick(rng, FILLER_TITLES)];

    if (roll(rng, TERM_PROBABILITY.azure)) {
      titleTerms.push("Azure");
    }
    if (roll(rng, TERM_PROBABILITY.platformEngineer)) {
      titleTerms.push("platform engineer");
    }
    if (roll(rng, TERM_PROBABILITY.devopsEngineer)) {
      titleTerms.push("devops engineer");
    }
    if (roll(rng, TERM_PROBABILITY.kubernetes)) {
      descriptionTerms.push("kubernetes");
    }
    if (roll(rng, TERM_PROBABILITY.java)) {
      descriptionTerms.push("java");
    }
    if (roll(rng, TERM_PROBABILITY.spring)) {
      descriptionTerms.push("spring");
    }
    if (roll(rng, TERM_PROBABILITY.trainee)) {
      descriptionTerms.push("trainee");
    }
    if (roll(rng, TERM_PROBABILITY.intern)) {
      descriptionTerms.push("intern");
    }
    if (roll(rng, TERM_PROBABILITY.amsterdam)) {
      descriptionTerms.push("Amsterdam");
    }
    if (roll(rng, TERM_PROBABILITY.utrecht)) {
      descriptionTerms.push("Utrecht");
    }
    if (roll(rng, TERM_PROBABILITY.scrum)) {
      descriptionTerms.push("scrum");
    }
    if (roll(rng, TERM_PROBABILITY.consultant)) {
      descriptionTerms.push("consultant");
    }

    const fillerCount = 2 + Math.floor(rng() * 4);
    for (let fillerIndex = 0; fillerIndex < fillerCount; fillerIndex += 1) {
      descriptionTerms.push(pick(rng, FILLER_WORDS));
    }

    const titel =
      titleTerms.length > 0
        ? `${titleTerms.join(" ")} ${pick(rng, FILLER_TITLES)}`
        : pick(rng, FILLER_TITLES);
    const beschrijving = descriptionTerms.join(" ");

    // Up to ~180 days old.
    const ageMs = Math.floor(rng() * 180) * 86_400_000;
    const tariefMin = 50 + Math.floor(rng() * 40);
    const tariefMax = tariefMin + 10 + Math.floor(rng() * 60);

    yield {
      beschrijving,
      bronId: pick(rng, BRON_IDS),
      contracttype: pick(rng, CONTRACTTYPES),
      eindklantNaam: null,
      id: `bench-doc-${index}`,
      laatstGezienOp: new Date(REFERENCE_TIMESTAMP_MS - ageMs).toISOString(),
      locatieLand: pick(rng, LOCATIE_LANDEN),
      opdrachtgeverNaam: null,
      provincie: null,
      publicatiedatum: null,
      skills: [],
      status: pick(rng, STATUSES),
      tariefEenheid: null,
      tariefMax,
      tariefMin,
      titel,
      urenPerWeekMax: null,
      urenPerWeekMin: null,
      werkvorm: null,
    };
  }
};

export const MAX_DOCUMENT_COUNT = 5_000_000;
// mulberry32's `seed >>> 0` silently wraps anything outside uint32 range —
// reject out-of-range/non-integer seeds here instead of wrapping silently.
// 2^32 - 1
export const MAX_SEED = 4_294_967_295;

const parseNonNegativeInteger = (
  raw: string | undefined,
  flagName: string,
  fallback: number,
  max: number
): number => {
  if (raw === undefined) {
    return fallback;
  }
  if (!/^\d+$/u.test(raw)) {
    throw new Error(
      `--${flagName} must be a non-negative integer, got ${JSON.stringify(raw)}`
    );
  }
  const value = Number(raw);
  if (value > max) {
    throw new Error(`--${flagName} must be <= ${max}, got ${value}`);
  }
  return value;
};

export const parseArgs = (argv: string[]) => {
  const flag = (name: string): string | undefined => {
    const index = argv.indexOf(`--${name}`);
    return index === -1 ? undefined : argv[index + 1];
  };

  const documents = parseNonNegativeInteger(
    flag("documents"),
    "documents",
    DEFAULT_DOCUMENT_COUNT,
    MAX_DOCUMENT_COUNT
  );
  const seed = parseNonNegativeInteger(
    flag("seed"),
    "seed",
    DEFAULT_SEED,
    MAX_SEED
  );
  const outRaw = flag("out");

  return {
    documents,
    out: outRaw ?? DEFAULT_OUT_PATH,
    seed,
  } satisfies { documents: number; out: string; seed: number };
};

const main = async (): Promise<void> => {
  const { documents, out, seed } = parseArgs(process.argv.slice(2));
  const outPath = path.resolve(process.cwd(), out);
  await mkdir(path.dirname(outPath), { recursive: true });

  const lines: string[] = [];
  for (const record of generateCorpus({ documents, seed })) {
    lines.push(JSON.stringify(record));
  }
  await Bun.write(outPath, lines.length > 0 ? `${lines.join("\n")}\n` : "");

  console.log(JSON.stringify({ documents, out: outPath, seed }, null, 2));
};

if (import.meta.main) {
  await main();
}
