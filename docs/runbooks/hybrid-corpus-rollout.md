# Hybrid corpus-rollout (Manticore 29)

Status: **Blocked on RJC-418** (on-box Postgres + Trigger static-IP allowlist).
Do not start a full-corpus embedding pass against Neon Free.

Besluitkader: [ADR-0009](../adr/ADR-0009-manticore-29-hybrid.md) (Proposed —
hybrid blijft achter `SEARCH_HYBRID=1` tot productiecapaciteit is bewezen).
SoR-verhuizing: [ADR-0011](../adr/ADR-0011-postgres-on-box-trigger-static-ips.md).

## Waarom wachten

1. Neon Free zit tegen de 512 MB-limiet (RJC-404); een reindex die outbox +
   projection state groeit, raakt die limiet opnieuw.
2. Embedding-doorvoer op Manticore 29 is CPU-gebonden. Operatorraming voor de
   geplande volledige uitrol: **~95 minuten** embeddings-tijd op de CX43 —
   lang genoeg om SoR-stabiliteit en projector-lag eerst groen te willen zien.
3. RJC-418 DoD (on-box Postgres, `/readyz`, projector-lag 0, Trigger.dev polls
   via allowlist, R2 restore-drill) is de harde poort vóór Motian-full-copy
   (RJC-405) en vóór deze rollout.

## Uitvoervoorwaarden (na RJC-418 groen)

1. Nieuwe search-generatie starten (`bun run search:new-generation`) met de
   v5 hybrid schema-hash uit ADR-0009; projector op Manticore 29.
2. Corpus projecteren (actieve + archive partities) met embeddings aan; houd
   CPU/RAM en `embeddingDocsPerSecond` bij.
3. Lege-tabel-proof en reconcile (`bun run search:reconcile-projection`) vóór
   het omschakelen van `SEARCH_HYBRID=0` → `1` op server/web.
4. Relevance-smoke op een vaste golden subset; geen productie-cutover op alleen
   de 33-doc lokale meting uit ADR-0009.
5. Rollback: `SEARCH_HYBRID=0` + vorige lexicale generatie; embeddings-tabellen
   mogen blijven staan.

## Bewijs dat dit runbook eist

- Start-/eindtijd embeddings-pass, docs/s, CPU-piek.
- Projector-lag 0 gedurende en na de pass.
- `/readyz` componenten groen.
- Eén voor/na relevance-clip of rapportartefact (geen Motian-PII).
