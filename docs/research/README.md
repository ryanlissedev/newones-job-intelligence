# Research — 27 augustus 2026

Ruwe onderzoeksrapporten die de besluiten in `../brainstorms/2026-08-27-techstack-brainstorm.md`, `../AGENT_NATIVE_ARCHITECTURE.md`, `../SOURCE_MATRIX.md` en `../interne kostenkaart` onderbouwen. Elk rapport is door een aparte onderzoeksagent gemaakt; alleen daadwerkelijk opgehaalde URL's zijn geciteerd; benchmarks zijn lokaal gedraaid (scripts in `bench/`).

| Bestand | Vraag | Uitkomst |
|---|---|---|
| `search-architecture.md` | Instant Boolean-search over 2,5–15M vacatures, self-hosted | Postgres SoR + Manticore RT via outbox; ParadeDB runner-up; DuckDB/LanceDB/Lakebase/Meili/Typesense afgewezen |
| `hosting-cost-comparison-2026-08.md` | Hostingkosten van JI PoC tot 3–5 gedeelde Catapulze-platforms | Hetzner + Coolify blijft de voorkeursroute; Railway is de ops-arme tweede keuze; GCP direct alleen bij behoefte aan managed HA/back-ups; Encore past niet bij de huidige stack |
| `orchestration.md` | Trigger.dev optimaliseren vs Temporal; kosten bij 1M en 6M fetches | Trigger.dev Cloud (TS-runtime); fan-out per bron; self-host boven $150–200/mnd |
| `workers-language-and-managed-scraping.md` | Rust/Go vs Bun voor de pipeline; Browserbase/Stagehand/Firecrawl | Alles TypeScript (168 CPU-s/mnd te winnen); per-bord ladder |
| `het motian-profiel (intern document, niet in deze repo)` | Wat is herbruikbaar uit motian | Scrapers lift; search rebuild (index-mismatch) |
| `ducklake.md` | DuckLake voor marts/export | (b) export/analytics-laan naast Postgres-marts |
| `openship.md` | Wat leert oblien/openship ons | MCP-catalogus uit registry; per-call her-auth; `resolveWith[]` |
| `source-verification.md` | 20 "aanname"-bronnen geverifieerd | zie `../SOURCE_MATRIX.md` (dit is het bewijs erachter) |
| `source-probes-2026-08-31.md` | Welke publieke ingest-route en velddekking hebben negen Slice C-bronnen? | Per-bron ingest-recept, fallback en bouwvolgorde op basis van afgeronde browser-probes |
| `redteam-doelplaat.md` | RedTeam op doelarchitectuur v1.1 | fix-first: lagen kloppen, volgorde niet |
| `bench/` | Bun vs Go vs Rust micro-benchmarks (MinHash, 50-concurrent fetch) | reproduceerbaar |
| `../artifacts/` | HTML-overzichten (techstack, redteam) | statisch, zelfstandig |

Niet opgenomen: verwijzingen naar interne projecten van derden waaruit patronen zijn overgenomen (bewust geanonimiseerd in `../artifacts/techstack-overzicht.html` §7).
