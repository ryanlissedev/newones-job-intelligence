#!/usr/bin/env bash
# RJC-382: proves the manticore29 shadow instance serves our RT table shape,
# not a benchmark. Starts the service, creates the aanvragen table from the
# 29 conf schema, inserts a few documents, runs one boolean query, one facet
# query, and one morphology probe (ontwikkelaar vs ontwikkelaars), then
# cleans up. Every probe asserts its expected result — an HTTP 200 with the
# wrong row count or facet values fails the script, it does not just print
# and move on (a curl transport failure alone would be a weaker signal).
# Exits non-zero on any failure, naming which probe failed.
set -euo pipefail

if ! command -v jq >/dev/null 2>&1; then
  echo "probe-manticore29: jq is required to assert query results" >&2
  exit 1
fi

http_port="${MANTICORE29_HTTP_PORT:-9312}"
base_url="http://127.0.0.1:${http_port}"
compose_command=(docker compose)

cleanup() {
  "${compose_command[@]}" stop manticore29 >/dev/null 2>&1 || true
}
trap cleanup EXIT

echo "probe-manticore29: starting manticore29 service"
"${compose_command[@]}" up -d --wait manticore29

# DDL (DROP/CREATE/INSERT) goes through /cli — Manticore's /sql?mode=raw
# endpoint rejects DROP/CREATE TABLE with "requires data_dir to be set",
# a known quirk of that endpoint; /cli has no such restriction.
cli() {
  curl --fail --silent --show-error "${base_url}/cli" --data-binary "$1"
}

# SELECT queries go through /sql?mode=raw, which returns JSON — parseable
# with jq for real assertions instead of eyeballing a printed table.
query_json() {
  curl --fail --silent --show-error -X POST "${base_url}/sql?mode=raw" \
    --data-urlencode "query=$1"
}

fail() {
  echo "probe-manticore29: FAILED — $1" >&2
  exit 1
}

echo "probe-manticore29: dropping any stale table"
cli "DROP TABLE IF EXISTS aanvragen" >/dev/null

echo "probe-manticore29: creating aanvragen table"
cli "CREATE TABLE aanvragen (
  titel text,
  beschrijving text,
  bron_id string,
  status string,
  locatie_land string,
  contracttype string,
  document_id string,
  tarief_min float,
  tarief_max float,
  laatst_gezien_op timestamp,
  index_version bigint
) morphology='stem_en, libstemmer_nl' html_strip='1' min_infix_len='2'" >/dev/null

echo "probe-manticore29: inserting probe documents"
cli "INSERT INTO aanvragen (id, titel, beschrijving, bron_id, status, locatie_land, contracttype, document_id, tarief_min, tarief_max, laatst_gezien_op, index_version)
VALUES
  (1, 'Senior scrumteam lead', 'Werving voor een ervaren ontwikkelaar in het scrumteam', 'src-1', 'open', 'NL', 'zzp', 'doc-1', 80, 110, 1735689600, 1),
  (2, 'Junior ontwikkelaars gezocht', 'Meerdere ontwikkelaars nodig voor een greenfield project', 'src-2', 'open', 'NL', 'zzp', 'doc-2', 50, 70, 1735689600, 1),
  (3, 'Data engineer', 'Bouw pipelines, geen scrumteam ervaring vereist', 'src-1', 'closed', 'BE', 'detachering', 'doc-3', 90, 120, 1735689600, 1)
" >/dev/null

echo
echo "=== Boolean query: bron_id filter (src-1) ==="
result="$(query_json "SELECT id, titel, bron_id, status FROM aanvragen WHERE bron_id = 'src-1'")"
echo "${result}" | jq .
total="$(echo "${result}" | jq -r '.[0].total')"
ids="$(echo "${result}" | jq -c '[.[0].data[].id] | sort')"
[[ "${total}" == "2" && "${ids}" == "[1,3]" ]] \
  || fail "boolean query: expected total=2 ids=[1,3], got total=${total} ids=${ids}"

echo
echo "=== Facet query: status counts ==="
result="$(query_json "SELECT status, COUNT(*) AS cnt FROM aanvragen GROUP BY status ORDER BY status ASC")"
echo "${result}" | jq .
open_count="$(echo "${result}" | jq -r '.[0].data[] | select(.status=="open") | .cnt')"
closed_count="$(echo "${result}" | jq -r '.[0].data[] | select(.status=="closed") | .cnt')"
[[ "${open_count}" == "2" && "${closed_count}" == "1" ]] \
  || fail "facet query: expected open=2 closed=1, got open=${open_count} closed=${closed_count}"

# The next two probes assert the CURRENT (still-broken) golden-set stemming
# anomaly: singular and plural forms of "ontwikkelaar(s)" do NOT cross-match
# on 29.0.2 (confirmed live — see README-29-shadow.md). If a future
# Manticore version or config change fixes this, these exact-count
# assertions will fail loudly, forcing a deliberate update here rather than
# silently starting to pass a wider match than the probe expects.
echo
echo "=== Morphology probe: 'ontwikkelaar' (singular) ==="
result="$(query_json "SELECT id, titel FROM aanvragen WHERE MATCH('ontwikkelaar')")"
echo "${result}" | jq .
total="$(echo "${result}" | jq -r '.[0].total')"
ids="$(echo "${result}" | jq -c '[.[0].data[].id] | sort')"
[[ "${total}" == "1" && "${ids}" == "[1]" ]] \
  || fail "morphology singular: expected total=1 ids=[1] (still-broken stemming), got total=${total} ids=${ids}"

echo
echo "=== Morphology probe: 'ontwikkelaars' (plural) ==="
result="$(query_json "SELECT id, titel FROM aanvragen WHERE MATCH('ontwikkelaars')")"
echo "${result}" | jq .
total="$(echo "${result}" | jq -r '.[0].total')"
ids="$(echo "${result}" | jq -c '[.[0].data[].id] | sort')"
[[ "${total}" == "1" && "${ids}" == "[2]" ]] \
  || fail "morphology plural: expected total=1 ids=[2] (still-broken stemming), got total=${total} ids=${ids}"

echo
echo "=== Infix probe: 'scrum' as substring inside 'scrumteam' ==="
result="$(query_json "SELECT id, titel FROM aanvragen WHERE MATCH('*scrum*')")"
echo "${result}" | jq .
total="$(echo "${result}" | jq -r '.[0].total')"
ids="$(echo "${result}" | jq -c '[.[0].data[].id] | sort')"
[[ "${total}" == "2" && "${ids}" == "[1,3]" ]] \
  || fail "infix probe: expected total=2 ids=[1,3], got total=${total} ids=${ids}"

echo
echo "probe-manticore29: cleaning up test table"
cli "DROP TABLE aanvragen" >/dev/null

echo "probe-manticore29: OK — manticore29 serves the aanvragen shape and every probe's assertions passed (RJC-382)"
