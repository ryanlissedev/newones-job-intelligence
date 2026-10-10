import type { PublicBronView } from "@ji/application/bronnen";
import {
  createSliceARegistry,
  createTestSliceADeps,
  permissionsForRole,
} from "@ji/application/registry";
import { SearchAdapter } from "@ji/search";
import type {
  SearchDocument,
  SearchEngine,
  SearchIndexBatch,
  SearchIndexBatchResult,
  SearchVersion,
} from "@ji/search";
import { Hono } from "hono";
import { cors } from "hono/cors";

import {
  createRestCapabilityHandler,
  restRoutesFromRegistry,
} from "../../apps/server/src/capabilities/rest";
import type {
  EngineSearchParams,
  SearchEngineResult,
} from "../../packages/search/src/types";

const API_PORT = 3100;
const WEB_ORIGIN = "http://localhost:3001";
const BRON_ID = "00000000-0000-4000-8000-000000000001";
const LIVE_CATALOG_BRON_ID = "00000000-0000-4000-8000-000000000002";
const HISTORICAL_BRON_ID = "00000000-0000-4000-8000-000000000003";
const SCRAPE_RUN_ID = "00000000-0000-4000-8000-000000000020";
const DETAIL_END_MARKER = "SYNTHETIC_DETAIL_END_MARKER_CTP_492";
const MONTH_RATE_ID = "00000000-0000-4000-8000-000000000106";
const DAY_RATE_ID = "00000000-0000-4000-8000-000000000107";
const UNKNOWN_PERIOD_RATE_ID = "00000000-0000-4000-8000-000000000108";
const MIN_ONLY_RATE_ID = "00000000-0000-4000-8000-000000000109";

const longDetailDescription = [
  "SYNTHETIC detailtekst voor de browseraudit van de volledige REST-aanvraag.",
  "Deze brongetrouwe tekst is bewust langer dan de zoekresultaat-preview zodat de detailweergave de volledige payload moet tonen.",
  "De inhoud bevat alleen testgegevens en geen productieaanvraag, persoonsgegevens of externe bronpayload.",
  "De actieve catalogusbron heeft een label dat uitsluitend via het bronregister naar de UI mag komen.",
  "Elke zin maakt de lengtecontrole robuust tegen een onbedoelde server-side samenvatting of afkapping in de clientadapter.",
  "De zichtbare eindmarkering bewijst dat de tekst tot het einde van de full-detail respons in het detailpaneel staat.",
  DETAIL_END_MARKER,
].join(" ");

const syntheticBronnen: readonly PublicBronView[] = [
  {
    actief: true,
    bronId: BRON_ID,
    crawlDelayMs: 0,
    hasSecretRef: false,
    interval: "0 * * * *",
    lastRun: null,
    loginVereist: false,
    mappingRef: null,
    method: "json-api",
    naam: "TenderNed",
    rateLimitPerMinute: 1,
    retentionDays: 90,
    status: "ready",
    voorwaardenStatus: "toegestaan",
  },
  {
    actief: true,
    bronId: LIVE_CATALOG_BRON_ID,
    crawlDelayMs: 0,
    hasSecretRef: false,
    interval: "0 * * * *",
    lastRun: null,
    loginVereist: false,
    mappingRef: null,
    method: "json-api",
    naam: "SYNTHETIC Catalogus Live",
    rateLimitPerMinute: 1,
    retentionDays: 90,
    status: "ready",
    voorwaardenStatus: "toegestaan",
  },
  {
    actief: false,
    bronId: HISTORICAL_BRON_ID,
    crawlDelayMs: 0,
    hasSecretRef: false,
    interval: "0 * * * *",
    lastRun: null,
    loginVereist: false,
    mappingRef: null,
    method: "json-api",
    naam: "SYNTHETIC Historisch Archief",
    rateLimitPerMinute: 1,
    retentionDays: 90,
    status: "ready",
    voorwaardenStatus: "toegestaan",
  },
];

const commaJob: SearchDocument = {
  beschrijving:
    "Platformopdracht in Amsterdam, Noord-Holland met brongetrouwe onbekende velden.",
  bronId: BRON_ID,
  contracttype: null,
  eindklantNaam: null,
  id: "00000000-0000-4000-8000-000000000101",
  laatstGezienOp: new Date("2026-09-04T09:00:00.000Z"),
  locatie: "Amsterdam, Noord-Holland",
  locatieLand: "NL",
  opdrachtgeverNaam: null,
  provincie: null,
  publicatiedatum: null,
  skills: [],
  status: "active",
  tariefEenheid: null,
  tariefMax: 110,
  tariefMin: 90,
  titel: "Amsterdam, Noord-Holland platformopdracht",
  urenPerWeekMax: null,
  urenPerWeekMin: null,
  werkvorm: null,
};

const timeoutJob: SearchDocument = {
  beschrijving: "Timeout bewijsrecord met een gedeeltelijk zoekresultaat.",
  bronId: BRON_ID,
  contracttype: null,
  eindklantNaam: null,
  id: "00000000-0000-4000-8000-000000000102",
  laatstGezienOp: new Date("2026-09-04T10:00:00.000Z"),
  locatie: "Utrecht",
  locatieLand: "NL",
  opdrachtgeverNaam: null,
  provincie: null,
  publicatiedatum: null,
  skills: [],
  status: "active",
  tariefEenheid: null,
  tariefMax: null,
  tariefMin: null,
  titel: "Timeout platformopdracht",
  urenPerWeekMax: null,
  urenPerWeekMin: null,
  werkvorm: null,
};

const unknownFieldsJob: SearchDocument = {
  beschrijving: "Record zonder gepubliceerde commerciële brongegevens.",
  bronId: BRON_ID,
  contracttype: null,
  eindklantNaam: null,
  id: "00000000-0000-4000-8000-000000000103",
  laatstGezienOp: new Date("2026-09-04T11:00:00.000Z"),
  locatieLand: "NL",
  opdrachtgeverNaam: null,
  provincie: null,
  publicatiedatum: null,
  skills: [],
  status: "active",
  tariefEenheid: null,
  tariefMax: null,
  tariefMin: null,
  titel: "Brongetrouwe onbekende velden",
  urenPerWeekMax: null,
  urenPerWeekMin: null,
  werkvorm: null,
};

const longDetailJob: SearchDocument = {
  beschrijving: longDetailDescription,
  bronId: LIVE_CATALOG_BRON_ID,
  contracttype: "interim",
  eindklantNaam: null,
  id: "00000000-0000-4000-8000-000000000104",
  laatstGezienOp: new Date("2026-09-04T12:00:00.000Z"),
  locatie: "Den Haag",
  locatieLand: "NL",
  opdrachtgeverNaam: null,
  provincie: null,
  publicatiedatum: null,
  skills: [],
  status: "active",
  tariefEenheid: null,
  tariefMax: 125,
  tariefMin: 100,
  titel: "SYNTHETIC volledige detailopdracht",
  urenPerWeekMax: null,
  urenPerWeekMin: null,
  werkvorm: null,
};

const archivedJob: SearchDocument = {
  beschrijving:
    "SYNTHETIC gesloten archiefrecord van een inactieve historische bron.",
  bronId: HISTORICAL_BRON_ID,
  contracttype: "interim",
  eindklantNaam: null,
  id: "00000000-0000-4000-8000-000000000105",
  laatstGezienOp: new Date("2026-09-04T13:00:00.000Z"),
  locatie: "Rotterdam",
  locatieLand: "NL",
  opdrachtgeverNaam: null,
  provincie: null,
  publicatiedatum: null,
  skills: [],
  status: "closed",
  tariefEenheid: null,
  tariefMax: null,
  tariefMin: null,
  titel: "SYNTHETIC gesloten archiefopdracht",
  urenPerWeekMax: null,
  urenPerWeekMin: null,
  werkvorm: null,
};

const monthRateJob: SearchDocument = {
  beschrijving: "SYNTHETIC maandtarief met EUR min en max.",
  bronId: BRON_ID,
  contracttype: null,
  eindklantNaam: null,
  id: MONTH_RATE_ID,
  laatstGezienOp: new Date("2026-09-04T14:00:00.000Z"),
  locatie: "Eindhoven",
  locatieLand: "NL",
  opdrachtgeverNaam: null,
  provincie: null,
  publicatiedatum: null,
  skills: [],
  status: "active",
  tariefEenheid: null,
  tariefMax: 6000,
  tariefMin: 4000,
  titel: "SYNTHETIC maandtarief",
  urenPerWeekMax: null,
  urenPerWeekMin: null,
  werkvorm: null,
};

const dayRateJob: SearchDocument = {
  beschrijving: "SYNTHETIC dagtarief met EUR min en max.",
  bronId: BRON_ID,
  contracttype: null,
  eindklantNaam: null,
  id: DAY_RATE_ID,
  laatstGezienOp: new Date("2026-09-04T15:00:00.000Z"),
  locatie: "Groningen",
  locatieLand: "NL",
  opdrachtgeverNaam: null,
  provincie: null,
  publicatiedatum: null,
  skills: [],
  status: "active",
  tariefEenheid: null,
  tariefMax: 750,
  tariefMin: 500,
  titel: "SYNTHETIC dagtarief",
  urenPerWeekMax: null,
  urenPerWeekMin: null,
  werkvorm: null,
};

const unknownPeriodRateJob: SearchDocument = {
  beschrijving: "SYNTHETIC EUR-tarief zonder gepubliceerde periode.",
  bronId: BRON_ID,
  contracttype: null,
  eindklantNaam: null,
  id: UNKNOWN_PERIOD_RATE_ID,
  laatstGezienOp: new Date("2026-09-04T16:00:00.000Z"),
  locatie: "Breda",
  locatieLand: "NL",
  opdrachtgeverNaam: null,
  provincie: null,
  publicatiedatum: null,
  skills: [],
  status: "active",
  tariefEenheid: null,
  tariefMax: 4250,
  tariefMin: 3750,
  titel: "SYNTHETIC tarief zonder periode",
  urenPerWeekMax: null,
  urenPerWeekMin: null,
  werkvorm: null,
};

const minOnlyRateJob: SearchDocument = {
  beschrijving: "SYNTHETIC dagtarief met alleen een EUR minimum.",
  bronId: BRON_ID,
  contracttype: null,
  eindklantNaam: null,
  id: MIN_ONLY_RATE_ID,
  laatstGezienOp: new Date("2026-09-04T17:00:00.000Z"),
  locatie: "Tilburg",
  locatieLand: "NL",
  opdrachtgeverNaam: null,
  provincie: null,
  publicatiedatum: null,
  skills: [],
  status: "active",
  tariefEenheid: null,
  tariefMax: null,
  tariefMin: 650,
  titel: "SYNTHETIC minimum dagtarief",
  urenPerWeekMax: null,
  urenPerWeekMin: null,
  werkvorm: null,
};

interface SyntheticRateFacts {
  readonly tariefEenheid: string | null;
  readonly tariefMax: number | null;
  readonly tariefMin: number | null;
  readonly tariefValuta: string | null;
}

const syntheticRateFacts = new Map<string, SyntheticRateFacts>([
  [
    commaJob.id,
    {
      tariefEenheid: "uur",
      tariefMax: 110,
      tariefMin: 90,
      tariefValuta: "EUR",
    },
  ],
  [
    longDetailJob.id,
    {
      tariefEenheid: "uur",
      tariefMax: 110,
      tariefMin: 90,
      tariefValuta: "EUR",
    },
  ],
  [
    monthRateJob.id,
    {
      tariefEenheid: "maand",
      tariefMax: 6000,
      tariefMin: 4000,
      tariefValuta: "EUR",
    },
  ],
  [
    dayRateJob.id,
    {
      tariefEenheid: "dag",
      tariefMax: 750,
      tariefMin: 500,
      tariefValuta: "EUR",
    },
  ],
  [
    unknownPeriodRateJob.id,
    {
      tariefEenheid: null,
      tariefMax: 4250,
      tariefMin: 3750,
      tariefValuta: "EUR",
    },
  ],
  [
    minOnlyRateJob.id,
    {
      tariefEenheid: "dag",
      tariefMax: null,
      tariefMin: 650,
      tariefValuta: "EUR",
    },
  ],
]);

const syntheticDocuments: readonly SearchDocument[] = [
  commaJob,
  timeoutJob,
  unknownFieldsJob,
  longDetailJob,
  archivedJob,
  monthRateJob,
  dayRateJob,
  unknownPeriodRateJob,
  minOnlyRateJob,
];

class IncompleteOnceEngine implements SearchEngine {
  private readonly delegate: SearchEngine;
  private readonly timeoutSearches = new Set<string>();

  constructor(delegate: SearchEngine) {
    this.delegate = delegate;
  }

  applyBatch(batch: SearchIndexBatch): Promise<SearchIndexBatchResult> {
    return this.delegate.applyBatch(batch);
  }

  deleteDocument(id: string): Promise<void> {
    return this.delegate.deleteDocument(id);
  }

  getAppliedVersion(): Promise<SearchVersion> {
    return this.delegate.getAppliedVersion();
  }

  async search(params: EngineSearchParams): Promise<SearchEngineResult> {
    const result = await this.delegate.search(params);
    const astKey = JSON.stringify(params.ast);
    const isTimeoutScenario = astKey.includes("timeout");
    if (!isTimeoutScenario || this.timeoutSearches.has(astKey)) {
      return result;
    }
    this.timeoutSearches.add(astKey);
    return {
      ...result,
      emptyReason: "query_timeout",
      incomplete: true,
    };
  }

  upsertDocument(document: SearchDocument): Promise<void> {
    return this.delegate.upsertDocument(document);
  }
}

const createSyntheticRegistry = async () => {
  const baseDeps = createTestSliceADeps("search-audit-e2e");
  await Promise.all(
    syntheticDocuments.map((document) =>
      baseDeps.engine.upsertDocument(document)
    )
  );

  for (const document of syntheticDocuments) {
    const rateFacts = syntheticRateFacts.get(document.id);
    const hasPublishedFacts = rateFacts !== undefined;
    baseDeps.stores.aanvragen.seed({
      beschrijving: document.beschrijving,
      bronId: document.bronId,
      bronReferentie: `SYNTH-${document.id.slice(-3)}`,
      contracttype: hasPublishedFacts ? "detachering" : null,
      eindDatum: document.id === longDetailJob.id ? "2027-02-28" : null,
      id: document.id,
      locatie: document.locatie ?? null,
      // Organization is absent from the currently persisted source facts.
      opdrachtgeverNaam: null,
      publicatiedatum: hasPublishedFacts ? "2026-09-01T09:00:00.000Z" : null,
      rawPayloadRef: `synthetic/${document.id}.json`,
      scrapeRunId: SCRAPE_RUN_ID,
      sluitingsdatum: hasPublishedFacts
        ? new Date("2099-09-30T17:00:00.000Z")
        : null,
      startDatum: document.id === longDetailJob.id ? "2026-10-01" : null,
      status: document.status,
      tariefEenheid: rateFacts?.tariefEenheid ?? null,
      tariefMax: rateFacts?.tariefMax ?? null,
      tariefMin: rateFacts?.tariefMin ?? null,
      tariefValuta: rateFacts?.tariefValuta ?? null,
      titel: document.titel,
      urenPerWeek: document.id === longDetailJob.id ? "32" : null,
      versies: [],
      werkvorm: hasPublishedFacts ? "remote" : null,
    });
  }

  const deps = {
    ...baseDeps,
    bronnen: {
      getById: (bronId: string) =>
        Promise.resolve(
          syntheticBronnen.find((bron) => bron.bronId === bronId) ?? null
        ),
      list: () => Promise.resolve(syntheticBronnen),
    },
    searchAdapter: new SearchAdapter({
      engine: new IncompleteOnceEngine(baseDeps.engine),
    }),
  };
  return createSliceARegistry(deps).registry;
};

const registry = await createSyntheticRegistry();
const restHandler = createRestCapabilityHandler(
  registry,
  restRoutesFromRegistry(registry),
  () =>
    Promise.resolve({
      ok: true as const,
      principal: {
        kind: "user" as const,
        permissions: permissionsForRole("recruiter"),
        subjectId: "search-audit-user",
      },
    }),
  { allowedCookieOrigin: WEB_ORIGIN }
);

if (process.env.SEARCH_AUDIT_E2E !== "1") {
  throw new Error("Synthetic API requires SEARCH_AUDIT_E2E=1.");
}

const sessionResponse = () => ({
  session: {
    createdAt: "2026-09-04T08:00:00.000Z",
    expiresAt: "2099-09-05T08:00:00.000Z",
    id: "search-audit-session",
    token: "synthetic-session-token",
    updatedAt: "2026-09-04T08:00:00.000Z",
    userId: "search-audit-user",
  },
  user: {
    createdAt: "2026-09-04T08:00:00.000Z",
    email: "search-audit@example.invalid",
    emailVerified: true,
    id: "search-audit-user",
    name: "Search Audit",
    updatedAt: "2026-09-04T08:00:00.000Z",
  },
});

const app = new Hono();
app.use(
  "*",
  cors({
    allowHeaders: ["Accept", "Content-Type"],
    allowMethods: ["GET", "POST", "OPTIONS"],
    credentials: true,
    origin: WEB_ORIGIN,
  })
);
app.get("/health", (context) => context.json({ ok: true }));
app.get("/api/auth/get-session", (context) => context.json(sessionResponse()));
app.all("/v1/*", (context) => restHandler(context));

Bun.serve({
  fetch: app.fetch,
  hostname: "127.0.0.1",
  port: API_PORT,
});

console.info(
  `Synthetic search-audit API listening on http://localhost:${API_PORT}`
);
