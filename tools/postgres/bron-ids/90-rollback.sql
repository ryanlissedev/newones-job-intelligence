-- Rollback for 02-apply-seed-rows.sql. The two rows are inactive and hold no data, so the
-- recommended rollback is to LEAVE them (nothing polls an inactive row). If they were activated
-- by mistake, switch them off again (no delete):
--   UPDATE curated.bron SET actief = false
--    WHERE id IN ('00000000-0000-4000-8000-000000000046', '00000000-0000-4000-8000-000000000047');
-- Removing the rows is a DELETE and needs an explicit GO; it is only possible while no scrape_run,
-- source_record or aanvraag references them (FKs).
-- Code rollback: revert the PR. The seed then targets …035/…036 again and, with this PR's
-- fail-loud check reverted too, silently skips as before; nothing in the data changes.
SELECT 'read the comments; nothing to run by default' AS note;
