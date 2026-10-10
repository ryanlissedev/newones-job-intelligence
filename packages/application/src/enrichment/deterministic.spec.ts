import { describe, expect, it } from "bun:test";

import { extractDeterministicEnrichment } from "./deterministic";

describe("deterministic enrichment", () => {
  it("extracts labeled locatie from collapsed HTML text", () => {
    const proposals = extractDeterministicEnrichment({
      beschrijving:
        "<p>Locatie:</p> <strong>Utrecht</strong> <p>Tarief: onbekend</p>",
      fields: ["locatie"],
    });

    expect(proposals).toEqual([
      expect.objectContaining({
        confidence: 0.9,
        field: "locatie",
        source: "deterministic",
        value: { locatieTekst: "Utrecht" },
      }),
    ]);
  });

  it("extracts tarief from euro range text without inventing amounts", () => {
    const proposals = extractDeterministicEnrichment({
      beschrijving: "Max tarief €110 per uur voor deze opdracht.",
      fields: ["tarief"],
    });

    expect(proposals).toEqual([
      expect.objectContaining({
        field: "tarief",
        value: {
          eenheid: "uur",
          max: "110",
          min: "unknown",
          valuta: "EUR",
        },
      }),
    ]);
  });

  it("does not invent tarief when only the word tarief appears without amounts", () => {
    const proposals = extractDeterministicEnrichment({
      beschrijving: "Tarief in overleg.",
      fields: ["tarief"],
    });

    expect(proposals).toEqual([]);
  });

  it("extracts contract and remote labels from plain text", () => {
    const proposals = extractDeterministicEnrichment({
      beschrijving:
        "Contractvorm: detachering\nWerkvorm: Volledig remote\nLocatie: Amsterdam",
      fields: ["contract", "remote", "locatie"],
    });

    expect(proposals.map((proposal) => proposal.field).toSorted()).toEqual([
      "contract",
      "locatie",
      "remote",
    ]);
    expect(
      proposals.find((proposal) => proposal.field === "contract")?.value
    ).toEqual({ contracttype: "detachering" });
    expect(
      proposals.find((proposal) => proposal.field === "remote")?.value
    ).toEqual({ werkvorm: "Volledig remote" });
  });
});

const NVB_JOBPOSTING_HTML = `<html><head>
<script type="application/ld+json">
{"@context":"https://schema.org/","@type":"JobPosting","datePosted":"2026-08-10T22:00:00Z","title":"Adviseur"}
</script>
</head><body>35 dagen geleden</body></html>`;

const FLEXTENDER_JOBPOSTING_HTML = `<html><head>
<script type="application/ld+json">
{"@context":"https://schema.org/","@type":"JobPosting","title":"Senior Java Developer","description":"<p>Je bouwt mee aan een veilig Java-platform voor gemeentelijke dienstverlening.</p><p>Je werkt samen met product owners en ontwikkelaars in een multidisciplinair team.</p>"}
</script>
</head><body><main><h1>Senior Java Developer</h1><p>Reageer vandaag.</p></main><footer>Cookie-instellingen</footer></body></html>`;

const flextenderFallbackParts = {
  externalId: "abc-123",
  platform: "flextender",
  title: "Senior Java Developer",
} as const;

describe("deterministic beschrijving enrich", () => {
  it("fills the exact Flextender title fallback from JobPosting.description", () => {
    const proposals = extractDeterministicEnrichment({
      beschrijving: "Senior Java Developer (flextender/abc-123)",
      fields: ["beschrijving"],
      rawHtml: FLEXTENDER_JOBPOSTING_HTML,
      titleFallbackParts: flextenderFallbackParts,
    });

    expect(proposals).toEqual([
      expect.objectContaining({
        confidence: 0.95,
        field: "beschrijving",
        rawRefs: [
          expect.objectContaining({
            field: "beschrijving",
            sourcePath: "rawHtml.jobPosting.description",
          }),
        ],
        source: "deterministic",
        value: {
          beschrijving:
            "Je bouwt mee aan een veilig Java-platform voor gemeentelijke dienstverlening. Je werkt samen met product owners en ontwikkelaars in een multidisciplinair team.",
        },
      }),
    ]);
  });

  it("does not overwrite non-placeholder descriptions", () => {
    expect(
      extractDeterministicEnrichment({
        beschrijving: "Een door de bron gepubliceerde beschrijving.",
        fields: ["beschrijving"],
        rawHtml: FLEXTENDER_JOBPOSTING_HTML,
        titleFallbackParts: flextenderFallbackParts,
      })
    ).toEqual([]);
  });

  it("does not invent a description from title or boilerplate", () => {
    const boilerplate = `<script type="application/ld+json">${JSON.stringify({
      "@type": "JobPosting",
      description: "Accepteer alle cookies om verder te gaan",
    })}</script>`;
    expect(
      extractDeterministicEnrichment({
        beschrijving: "Senior Java Developer (flextender/abc-123)",
        fields: ["beschrijving"],
        rawHtml: boilerplate,
        titleFallbackParts: flextenderFallbackParts,
      })
    ).toEqual([]);

    expect(
      extractDeterministicEnrichment({
        beschrijving: "Senior Java Developer (flextender/abc-123)",
        fields: ["beschrijving"],
        rawHtml:
          "<html><body><main><nav>Home Vacatures Contact</nav><h1>Senior Java Developer</h1></main></body></html>",
        titleFallbackParts: flextenderFallbackParts,
      })
    ).toEqual([]);
  });

  it("uses the documented main content fallback when JSON-LD has no description", () => {
    const proposals = extractDeterministicEnrichment({
      beschrijving: "Senior Java Developer (flextender/abc-123)",
      fields: ["beschrijving"],
      rawHtml:
        "<html><body><main><h1>Senior Java Developer</h1><p>Werk aan een modern Java-platform met een ervaren team.</p></main></body></html>",
      titleFallbackParts: flextenderFallbackParts,
    });

    expect(proposals[0]).toMatchObject({
      field: "beschrijving",
      rawRefs: [{ field: "beschrijving", sourcePath: "rawHtml.main" }],
      value: {
        beschrijving:
          "Senior Java Developer Werk aan een modern Java-platform met een ervaren team.",
      },
    });
  });
});

describe("deterministic publicatiedatum enrich", () => {
  it("fills publicatiedatum from JobPosting datePosted in rawHtml", () => {
    const proposals = extractDeterministicEnrichment({
      beschrijving: "35 dagen geleden",
      fields: ["publicatiedatum"],
      rawHtml: NVB_JOBPOSTING_HTML,
    });

    expect(proposals).toEqual([
      expect.objectContaining({
        confidence: 0.95,
        field: "publicatiedatum",
        source: "deterministic",
        value: { publicatiedatum: "2026-08-10T22:00:00Z" },
      }),
    ]);
  });

  it("does not invent publicatiedatum from relative age text alone", () => {
    const proposals = extractDeterministicEnrichment({
      beschrijving: "Gepubliceerd: 35 dagen geleden",
      fields: ["publicatiedatum"],
      rawHtml: "<html><body>35 dagen geleden</body></html>",
    });

    expect(proposals).toEqual([]);
  });
});

describe("deterministic detail-field enrichment (CTP-611)", () => {
  it("extracts uren per week from Dutch and English labels", () => {
    for (const [label, expected] of [
      ["Uren per week: 36", "36"],
      ["Aantal uur: 32-40", "32–40"],
      ["Hours per week: 24 uur", "24"],
    ] as const) {
      const proposals = extractDeterministicEnrichment({
        beschrijving: `Mooie opdracht. ${label}.`,
        fields: ["uren"],
      });
      expect(proposals).toEqual([
        expect.objectContaining({
          confidence: 0.9,
          field: "uren",
          rawRefs: [
            expect.objectContaining({
              field: "uren",
              sourcePath: "beschrijving",
            }),
          ],
          source: "deterministic",
          value: { urenPerWeek: expected },
        }),
      ]);
    }
  });

  it("extracts opleiding from Dutch and English labels", () => {
    for (const label of [
      "Opleidingsniveau: HBO",
      "Opleiding: WO",
      "Education level: Bachelor",
    ]) {
      const proposals = extractDeterministicEnrichment({
        beschrijving: `Functie-eisen. ${label}.`,
        fields: ["opleiding"],
      });
      expect(proposals).toHaveLength(1);
      expect(proposals[0]?.field).toBe("opleiding");
    }
    const proposals = extractDeterministicEnrichment({
      beschrijving: "Opleidingsniveau: HBO",
      fields: ["opleiding"],
    });
    expect(proposals[0]?.value).toEqual({ opleidingsniveau: "HBO" });
    expect(proposals[0]?.confidence).toBeGreaterThanOrEqual(0.85);
  });

  it("normalises labeled dates to ISO", () => {
    const cases = [
      {
        expected: "2026-10-01",
        field: "startdatum" as const,
        text: "Startdatum: 01-10-2026",
      },
      {
        expected: "2026-10-01",
        field: "startdatum" as const,
        text: "Start: 1 oktober 2026",
      },
      {
        expected: "2026-10-01",
        field: "startdatum" as const,
        text: "Start date: 2026-10-01",
      },
      {
        expected: "2027-03-31",
        field: "einddatum" as const,
        text: "Einddatum: 31-03-2027",
      },
      {
        expected: "2027-03-31",
        field: "einddatum" as const,
        text: "Loop tot: 31 maart 2027",
      },
      {
        expected: "2027-03-31",
        field: "einddatum" as const,
        text: "End date: 2027-03-31",
      },
      {
        expected: "2026-09-15",
        field: "sluitingsdatum" as const,
        text: "Sluitingsdatum: 15-09-2026",
      },
      {
        expected: "2026-09-15",
        field: "sluitingsdatum" as const,
        text: "Reageren voor: 15 september 2026",
      },
      {
        expected: "2026-09-15",
        field: "sluitingsdatum" as const,
        text: "Apply by: 2026-09-15",
      },
    ];
    for (const { expected, field, text } of cases) {
      const proposals = extractDeterministicEnrichment({
        beschrijving: text,
        fields: [field],
      });
      expect(proposals).toEqual([
        expect.objectContaining({
          field,
          source: "deterministic",
          value: { [field]: expected },
        }),
      ]);
      expect(proposals[0]?.confidence).toBeGreaterThanOrEqual(0.85);
      expect(proposals[0]?.rawRefs[0]).toMatchObject({
        field,
        sourcePath: "beschrijving",
      });
      expect(proposals[0]?.rawRefs[0]?.excerpt).toContain(
        text.split(":")[0] ?? ""
      );
    }
  });

  it("keeps an ISO datetime closing moment as an instant", () => {
    const proposals = extractDeterministicEnrichment({
      beschrijving: "Sluitingsdatum: 2026-09-15T12:00:00Z",
      fields: ["sluitingsdatum"],
    });
    expect(proposals).toHaveLength(1);
    expect(proposals[0]?.value).toEqual({
      sluitingsdatum: "2026-09-15T12:00:00.000Z",
    });
  });

  it("extracts organisatie from Dutch and English labels", () => {
    for (const [label, expected] of [
      ["Organisatie: Gemeente Utrecht", "Gemeente Utrecht"],
      ["Opdrachtgever: Ministerie van BZK", "Ministerie van BZK"],
      ["Client: ProRail", "ProRail"],
    ] as const) {
      const proposals = extractDeterministicEnrichment({
        beschrijving: `Opdracht. ${label}.`,
        fields: ["organisatie"],
      });
      expect(proposals).toEqual([
        expect.objectContaining({
          field: "organisatie",
          source: "deterministic",
          value: { organisatie: expected },
        }),
      ]);
    }
  });

  it("extracts labeled detail fields from rawHtml text", () => {
    const proposals = extractDeterministicEnrichment({
      beschrijving: "Senior Java Developer (flextender/abc-123)",
      fields: ["uren", "opleiding", "organisatie"],
      rawHtml:
        "<html><body><dl><dt>Uren per week</dt><dd>36</dd><dt>Opleidingsniveau</dt><dd>HBO</dd></dl><p>Opdrachtgever: Gemeente Utrecht</p></body></html>",
      titleFallbackParts: flextenderFallbackParts,
    });

    expect(proposals.map((proposal) => proposal.field).toSorted()).toEqual([
      "opleiding",
      "organisatie",
      "uren",
    ]);
    expect(
      proposals.find((proposal) => proposal.field === "uren")?.value
    ).toEqual({ urenPerWeek: "36" });
    expect(
      proposals.find((proposal) => proposal.field === "opleiding")?.value
    ).toEqual({ opleidingsniveau: "HBO" });
    expect(
      proposals.find((proposal) => proposal.field === "organisatie")?.value
    ).toEqual({ organisatie: "Gemeente Utrecht" });
  });

  it("trims a labeled value at the next label", () => {
    const proposals = extractDeterministicEnrichment({
      beschrijving:
        "Uren per week: 36 Opleidingsniveau: HBO Sluitingsdatum: 15-09-2026",
      fields: ["uren", "opleiding", "sluitingsdatum"],
    });
    expect(proposals).toHaveLength(3);
    expect(
      proposals.find((proposal) => proposal.field === "uren")?.value
    ).toEqual({ urenPerWeek: "36" });
    expect(
      proposals.find((proposal) => proposal.field === "opleiding")?.value
    ).toEqual({ opleidingsniveau: "HBO" });
    expect(
      proposals.find((proposal) => proposal.field === "sluitingsdatum")?.value
    ).toEqual({ sluitingsdatum: "2026-09-15" });
  });

  it("never proposes a detail field from unlabeled prose", () => {
    const proposals = extractDeterministicEnrichment({
      beschrijving:
        "Deze opdracht loopt van 1 oktober 2026 tot 31 maart 2027 voor 36 uur per week bij Gemeente Utrecht op HBO-niveau.",
      fields: [
        "uren",
        "opleiding",
        "startdatum",
        "einddatum",
        "sluitingsdatum",
        "organisatie",
      ],
    });
    expect(proposals).toEqual([]);
  });

  it("never proposes a detail field for junk or unparseable values", () => {
    const cases = [
      { field: "uren" as const, text: "Uren per week: bespreekbaar" },
      { field: "opleiding" as const, text: "Opleidingsniveau: n.v.t." },
      { field: "startdatum" as const, text: "Startdatum: in overleg" },
      { field: "startdatum" as const, text: "Startdatum: 32-13-2026" },
      { field: "einddatum" as const, text: "Einddatum: onbekend" },
      {
        field: "sluitingsdatum" as const,
        text: "Sluitingsdatum: z.s.m.",
      },
      { field: "organisatie" as const, text: "Opdrachtgever: n.a." },
    ];
    for (const { field, text } of cases) {
      expect(
        extractDeterministicEnrichment({ beschrijving: text, fields: [field] })
      ).toEqual([]);
    }
  });
});
