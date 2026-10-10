import postgres from "postgres";

export interface UnknownFieldInventory {
  readonly contractUnknown: number;
  readonly locatieUnknown: number;
  readonly remoteUnknown: number;
  readonly tariefUnknown: number;
  readonly total: number;
}

export const UNKNOWN_FIELD_INVENTORY_SQL = `
SELECT
  COUNT(*)::int AS total,
  COUNT(*) FILTER (
    WHERE locatie_tekst IS NULL
      OR trim(locatie_tekst) = ''
      OR locatie_tekst = 'unknown'
  )::int AS locatie_unknown,
  COUNT(*) FILTER (
    WHERE tarief_min IS NULL
      AND tarief_max IS NULL
      AND tarief_eenheid IS NULL
  )::int AS tarief_unknown,
  COUNT(*) FILTER (
    WHERE COALESCE(
      NULLIF(trim(bron_specifiek->>'contracttype'), ''),
      NULLIF(trim(bron_specifiek->>'contract_type'), '')
    ) IS NULL
  )::int AS contract_unknown,
  COUNT(*) FILTER (
    WHERE NULLIF(trim(bron_specifiek->>'werkvorm'), '') IS NULL
  )::int AS remote_unknown
FROM curated.aanvraag;
`.trim();

const toInventory = (row: {
  contract_unknown: number;
  locatie_unknown: number;
  remote_unknown: number;
  tarief_unknown: number;
  total: number;
}): UnknownFieldInventory => ({
  contractUnknown: row.contract_unknown,
  locatieUnknown: row.locatie_unknown,
  remoteUnknown: row.remote_unknown,
  tariefUnknown: row.tarief_unknown,
  total: row.total,
});

export const queryUnknownFieldInventory = async (
  databaseUrl: string
): Promise<UnknownFieldInventory> => {
  const sql = postgres(databaseUrl, {
    connect_timeout: 5,
    idle_timeout: 5,
    max: 1,
  });
  try {
    const [row] = await sql.unsafe<
      [
        {
          contract_unknown: number;
          locatie_unknown: number;
          remote_unknown: number;
          tarief_unknown: number;
          total: number;
        },
      ]
    >(UNKNOWN_FIELD_INVENTORY_SQL);
    if (!row) {
      throw new Error("Inventory query returned no rows");
    }
    return toInventory(row);
  } finally {
    await sql.end({ timeout: 5 });
  }
};

export const formatUnknownFieldInventory = (
  inventory: UnknownFieldInventory
): string =>
  [
    `total=${inventory.total}`,
    `locatie_unknown=${inventory.locatieUnknown}`,
    `tarief_unknown=${inventory.tariefUnknown}`,
    `contract_unknown=${inventory.contractUnknown}`,
    `remote_unknown=${inventory.remoteUnknown}`,
  ].join(" ");

const isMain = import.meta.main ?? false;

const runInventoryCli = async (): Promise<void> => {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    console.error(
      "DATABASE_URL is not set. Run the SQL documented in docs/plans/2026-09-07-ctp-482-enrichment-slice-1.md"
    );
    console.error(UNKNOWN_FIELD_INVENTORY_SQL);
    process.exit(1);
  }

  try {
    const inventory = await queryUnknownFieldInventory(databaseUrl);
    console.log(formatUnknownFieldInventory(inventory));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`inventory query failed: ${message}`);
    console.error(UNKNOWN_FIELD_INVENTORY_SQL);
    process.exit(1);
  }
};

if (isMain) {
  await runInventoryCli();
}
