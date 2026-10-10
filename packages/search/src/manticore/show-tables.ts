export interface ManticoreShowTablesRow {
  /** Column name for Manticore <= ~6.x. */
  readonly Index?: string;
  /** Column name on Manticore 29.x (the shadow-instance conf under
   * tools/manticore/probe-manticore29.sh) — `SHOW TABLES` renamed the
   * column from `Index` to `Table`. Accept either so a healthy 29.x table
   * doesn't read back as "table_missing" -> permanent readiness failure. */
  readonly Table?: string;
}

export interface ManticoreShowTablesEnvelope {
  readonly data?: readonly ManticoreShowTablesRow[];
}

export const tableExistsInShowTables = (
  raw: string,
  tableName: string
): boolean => {
  // SAFETY: a 2xx `/sql?mode=raw` response is always
  // `[{ data: [{ Index|Table, Type }, ...], ... }]` — any other shape would
  // have been a non-2xx response, already thrown above.
  const parsed = JSON.parse(raw) as ManticoreShowTablesEnvelope[];
  const rows = Array.isArray(parsed) ? (parsed[0]?.data ?? []) : [];
  return rows.some((row) => row.Index === tableName || row.Table === tableName);
};
