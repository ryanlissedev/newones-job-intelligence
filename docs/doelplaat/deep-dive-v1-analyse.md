# Deep dive: Job Intelligence — v1-analyse

_Zichtbare tekst van het tabblad, uitgelezen via Interceptor op 2026-08-27._

Terug naar de plaat
Laag 2 · Vacaturebronnen · deep dive · spec 0.2 + requirements

## Catapulze Job Intelligence

v1 live · v2 in specificatieCatapulze Job Intelligence — specificatie v2 (concept)versie 0.2 · 2026-08-26

Download HTMLJSON van de specJSON van de requirementsKaart op de plaat

OverzichtPipelineDatamodelBronnenDatalaagConfig & stackFasen & complianceJSON Schemav1-analyseRequirementsMapping v1 → v2

De v1-app "Jobs Intelligence" (neon-data-whisperer.lovable.app) is een React-frontend die **read-only** op een Neon Postgres-database leest (badge "read-only · neon"). Twee schermen:

### Dashboard

("Database overview — aggregates across the full jobs table; click any chart bar to open it in search"): KPI-tegels *Total jobs* (open/closed), *Distinct companies*, *Posted last 30 days*; grafieken *Jobs posted per week* (52 weken op `posted_at`), *Jobs per platform* (klik → zoekfilter), *Jobs per province* ("only 13% of jobs have a province set — casing normalised"), *Hourly rate distribution* ("€10 buckets on rate_min — only ~17% of jobs publish a rate"), *Data quality* ("share of jobs with each field filled in"), *Top skills across postings* ("from job_skills_v2 — long sentence-style entries filtered out").

Total jobsDistinct companiesPosted last 30 daysJobs per weekJobs per platformJobs per province · 13%Rate distribution · 17%Data qualityTop skills

### Search (/jobs)

vrije zoekterm met scope (`scope=title`), facetfilters *Platform*, *Status*, *Contract type*, *Work arrangement*, *Province*, *Skills* ("tagged skills from job_skills_v2; noisy sentence entries are hidden"), bereikfilters *Hourly rate (€)* en *Hours per week*, datumfilter *Posted between*, sortering (`sort=posted_desc`), paginering (10 per pagina), resultaattabel (Title, Company, Location, Rate, Hrs, Platform, Posted) en een detailpaneel per vacature (`job=`-parameter). De volledige filterstaat zit in de URL en is dus deelbaar.

q · scopePlatformStatusContract typeWork arrangementProvinceSkillsHourly rate €Hours/weekPosted betweensort · page · job=

### Database

Neon Postgres · database neondb · schema public · 33 tabellen · 432 kolommen · 64 constraints · 154 indexes · pgvector (embedding op jobs en candidates), pg_trgm (fuzzy tekst); alle IDs text; tijdstempels zonder tijdzone

| Cluster | Tabellen | Wat het ons vertelt |
| --- | --- | --- |
| Vacatures (kern) | `jobs` (240.131 rijen, 62 kolommen), `job_dedupe_ranks` (240.131), `overlap_groups` (1) | Eén brede tabel met canonieke velden, JSONB-lijsten (requirements, wishes, competences, conditions, languages, attachments, questions, faq_answers), contacten, geo, `raw_payload` in-row, `embedding` (pgvector), `search_vector` + trigger, dedupe-kolommen. Unieke sleutel `(platform, external_id)`. |
| Skills | `skills` (151.416), `job_skills_v2` (250.897), `skill_mappings` (2.081.947), `skill_aliases` (7.108), `esco_skills` (752), `job_skills` (0) | Twee generaties: ESCO-gebaseerd (v1, leeg) en vrije skills-tabel (v2). 151k "skills" op 240k vacatures en gemiddeld ~1 skill per vacature = taxonomie is verzadigd met ruis; UI filtert "sentence-style entries" weg. |
| Scraping | `scraper_configs` (7), `scrape_results` (3.472), `platform_catalog` (9), `platform_onboarding_runs` (21), `platform_daily_stats` (881), `platform_settings` (6) | Per platform: base_url, parameters, versleutelde auth, cron (default elke 4 uur), validatie- en test-importstatus, laatste run, `consecutive_failures` (circuit breaker). Catalogus met `adapter_kind`, `auth_mode`, `capabilities`, `config_schema`, `auth_schema`; onboarding-wizard met stappen, blockers en evidence. |
| Recruitment-flow | `candidates` (2), `job_matches` (41), `applications` (0), `interviews` (0), `messages` (0), `screening_calls` (0), `candidate_skills*` (0) | Aanzet tot matching, AI-screening (voice rooms, transcripts) en pipeline; nauwelijks gebruikt. Hoort in de to-be bij de agentlaag en Spott.io, niet bij Job Intelligence. |
| Platform/AI-huishouding | `agent_events` (732), `ai_usage` (21.986), `chat_sessions` (86) + `chat_session_messages`, `autopilot_runs` (21) + `autopilot_findings` (179), `kpi_snapshots` (126), `saved_searches` (0), `sidebar_metadata` (1), `gdpr_audit_log` (0) | Event-bus, LLM-kostenregistratie per flow/model, chat-over-data, zelftestende "autopilot" met GitHub-issues, dagelijkse KPI-snapshots, voorberekende facetten voor de sidebar, AVG-auditlog (leeg). |

### Kerntabellen en volumes (26-08-2026)

| Tabel | Rijen | Kolommen | Rol |
| --- | --- | --- | --- |
| jobs | 240.131 | 62 | Vacatures/aanvragen (kern) |
| job_dedupe_ranks | 240.131 | 4 | Dedupe-rang en -groep per vacature |
| job_skills_v2 | 250.897 | 9 | Skills per vacature (importance, confidence) |
| skills | 151.416 | 5 | Skills-lijst (ongecureerd) |
| skill_mappings | 2.081.947 | 15 | Ruwe skill → genormaliseerd → ESCO, reviewwachtrij |
| skill_aliases | 7.108 | 8 | Aliassen naar ESCO-URI |
| esco_skills | 752 | 10 | ESCO-subset |
| scraper_configs | 7 | 18 | Per platform: base_url, parameters, auth, cron, validatie, laatste run, consecutive_failures |
| scrape_results | 3.472 | 11 | Run-log: found/new/duplicates, status, errors, job_ids |
| platform_catalog | 9 | 15 | Adapter-catalogus: adapter_kind, auth_mode, capabilities, config_schema, auth_schema |
| platform_onboarding_runs | 21 | 14 | Onboarding-wizard: status, stap, blocker, next_actions, evidence |
| platform_daily_stats | 881 | 7 | Beschikbaarheid, views, applications per platform per dag |
| ai_usage | 21.986 | 10 | LLM-calls: flow, provider, model, tokens, kosten |
| agent_events | 732 | 14 | Event-bus tussen agents |
| kpi_snapshots | 126 | 7 | Dagelijkse KPI-snapshots |
| sidebar_metadata | 1 | 8 | Voorberekende facetten voor de zoek-sidebar |
| saved_searches | 0 | 6 | Opgeslagen zoekopdrachten (filters jsonb) |
| candidates / job_matches / screening_calls / applications / interviews / messages | 2 | — | Recruitment-flow (2 kandidaten, 41 matches, rest leeg) — buiten Job Intelligence |
| chat_sessions / chat_session_messages | 86 | — | Chat-over-data |
| autopilot_runs / autopilot_findings | 21 | — | Zelftest-journeys met bevindingen (GitHub-issues) |
| gdpr_audit_log | 0 | 8 | AVG-auditlog (leeg) |

### Wat v1 goed doet — en wat v2 moet oplossen

Behouden

Oplossen

Brede, gestructureerde `jobs`-tabel met eisen/wensen als lijsten, contactvelden, geo, bijlagen en `raw_payload`

Slechts ~13% provincie en ~17% tarief gevuld; datakwaliteit is zichtbaar in het dashboard maar wordt niet actief verbeterd

Unieke sleutel per bron `(platform, external_id)`; dedupe-rangen over bronnen heen

Dedupe-uitkomst staat in een losse tabel en één JSONB-blob (`overlap_groups.groups`); niet bevraagbaar, geen primaire bron per groep

Platformcatalogus met config-/auth-schema en onboarding-wizard; circuit breaker via `consecutive_failures`

Op 25-08 stonden álle scrapers op "Achterstallig": scheduler zonder externe bewaking, freshness is geen eerste-klas begrip

Skills per vacature met importance (required/nice) en confidence; ESCO-basis aanwezig

151k skills, 2M mappings, ~1 skill per vacature en ruis in de UI: taxonomie zonder curatie

Search met facetten, bereiken, URL-staat, detailpaneel; voorberekende sidebar-facetten; `search_vector` + pgvector

Full-text kolom is `text` in plaats van `tsvector`; geen versiegeschiedenis van een vacature; `raw_payload` in de rij maakt de tabel zwaar

LLM-kosten per flow (`ai_usage`), event-bus, KPI-snapshots, AVG-audittabel

Recruitment-flow (candidates, matches, screening) vermengd met de vacaturedata in één database en één app

### Wat uit v1 níet meegaat naar Job Intelligence

| v1-onderdeel | Besluit | Waarheen wel |
| --- | --- | --- |
| `candidates`, `candidate_skills*`, `job_matches`, `screening_calls`, `applications`, `interviews`, `messages` | Buiten Job Intelligence | Agentlaag (matching/kwalificatie via Company OS) en Spott.io (ATS/CRM) |
| `chat_sessions`, `chat_session_messages` | Optioneel (JI-DSH-07) | Als MCP-consument op de datalaag, niet als eigen tabellen in curated |
| `agent_events` | Vervangen door outbox/events (JI-INT-03) | Company OS event-bus |
| `autopilot_runs`, `autopilot_findings` | Concept behouden (JI-OPS-05) | CI/CD-pipeline |
| `ai_usage` | Behouden en uitgebreid (JI-DSH-06, JI-OPS-03) | Observability-laag (Langfuse + marts) |
| `kpi_snapshots`, `platform_daily_stats` | Behouden als marts (JI-DAT-11, JI-DSH-03) | `marts.*` |
| `esco_skills`, `skill_aliases`, `skill_mappings`, `skills` | Herbouwen als gecureerde taxonomie (JI-SKL) | `curated.skill`, `curated.skill_alias`, reviewwachtrij |
