# Evidence: read-only bron seed reconcile report

Branch `feat/bron-seed-reconcile-report`. Harness: [`evidence-harness.ts`](./evidence-harness.ts).
Ran 2026-10-09 against a scratch Postgres DB (`ji_evidence_3`, all migrations applied). There was no prod access.

## Scenario: prod-shaped registry (MEASURED.md, 2026-10-09)

- 38 of the 49 code sources have a row. Seeded with the existing insert-only smoke seed.
- Every row is reviewed `toegestaan`. Intermediair, ProUnity and Rabobank are `actief = false`.
- The v1-backfill feed rows come from the existing `seedMotianV1Bronnen`.
- 43 rows in total, matching prod.

## Result

```
bron rows: 43  fingerprint before: 7955c49556164d714ec8f8d35b3ddcf3
--- report (bun apps/worker/scripts/bron-seed-reconcile.ts output shape) ---
{
  "inSync": false,
  "inactiveRows": [
    {
      "bronId": "00000000-0000-4000-8000-000000000037",
      "naam": "Intermediair",
      "status": "ready"
    },
    {
      "bronId": "00000000-0000-4000-8000-000000000040",
      "naam": "ProUnity",
      "status": "ready"
    },
    {
      "bronId": "00000000-0000-4000-8000-000000000010",
      "naam": "Rabobank",
      "status": "ready"
    }
  ],
  "missingRows": [
    {
      "bronId": "00000000-0000-4000-8000-00000000003a",
      "naam": "Alliander",
      "slug": "alliander"
    },
    {
      "bronId": "00000000-0000-4000-8000-000000000042",
      "naam": "Circle8",
      "slug": "circle8"
    },
    {
      "bronId": "00000000-0000-4000-8000-000000000034",
      "naam": "Enexis",
      "slug": "enexis"
    },
    {
      "bronId": "00000000-0000-4000-8000-00000000003b",
      "naam": "Essent",
      "slug": "essent"
    },
    {
      "bronId": "00000000-0000-4000-8000-000000000044",
      "naam": "Indeed",
      "slug": "indeed"
    },
    {
      "bronId": "00000000-0000-4000-8000-000000000043",
      "naam": "LinkedIn Jobs",
      "slug": "linkedin"
    },
    {
      "bronId": "00000000-0000-4000-8000-000000000045",
      "naam": "Mercell",
      "slug": "mercell"
    },
    {
      "bronId": "00000000-0000-4000-8000-00000000003c",
      "naam": "TenneT",
      "slug": "tennet"
    },
    {
      "bronId": "00000000-0000-4000-8000-000000000041",
      "naam": "Werk.nl",
      "slug": "werk-nl"
    }
  ],
  "naamConflicts": [
    {
      "bronId": "00000000-0000-4000-8000-000000000036",
      "codeNaam": "Gasunie",
      "dbNaam": "Starapple",
      "slug": "gasunie"
    },
    {
      "bronId": "00000000-0000-4000-8000-000000000035",
      "codeNaam": "Stedin",
      "dbNaam": "Werkzoeken",
      "slug": "stedin"
    }
  ],
  "totals": {
    "codeSources": 49,
    "dbRows": 43
  },
  "unknownRows": [
    {
      "actief": false,
      "bronId": "00000000-0000-4000-8000-000000000033",
      "naam": "Flextender"
    },
    {
      "actief": false,
      "bronId": "00000000-0000-4000-8000-000000000032",
      "naam": "MI Public"
    },
    {
      "actief": false,
      "bronId": "00000000-0000-4000-8000-000000000030",
      "naam": "Nationale Vacaturebank"
    }
  ],
  "voorwaardenDrift": "26 entries, e.g. {\"bronId\":\"00000000-0000-4000-8000-00000000000f\",\"code\":\"te_toetsen\",\"db\":\"toegestaan\",\"slug\":\"asml\"}"
}
--- poller boot line ---
{"event":"bron_seed_drift","codeSources":49,"dbRows":43,"inSync":false,"inactive":["Intermediair","ProUnity","Rabobank"],"missingRows":["alliander","circle8","enexis","essent","indeed","linkedin","mercell","tennet","werk-nl"],"naamConflicts":["gasunie: Starapple","stedin: Werkzoeken"],"unknownRows":["Flextender","MI Public","Nationale Vacaturebank"],"voorwaardenDrift":26,"voorwaardenDriftByPair":{"te_toetsen->toegestaan":26}}
fingerprint after:  7955c49556164d714ec8f8d35b3ddcf3  unchanged: true
```

- The bron table fingerprint (md5 over every row) is identical before and after. The reconcile wrote nothing.
- 26 rows were reviewed `toegestaan` while the code seed says `te_toetsen`. The other 11 `te_toetsen` seeds have no row:
  9 are truly missing and 2 are id conflicts.
- **New finding:** the v1-backfill seeds use bronIds `…035` and `…036`. The registry uses the same ids for **Stedin** and **Gasunie**.
  In prod, those ids hold the Werkzoeken and Starapple rows. So Gasunie/Stedin show as "no row", and inserting their rows would
  conflict (`ON CONFLICT DO NOTHING`, so the seed silently skips them). The report flags these as `naamConflicts`. Fixing it
  needs a decision (new ids for Gasunie/Stedin) and is not part of this PR.

## Tests

- `packages/application/src/sources/seed-reconcile.spec.ts`: the measured drift shape, purity, in-sync, and the v1-id conflict.
- `apps/worker/src/seed-reconcile.spec.ts`:
  - against Postgres: a drift report that leaves rows untouched;
  - the reader's transaction is `READ ONLY`, and Postgres refuses a write inside it;
  - the boot line;
  - a failed read only logs and never throws.

## Follow-up (2026-10-11)

The `naamConflicts` above are resolved in code:
- Stedin moves to `…046` and Gasunie to `…047`. `…035`/`…036` stay Werkzoeken/Starapple.
- Both seed writers now throw `BronSeedIdCollisionError` instead of silently skipping a seed whose id is held by another bron.

For the prod steps, see `docs/plans/2026-10-11-stedin-gasunie-bron-ids.md` (`tools/postgres/bron-ids/`).
