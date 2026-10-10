import type {
  BronOverlapBronShare,
  BronOverlapGroup,
  BronOverlapReader,
  BronOverlapResult,
} from "@ji/application/registry";
import { sql } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";

import type * as schema from "./schema";

export type BronOverlapDatabase = PostgresJsDatabase<typeof schema>;

interface GroepBronRow extends Record<string, unknown> {
  readonly aanvraag_count: number;
  readonly bron_count: number;
  readonly bron_ids: readonly string[];
  readonly bron_namen: readonly string[];
  readonly groep_id: string;
}

interface BronShareRow extends Record<string, unknown> {
  readonly bron_id: string;
  readonly naam: string;
  readonly overlapping_aanvragen: number;
  readonly share: number | null;
  readonly total_aanvragen: number;
}

interface CountRow extends Record<string, unknown> {
  readonly overlap_groep_count: number;
}

const GROUP_BRONNEN_CTE = sql`
  group_bronnen AS (
    SELECT a.dedup_groep_id AS groep_id, a.bron_id
    FROM curated.aanvraag a
    WHERE a.dedup_groep_id IS NOT NULL
    UNION
    SELECT a.dedup_groep_id AS groep_id, l.bron_id
    FROM curated.aanvraag_bron_link l
    INNER JOIN curated.aanvraag a ON a.id = l.aanvraag_id
    WHERE a.dedup_groep_id IS NOT NULL
  )
`;

const serializeGroup = (row: GroepBronRow): BronOverlapGroup => ({
  aanvraagCount: row.aanvraag_count,
  bronCount: row.bron_count,
  bronIds: [...row.bron_ids],
  bronNamen: [...row.bron_namen],
  groepId: row.groep_id,
});

const serializeBronShare = (row: BronShareRow): BronOverlapBronShare => ({
  bronId: row.bron_id,
  naam: row.naam,
  overlappingAanvragen: row.overlapping_aanvragen,
  share: row.share,
  totalAanvragen: row.total_aanvragen,
});

/**
 * Reads cross-bron overlap from curated dedup state only (DEC-003).
 *
 * Bronnen per groep = distinct `aanvraag.bron_id` ∪ `aanvraag_bron_link.bron_id`
 * for members of the groep. No Motian-style matching heuristics.
 */
export class PostgresBronOverlapReader implements BronOverlapReader {
  private readonly database: BronOverlapDatabase;

  constructor(database: BronOverlapDatabase) {
    this.database = database;
  }

  async bronOverlap(): Promise<BronOverlapResult> {
    const [countRow] = await this.database.execute<CountRow>(sql`
      WITH ${GROUP_BRONNEN_CTE},
      overlap_groepen AS (
        SELECT groep_id
        FROM group_bronnen
        GROUP BY groep_id
        HAVING count(DISTINCT bron_id) >= 2
      )
      SELECT CAST(count(*) AS integer) AS overlap_groep_count
      FROM overlap_groepen
    `);

    const topGroups = await this.database.execute<GroepBronRow>(sql`
      WITH ${GROUP_BRONNEN_CTE},
      groep_stats AS (
        SELECT
          gb.groep_id,
          CAST(count(DISTINCT gb.bron_id) AS integer) AS bron_count,
          CAST((
            SELECT count(*)
            FROM curated.aanvraag a
            WHERE a.dedup_groep_id = gb.groep_id
          ) AS integer) AS aanvraag_count,
          array_agg(DISTINCT gb.bron_id ORDER BY gb.bron_id) AS bron_ids,
          array_agg(DISTINCT b.naam ORDER BY b.naam) AS bron_namen
        FROM group_bronnen gb
        INNER JOIN curated.bron b ON b.id = gb.bron_id
        GROUP BY gb.groep_id
        HAVING count(DISTINCT gb.bron_id) >= 2
      )
      SELECT
        groep_id,
        bron_count,
        aanvraag_count,
        bron_ids,
        bron_namen
      FROM groep_stats
      ORDER BY bron_count DESC, aanvraag_count DESC, groep_id ASC
      LIMIT 10
    `);

    const perBron = await this.database.execute<BronShareRow>(sql`
      WITH ${GROUP_BRONNEN_CTE},
      overlap_groepen AS (
        SELECT groep_id
        FROM group_bronnen
        GROUP BY groep_id
        HAVING count(DISTINCT bron_id) >= 2
      ),
      totals AS (
        SELECT
          a.bron_id,
          CAST(count(*) AS integer) AS total_aanvragen
        FROM curated.aanvraag a
        GROUP BY a.bron_id
      ),
      overlapping AS (
        SELECT
          a.bron_id,
          CAST(count(*) AS integer) AS overlapping_aanvragen
        FROM curated.aanvraag a
        INNER JOIN overlap_groepen og ON og.groep_id = a.dedup_groep_id
        GROUP BY a.bron_id
      )
      SELECT
        b.id AS bron_id,
        b.naam,
        CAST(coalesce(t.total_aanvragen, 0) AS integer) AS total_aanvragen,
        CAST(coalesce(o.overlapping_aanvragen, 0) AS integer)
          AS overlapping_aanvragen,
        CASE
          WHEN coalesce(t.total_aanvragen, 0) = 0 THEN NULL
          ELSE CAST(coalesce(o.overlapping_aanvragen, 0) AS double precision)
            / CAST(t.total_aanvragen AS double precision)
        END AS share
      FROM curated.bron b
      LEFT JOIN totals t ON t.bron_id = b.id
      LEFT JOIN overlapping o ON o.bron_id = b.id
      ORDER BY b.naam ASC
    `);

    return {
      overlapGroepCount: countRow?.overlap_groep_count ?? 0,
      perBron: perBron.map(serializeBronShare),
      topGroups: topGroups.map(serializeGroup),
    };
  }
}
