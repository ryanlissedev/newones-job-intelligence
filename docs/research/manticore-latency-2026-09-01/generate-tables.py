#!/usr/bin/env python3
"""One-off table generator for the RJC-382 latency report (not part of the
benchmarks/search harness -- a report-authoring aid only, not committed as
a repo tool). Reads results.json (and the raw per-engine JSON files it
references) and prints markdown tables so the report's numbers are never
hand-copied from terminal output. Run: python3 generate-tables.py
"""
import json
import os

HERE = os.path.dirname(os.path.abspath(__file__))


def load(name):
    with open(os.path.join(HERE, name)) as f:
        return json.load(f)


def contaminated_table(results):
    rows = results["seriesContaminated"]
    print("| Series | Config | Query mode | Indexing | p50 | p95 | p99 | max | errors | SLO |")
    print("|---|---|---|---:|---:|---:|---:|---:|---:|---|")
    for r in rows:
        idx = f'{r["indexingDocsPerSecond"]} docs/s' if "indexingDocsPerSecond" in r else "-"
        maxms = f'{r["maxMs"]}ms' if "maxMs" in r else "-"
        err = r.get("errorCount", "-")
        print(
            f'| {r["label"]} | {r["config"]} | {r["queryMode"]} | {idx} | '
            f'{r["p50Ms"]}ms | {r["p95Ms"]}ms | {r["p99Ms"]}ms | {maxms} | {err} | '
            f'{"PASS" if r["passed"] else "FAIL"} |'
        )


def clean_table(results):
    rows = results["seriesClean"]
    print()
    print("| Series | Config | Query mode | Load start->end | Indexing | p50 | p95 | p99 | max | errors | SLO |")
    print("|---|---|---|---|---:|---:|---:|---:|---:|---:|---|")
    for r in rows:
        idx = f'{r["indexingDocsPerSecond"]} docs/s' if "indexingDocsPerSecond" in r else "-"
        maxms = f'{r["maxMs"]}ms' if "maxMs" in r else "-"
        err = r.get("errorCount", "-")
        load = f'{r["loadStart"]}->{r["loadEnd"]}'
        print(
            f'| {r["label"]} | {r["config"]} | {r["queryMode"]} | {load} | {idx} | '
            f'{r["p50Ms"]}ms | {r["p95Ms"]}ms | {r["p99Ms"]}ms | {maxms} | {err} | '
            f'{"PASS" if r["passed"] else "FAIL"} |'
        )


def mixed_table(results):
    rows = results.get("seriesMixed", [])
    if not rows:
        return
    print()
    print("| Series | Config | Query mode | Load start->end | Indexing | p50 | p95 | p99 | max | errors |")
    print("|---|---|---|---|---:|---:|---:|---:|---:|---:|")
    for r in rows:
        idx = f'{r["indexingDocsPerSecond"]} docs/s' if "indexingDocsPerSecond" in r else "-"
        maxms = f'{r["maxMs"]}ms' if "maxMs" in r else "-"
        err = r.get("errorCount", "-")
        load = f'{r["loadStart"]}->{r["loadEnd"]}'
        print(
            f'| {r["label"]} | {r["config"]} | {r["queryMode"]} | {load} | {idx} | '
            f'{r["p50Ms"]}ms | {r["p95Ms"]}ms | {r["p99Ms"]}ms | {maxms} | {err} |'
        )


def per_query_table(title, raw_file, sort_desc_by="p95Ms"):
    data = load(raw_file)
    entry = data[-1] if isinstance(data, list) else data
    per_query = entry["perQuery"]
    rows = sorted(per_query, key=lambda q: -q[sort_desc_by])
    print()
    print(f"**{title}** (engine field: `{entry['engine']}`, {entry['p50Ms']}ms/{entry['p95Ms']}ms/{entry['p99Ms']}ms p50/p95/p99 overall, {entry['documentCount']} docs, queryMode={entry['queryMode']}):")
    print()
    print("| query id | count | p50 | p95 |")
    print("|---|---:|---:|---:|")
    for q in rows:
        print(f'| {q["queryId"]} | {q["count"]} | {q["p50Ms"]}ms | {q["p95Ms"]}ms |')


if __name__ == "__main__":
    results = load("results.json")
    print("### Contaminated series table")
    contaminated_table(results)
    print("\n### Clean series table (admissible: true)")
    clean_table(results)
    print("\n### Mixed series (started clean, load rose past 6 before finishing -- NOT admissible)")
    mixed_table(results)
    print("\n### Per-query breakdown, profile queries (5 synthetic), clean runs")
    per_query_table("manticore-6.3.8, profile queries, clean", "raw-638-profile-clean.json")
    per_query_table("manticore29-infix, profile queries, clean", "raw-29infix-profile-clean.json")
    print("\n### Per-query breakdown, golden queries (43 real), clean/mixed run")
    per_query_table("manticore29-infix, golden queries, mixed (started clean, ended >6)", "raw-29infix-golden-clean.json")
