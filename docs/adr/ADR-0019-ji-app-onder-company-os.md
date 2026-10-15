# ADR-0019 — Job Intelligence wordt applicatie #1 onder het Company OS

- Status: Proposed; volgt de status van OS-ADR-0001 (`../newones-company-os/docs/adr/ADR-0001-company-os-multi-tenant-metered.md`)
- Datum: 2026-10-13
- Eigenaar: Ryan (platform)
- Approver: Ryan; het platformbesluit zelf wordt door Robbie geaccepteerd in OS-ADR-0001
- Issues: THE-5, THE-11 (registry-extractie), THE-10, THE-12; historisch CTP-346, CTP-459
- Zie ook: OS-ADR-0001 (`../newones-company-os/docs/adr/ADR-0001-company-os-multi-tenant-metered.md`), [ADR-0016 §6](ADR-0016-candidate-intelligence-module-contract.md), [AGENT_NATIVE_ARCHITECTURE](../AGENT_NATIVE_ARCHITECTURE.md)

## Context

Het Company OS heeft een eigen repository en ADR-reeks (`../newones-company-os/docs/adr/`). Het platformbesluit — apart gebouwd, multi-tenant en metered vanaf de eerste regel code — staat in OS-ADR-0001. Dit ADR legt alleen vast wat dat voor Job Intelligence betekent.

## Besluit

1. **JI is applicatie #1 onder het OS**, niet de kiem waaruit het OS groeit. JI houdt domeinlogica (bronnen, ingest, curatie, search, snapshot, export); controlfunctie verhuist naar het OS.
2. **De capability-registry wordt geëxtraheerd** uit `packages/application/src/registry/` naar `@os/core` (THE-11). JI registreert zijn capabilities daar; REST en MCP in JI roepen de OS-invoker aan. Geen gedragsverandering: parity- en coverage-checks blijven groen.
3. **Elke JI-invoke levert een Receipt** via het OS (THE-12), met tenant, principal, correlation-ID en kosten. `audit_event` blijft bestaan voor JI-interne events; het OS-Receipt is de factuur- en evidencebasis.
4. **JI-tabellen met tenant-data krijgen `tenant_id` + RLS** volgens OS-ADR-0001 §3.1 (THE-10). Tot die slice af is draait JI met één tenant (Newones); er is geen single-tenant tussenpad dat later gemigreerd wordt.
5. **ADR-0016 §6** (single-tenant tot een expliciet multi-tenant productbesluit) is ingevuld door OS-ADR-0001; SG-10 blijft gelden tot THE-10 geïmplementeerd en geverifieerd is.

## Gevolgen

- CTP-346 en CTP-459 (RJCT-STUDIO) worden doorverwezen naar project Company OS in workspace The New ones.
- JI hernoemen en verhuizen (THE-15) gebeurt na slice 1, niet ervoor.
- Nieuwe JI-capabilities worden vanaf nu in `@os/core`-vorm beschreven, ook vóór de extractie is afgerond.
