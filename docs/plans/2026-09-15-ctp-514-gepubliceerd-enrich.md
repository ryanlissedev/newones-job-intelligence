# CTP-514 residual — shared gepubliceerd / publicatiedatum enrich

**Status:** completed
**Date:** 2026-09-15
**Base:** `323bddfad74676b1917ce46c7d6f79d4f51657f7` (#280 MATCH tip)

## Problem

Fixture `bae554b7-…` still shows Gepubliceerd Onbekend after #280 HIST_MIG filled tarief/uren/opleiding.
Motian `posted_at` is null for NVB (corpus-wide). #280 added `extractJobPostingCommercialFacts` (`datePosted`→`publicatiedatum`) but never wired it into `ENRICHMENT_FIELDS` / deterministic extract / persist / DB check / overlay.

## Decision

Extend the **shared** enrichment pipeline (CTP-482 shape) with `publicatiedatum`:

1. Prefer JobPosting JSON-LD `datePosted` from `rawHtml` via existing shared extractor.
2. Accept only honest absolute timestamps (ISO date/datetime). **Reject** relative invent (“35 dagen”).
3. Persist to curated `publicatiedatum` (null-only fill; CLEARED respected).
4. Migration widens `aanvraag_enrichment_field_check` — no NVB-only branches.

## Non-goals

- Motian Coolify mutate / invent from `scraped_at`
- Relative-age synthesis
- Corpus HIST_MIG / live HTML re-fetch ops (Catapulze post-merge)

## Implementation units

1. Types + deterministic JobPosting path + incomplete gap detection
2. Persist / overlay / stored-parse + enrichment-store SELECT/apply
3. Schema check migration `0024` + UI/API enriched field name
4. Tests proving datePosted fill and relative reject

## Verification

Focused enrichment + readiness tests; pre-push gate green; PR vs main ≥ `323bddfa`.
