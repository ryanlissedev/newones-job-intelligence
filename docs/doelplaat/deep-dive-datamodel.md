# Deep dive: Job Intelligence — Datamodel

_Zichtbare tekst van het tabblad, uitgelezen via Interceptor op 2026-08-27._

Terug naar de plaat
Laag 2 · Vacaturebronnen · deep dive · spec 0.2 + requirements

## Catapulze Job Intelligence

v1 live · v2 in specificatieCatapulze Job Intelligence — specificatie v2 (concept)versie 0.2 · 2026-08-26

Download HTMLJSON van de specJSON van de requirementsKaart op de plaat

OverzichtPipelineDatamodelBronnenDatalaagConfig & stackFasen & complianceJSON Schemav1-analyseRequirementsMapping v1 → v2

 Groep  Verplicht  Uit de bron bij  Zoek  75 van 75 velden

J verwacht aanwezig · D deels / soms · N meestal niet · A afgeleid · L achter login

| Veld | Type | Verpl. | Herkomst | Omschrijving | schema.org | MSP / broker | Global MSP | DAS / tender | Overheid | Jobboard | Werkenbij |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| aanvraag_id | uuid | ja | eigen | Eigen sleutel van de aanvraag in de datalaag. | identifier | A | A | A | A | A | A |
| bron_id | text | ja | config | Verwijzing naar de bron (bronregister). | — | A | A | A | A | A | A |
| bron_referentie | text | ja | bron | ID/kenmerk van de aanvraag bij de bron (bv. TN-563355, aanvraagnummer, ATS job id). Natuurlijke sleutel samen met bron_id. | identifier | J | J | J | J | J | J |
| bron_url | url | ja | bron | Canonieke URL van de aanvraag bij de bron. | url | J | L | J | J | J | J |
| bron_categorie | enum | ja | config | msp_broker \| global_msp \| das_tender \| overheidsportaal \| jobboard \| werkenbij | — | A | A | A | A | A | A |
| intermediair | text |  | bron/config | Broker/MSP die de aanvraag uitzet (bv. HeadFirst), als die afwijkt van de bron. | — | J | J | D | D | D | N |
| gepubliceerd_op | date |  | bron | Publicatiedatum volgens de bron. | datePosted | J | J | J | J | J | D |
| eerste_gezien_op | timestamptz | ja | eigen | Eerste run waarin de aanvraag is waargenomen. | — | A | A | A | A | A | A |
| laatst_gezien_op | timestamptz | ja | eigen | Laatste run waarin de aanvraag nog zichtbaar was; basis voor status-afleiding. | — | A | A | A | A | A | A |
| content_hash | text | ja | eigen | Hash van de genormaliseerde inhoud; wijziging = nieuwe versie. | — | A | A | A | A | A | A |
| versie | int | ja | eigen | Versienummer; historie in aanvraag_versie (SCD2). | — | A | A | A | A | A | A |
| dedup_groep_id | uuid |  | eigen | Cluster van dezelfde aanvraag die via meerdere bronnen/brokers binnenkomt. | — | A | A | A | A | A | A |
| raw_payload_ref | text | ja | eigen | Object-storage sleutel van de ruwe HTML/JSON van deze versie. | — | A | A | A | A | A | A |
| scrape_run_id | uuid | ja | eigen | Run die deze versie heeft opgehaald (herleidbaarheid). | — | A | A | A | A | A | A |
| taal | enum | ja | afgeleid | nl \| en \| overig — taal van de beschrijving. | inLanguage | A | A | A | A | A | A |
| titel | text | ja | bron | Functietitel zoals de bron die toont. | title | J | J | J | J | J | J |
| beschrijving | text (markdown) | ja | bron | Volledige omschrijving, HTML omgezet naar markdown; secties behouden. | description | L | L | J | J | J | J |
| functiegroep | enum | ja | afgeleid | Classificatie op Catapulze-profielen: ai_engineer \| ml_engineer \| data_engineer \| data_scientist \| platform_engineer \| cloud_engineer \| devops_sre \| cloud_architect \| security_engineer \| software_engineer \| overig. | occupationalCategory | A | A | A | A | A | A |
| vakgebied_bron | text |  | bron | Categorie/vakgebied zoals de bron die hanteert (bv. 'ICT', 'Data & Analytics'). | occupationalCategory | J | J | D | J | J | D |
| opdrachtgever_naam | text |  | bron | Eindklant / aanbestedende dienst / werkgever. Bij brokers soms geanonimiseerd ('een gemeente in Zuid-Holland'). | hiringOrganization | D | L | J | J | J | J |
| opdrachtgever_type | enum |  | afgeleid | overheid \| semi_overheid \| commercieel \| onbekend. | — | A | A | A | A | A | A |
| opdrachtgever_kvk | text |  | verrijking | KvK-nummer via verrijking (Clay/KvK) — koppelsleutel naar organisatie. | — | N | N | D | N | N | N |
| sector | text |  | bron/afgeleid | Sector/branche van de opdrachtgever. | industry | D | D | D | J | J | D |
| aantal_posities | int |  | bron | Aantal in te vullen posities (default 1). | totalJobOpenings | D | J | D | D | N | N |
| locatie_plaats | text |  | bron | Standplaats. | jobLocation.address.addressLocality | J | J | D | J | J | J |
| locatie_provincie | text |  | bron/afgeleid | Provincie (uit bron of afgeleid uit plaats). | jobLocation.address.addressRegion | J | D | A | J | A | A |
| locatie_land | text | ja | afgeleid | ISO-landcode, default NL. | jobLocation.address.addressCountry | A | J | J | A | A | A |
| werkplek | enum |  | bron/afgeleid | onsite \| hybride \| remote \| onbekend. | jobLocationType | D | D | D | D | D | J |
| remote_pct | int (0-100) |  | afgeleid | Percentage remote als de bron dat noemt ('remote werken mogelijk voor 50%'). | — | D | N | D | D | N | D |
| uren_per_week_min | numeric |  | bron | Minimale inzet per week. | workHours | J | J | J | J | J | D |
| uren_per_week_max | numeric |  | bron | Maximale inzet per week. | workHours | J | J | J | J | J | D |
| startdatum | date |  | bron | Gewenste startdatum ('z.s.m.' → null + vlag start_zsm). | jobStartDate | J | J | J | J | D | N |
| start_zsm | bool |  | afgeleid | Start zo snel mogelijk. | jobImmediateStart | A | A | A | A | A | A |
| einddatum | date |  | bron | Einddatum initiële periode. | — | J | J | J | J | N | N |
| duur_maanden | numeric |  | bron/afgeleid | Looptijd in maanden (afgeleid uit start/einde als de bron alleen een duur noemt). | jobDuration | J | J | J | J | D | N |
| verlenging_mogelijk | bool |  | bron | Optie tot verlenging. | — | J | D | J | J | N | N |
| verlenging_tekst | text |  | bron | Verlengingsopties zoals de bron ze beschrijft ('maximaal 2 × 12 maanden'). | — | J | D | J | J | N | N |
| tarief_min | numeric |  | bron | Ondergrens tarief (indien range). | baseSalary.value.minValue | D | L | D | J | N | N |
| tarief_max | numeric |  | bron | Maximumtarief of bovengrens; bij brokers het belangrijkste commerciële veld. | baseSalary.value.maxValue | L | L | D | J | N | N |
| tarief_eenheid | enum |  | bron | uur \| dag \| maand. | baseSalary.value.unitText | J | J | D | J | N | N |
| tarief_valuta | text |  | afgeleid | ISO-valuta, default EUR. | salaryCurrency | A | J | A | A | A | A |
| tarief_type | enum |  | afgeleid | maximum \| indicatie \| vast \| onbekend — wat het genoemde tarief betekent. | — | A | A | A | A | A | A |
| tarief_inclusief | text |  | bron | Wat in het tarief zit (reiskosten, excl. btw, incl. brokerfee). | — | L | L | D | D | N | N |
| salaris_min | numeric |  | bron | Salarisondergrens (vaste functies). | baseSalary.value.minValue | N | N | N | D | D | D |
| salaris_max | numeric |  | bron | Salarisbovengrens (vaste functies). | baseSalary.value.maxValue | N | N | N | D | D | D |
| salaris_periode | enum |  | bron | maand \| jaar. | baseSalary.value.unitText | N | N | N | D | D | D |
| inhuurvorm | enum[] |  | bron/afgeleid | zzp \| detachering \| payroll \| vast \| sow \| onbekend — meerdere mogelijk. | employmentType | J | J | D | J | J | J |
| zzp_toegestaan | bool |  | bron | Expliciet of ZZP is toegestaan (Wet DBA-context). | — | J | D | D | J | N | N |
| dienstverband | enum |  | bron | fulltime \| parttime \| onbekend (vaste functies). | employmentType | N | N | N | N | J | J |
| aantal_kandidaten_per_leverancier | int |  | bron | Maximaal aantal kandidaten dat een leverancier mag voorstellen. | — | L | L | D | D | N | N |
| screening | text[] |  | bron/afgeleid | VOG, VGB/AIVD-screening, referenties, geheimhoudingsverklaring. | securityClearanceRequirement | D | D | D | D | N | N |
| taaleisen | text[] |  | bron/afgeleid | Vereiste talen en niveau ('Nederlands near-native'). | — | D | D | D | D | D | D |
| opleidingsniveau | enum |  | bron/afgeleid | mbo \| hbo \| wo \| onbekend. | educationRequirements | J | D | D | J | J | D |
| ervaring_jaren_min | int |  | afgeleid | Minimaal aantal jaren ervaring uit de eisen. | experienceRequirements | A | A | A | A | A | A |
| eisen | jsonb[] {tekst, knockout:bool} |  | bron | Harde eisen (knock-out) als lijst; bij brokers/overheid vrijwel altijd expliciet gescheiden van wensen. | qualifications | J | D | J | J | D | D |
| wensen | jsonb[] {tekst, weging} |  | bron | Wensen met eventuele weging/punten. | — | J | D | J | J | D | D |
| competenties | text[] |  | bron | Gedragscompetenties zoals de bron ze noemt. | skills | D | N | D | D | D | D |
| skills | text[] |  | afgeleid | Genormaliseerde technische skills (taxonomie Catapulze: bv. python, kubernetes, azure, langchain). | skills | A | A | A | A | A | A |
| gunningscriteria | jsonb[] {criterium, weging_pct} |  | bron | Beoordelingscriteria met weging (prijs/kwaliteit, interview). | — | L | N | J | D | N | N |
| interviewdata | text |  | bron | Geplande gespreksdata/-week. | — | L | N | D | D | N | N |
| procedure_type | text |  | bron | DAS, minicompetitie, open procedure, marktplaats — vooral overheid. | — | D | N | J | D | N | N |
| sluitingsdatum | timestamptz |  | bron | Deadline voor indienen, inclusief tijdstip als de bron dat noemt. | validThrough | J | J | J | J | D | N |
| status | enum | ja | afgeleid | open \| gesloten \| ingetrokken \| vervuld \| onbekend — afgeleid uit bronstatus, sluitingsdatum en 'niet meer gezien'. | — | A | A | A | A | A | A |
| status_bron | text |  | bron | Status zoals de bron die toont ('Open', 'Gesloten', 'In beoordeling'). | — | J | J | J | D | N | N |
| gesloten_gedetecteerd_op | timestamptz |  | eigen | Moment waarop Job Intelligence de aanvraag als gesloten heeft gemarkeerd. | — | A | A | A | A | A | A |
| contact_naam | text |  | bron | Contactpersoon (PII — beperkte retentie). | applicationContact.name | L | L | J | D | D | D |
| contact_email | text |  | bron | E-mail contactpersoon (PII). | applicationContact.email | L | L | J | D | D | D |
| contact_telefoon | text |  | bron | Telefoon contactpersoon (PII). | applicationContact.telephone | L | L | D | D | D | D |
| bijlagen | jsonb[] {naam, url, mime, ref} |  | bron | Documenten bij de aanvraag (functieprofiel, nota van inlichtingen); kopie in object storage. | — | L | L | J | D | N | N |
| bron_specifiek | jsonb |  | bron | Alle bronvelden die niet in het canonieke model passen, met bronveldnaam als sleutel. Verliesvrij; per bron gedocumenteerd in het bronregister. | — | J | J | J | J | J | J |
| compleetheid_score | numeric (0-1) | ja | eigen | Aandeel gevulde kernvelden; stuurt datakwaliteit-dashboards. | — | A | A | A | A | A | A |
| relevantie_score | numeric (0-1) |  | AI | Past de aanvraag bij de Catapulze-profielen (AI/platform engineering)? LLM-classificatie met reden. | — | A | A | A | A | A | A |
| relevantie_reden | text |  | AI | Korte motivatie van de score (transparantie, AI Act). | — | A | A | A | A | A | A |
| extractie_methode | enum | ja | eigen | api \| jsonld \| html_parser \| llm — hoe de velden zijn verkregen. | — | A | A | A | A | A | A |
| extractie_confidence | numeric (0-1) |  | eigen | Zekerheid van LLM-extractie per record; lage scores gaan naar review. | — | A | A | A | A | A | A |
