-- Stedin/Gasunie own bron ids: the ONLY prod write. Needs Ryan's GO; run after 01-precheck.sql
-- shows no row on …046/…047 and no Stedin/Gasunie naam. Run as ji_migrator (or ji_app).
--   psql "$MIGRATION_DATABASE_URL" -X -v ON_ERROR_STOP=1 -f 02-apply-seed-rows.sql
-- Inserts two INACTIVE rows (actief = false, status deferred, voorwaarden te_toetsen), with exactly the
-- values the registry seed (buildSliceABronSeedValues) writes. Nothing polls them until an operator
-- reviews the terms and activates them. No existing row or data is touched; …035/…036 stay Werkzoeken/Starapple.
-- Fails closed: if either id is already held by another bron, or a Stedin/Gasunie naam exists on another
-- id, the transaction aborts and nothing is written.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM curated.bron
              WHERE (id = '00000000-0000-4000-8000-000000000046' AND lower(naam) <> 'stedin')
                 OR (id = '00000000-0000-4000-8000-000000000047' AND lower(naam) <> 'gasunie')
                 OR (lower(naam) = 'stedin'  AND id <> '00000000-0000-4000-8000-000000000046')
                 OR (lower(naam) = 'gasunie' AND id <> '00000000-0000-4000-8000-000000000047')) THEN
    RAISE EXCEPTION 'bron id/naam collision for Stedin/Gasunie: run 01-precheck.sql and stop';
  END IF;
END $$;

INSERT INTO curated.bron
  (id, naam, actief, categorie, crawl_delay_ms, ingestie_type, interval, login_vereist, mapping_ref,
   rate_limit_per_minute, retention_days, secret_ref, status, voorwaarden_status)
VALUES
  ('00000000-0000-4000-8000-000000000046', 'Stedin', false, 'overheidsportaal', 2000, 'json-ld',
   '*/15 * * * *', false, 'fixtures/connectors/stedin/mapping.json', 30, 90, NULL, 'deferred', 'te_toetsen'),
  ('00000000-0000-4000-8000-000000000047', 'Gasunie', false, 'overheidsportaal', 2000, 'json-ld',
   '*/15 * * * *', false, 'fixtures/connectors/gasunie/mapping.json', 30, 90, NULL, 'deferred', 'te_toetsen')
ON CONFLICT (id) DO NOTHING;

SELECT id, naam, actief, status, voorwaarden_status FROM curated.bron
 WHERE id IN ('00000000-0000-4000-8000-000000000046', '00000000-0000-4000-8000-000000000047')
 ORDER BY id;

COMMIT;
