/**
 * Marktvragen data dictionary (Slice B / JI-DSH-07).
 *
 * Static seed the agent reads before writing SQL: what the `marts` schema is
 * for, which metric definitions apply, and named query recipes that should be
 * reused instead of improvised SQL. `list_marts_tables` introspects the live
 * schema and stays the only ground truth for which tables and columns exist;
 * entries here describe semantics for tables by name — a documented table that
 * is absent from `list_marts_tables` does not exist yet and must not be
 * queried.
 */

export interface MartsColumnDoc {
  readonly description: string;
  readonly name: string;
}

export interface MartsTableDoc {
  readonly columns: readonly MartsColumnDoc[];
  readonly description: string;
  readonly grain: string;
  readonly name: string;
}

export interface MartsMetricDoc {
  readonly description: string;
  readonly name: string;
  readonly sql: string;
}

export interface MartsQueryRecipe {
  readonly name: string;
  readonly notes?: string;
  readonly question: string;
  readonly sql: string;
  readonly tables: readonly string[];
}

export interface MartsDictionary {
  readonly conventions: readonly string[];
  readonly metrics: readonly MartsMetricDoc[];
  readonly tables: readonly MartsTableDoc[];
  readonly recipes: readonly MartsQueryRecipe[];
  readonly version: string;
}

export const MARTS_DICTIONARY_VERSION = "marts-dict-v1" as const;

const aanvraagColumns: readonly MartsColumnDoc[] = [
  { description: "Surrogate key", name: "id" },
  { description: "Bron die deze aanvraag leverde", name: "bron_id" },
  { description: "Externe referentie bij de bron", name: "bron_referentie" },
  { description: "Vacaturetitel", name: "titel" },
  { description: "Naam van de opdrachtgever", name: "opdrachtgever_naam" },
  { description: "Plaats/regio van de opdracht", name: "locatie" },
  { description: "ISO-landcode", name: "locatie_land" },
  { description: "Nederlandse provincie", name: "provincie" },
  {
    description: "Contractvorm (freelance, detachering, ...)",
    name: "contracttype",
  },
  { description: "Ondergrens uurtarief", name: "tarief_min" },
  { description: "Bovengrens uurtarief", name: "tarief_max" },
  { description: "Valuta van tarief_min/max", name: "tarief_valuta" },
  {
    description: "Eenheid van het tarief (uur/dag/maand)",
    name: "tarief_eenheid",
  },
  { description: "Gevraagde uren per week", name: "uren_per_week" },
  { description: "Werkvorm (remote/hybride/op locatie)", name: "werkvorm" },
  { description: "Gevraagd opleidingsniveau", name: "opleidingsniveau" },
  { description: "Gevraagde skills (array)", name: "skills" },
  { description: "Eerste publicatie bij de bron", name: "publicatiedatum" },
  { description: "Sluitingsdatum inschrijving", name: "sluitingsdatum" },
  { description: "Beoogde startdatum", name: "start_datum" },
  { description: "Beoogde einddatum", name: "eind_datum" },
  { description: "Duur van de opdracht (vrije tekst)", name: "duur" },
  {
    description: "Lifecycle-status (open/gevuld/verlopen/gesloten)",
    name: "status",
  },
];

export const MARTS_DICTIONARY: MartsDictionary = {
  conventions: [
    "Alle kolommen zijn snake_case; datums zijn timestamptz tenzij _datum-suffix (date).",
    "Tarief is NULL wanneer de bron geen tarief publiceert — nooit imputeren, als UNKNOWN rapporteren.",
    "status volgt de aanvraag-lifecycle; 'open' is de placeerbare voorraad.",
    "Agregeer nooit over bronnen heen zonder dedup_groep_id te overwegen: dezelfde vacature kan bij meerdere bronnen staan.",
  ],
  metrics: [
    {
      description: "Aantal unieke open aanvragen per bron",
      name: "open_aanvragen_per_bron",
      sql: "SELECT bron_id, count(*) AS n FROM <aanvraag-tabel> WHERE status = 'open' GROUP BY bron_id ORDER BY n DESC",
    },
    {
      description:
        "Mediaan van het minimumtarief over open aanvragen met tarief",
      name: "mediaan_tarief_min",
      sql: "SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY tarief_min) FROM <aanvraag-tabel> WHERE status = 'open' AND tarief_min IS NOT NULL",
    },
  ],
  recipes: [
    {
      name: "aanvragen_per_bron",
      notes:
        "Vervang <aanvraag-tabel> door de aanvraagtabel uit list_marts_tables.",
      question: "Hoeveel aanvragen staan er per bron?",
      sql: "SELECT bron_id, count(*) AS aantal FROM <aanvraag-tabel> GROUP BY bron_id ORDER BY aantal DESC",
      tables: ["aanvraag"],
    },
    {
      name: "tarief_spreiding",
      notes:
        "Alleen rijen met bekend tarief; rapporteer het aantal UNKNOWN apart.",
      question: "Wat is de spreiding van uurtarieven?",
      sql: "SELECT percentile_cont(0.25) WITHIN GROUP (ORDER BY tarief_min) AS p25, percentile_cont(0.5) WITHIN GROUP (ORDER BY tarief_min) AS mediaan, percentile_cont(0.75) WITHIN GROUP (ORDER BY tarief_min) AS p75 FROM <aanvraag-tabel> WHERE tarief_min IS NOT NULL",
      tables: ["aanvraag"],
    },
  ],
  tables: [
    {
      columns: aanvraagColumns,
      description:
        "Denormalized aanvraag/vacature-tabel. Één rij per bron-aanvraag-versie zoals laatst gezien.",
      grain: "1 rij per aanvraag per bron",
      name: "aanvraag",
    },
  ],
  version: MARTS_DICTIONARY_VERSION,
};

const scoreRecipe = (
  recipe: MartsQueryRecipe,
  terms: readonly string[]
): number => {
  const haystack =
    `${recipe.name} ${recipe.question} ${recipe.tables.join(" ")}`.toLowerCase();
  let score = 0;
  for (const term of terms) {
    if (haystack.includes(term)) {
      score += 1;
    }
  }
  return score;
};

/**
 * Keyword ranking over the static recipe catalog. Intentionally dumb (substring
 * match, no stemming): the catalog is small and the agent needs recall, not
 * precision — a false positive costs one read, a false negative costs a
 * hand-rolled query.
 */
export const searchMartsQueryCatalog = (
  query: string,
  limit = 5
): readonly MartsQueryRecipe[] => {
  const terms = query
    .toLowerCase()
    .split(/[^a-z0-9_]+/u)
    .filter((term) => term.length >= 2);
  if (terms.length === 0) {
    return MARTS_DICTIONARY.recipes.slice(0, limit);
  }
  return MARTS_DICTIONARY.recipes
    .map((recipe) => ({ recipe, score: scoreRecipe(recipe, terms) }))
    .filter((entry) => entry.score > 0)
    .toSorted((left, right) => right.score - left.score)
    .slice(0, limit)
    .map((entry) => entry.recipe);
};
