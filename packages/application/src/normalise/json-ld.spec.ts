import { describe, expect, it } from "bun:test";

import {
  bamConfig,
  bluetrailConfig,
  createJsonLdClient,
  datajobsConfig,
  enecoConfig,
  intermediairConfig,
  nsConfig,
  prorailConfig,
  randstadConfig,
  stedinConfig,
  zzpOpdrachtenConfig,
} from "@ji/connectors/json-ld";
import type { JsonLdFetchedPayload, JsonLdNode } from "@ji/connectors/json-ld";
import { UNKNOWN } from "@ji/domain";

import {
  normaliseJsonLdObservation,
  parseDutchDate,
  parseJsonLdPayload,
} from "./json-ld";

const HASH = "sha256-test";

/** Formats `instant` as a `+02:00`-offset ISO string representing that exact
 * instant (used to exercise the parse-not-slice validThrough fix). */
const toOffsetString = (instant: Date): string => {
  const local = new Date(instant.getTime() + 2 * 60 * 60 * 1000);
  return `${local.toISOString().slice(0, -1)}+02:00`;
};

describe("parseDutchDate", () => {
  it("parses a Dutch textual date into ISO form", () => {
    expect(parseDutchDate("21 september 2026")).toBe("2026-09-21");
    expect(parseDutchDate("1 oktober 2026")).toBe("2026-10-01");
  });

  it("returns undefined for unparseable or missing text", () => {
    expect(parseDutchDate()).toBeUndefined();
    expect(parseDutchDate("marktconform")).toBeUndefined();
  });
});

describe("normaliseJsonLdObservation -- Werken voor Nederland", () => {
  it("maps the sample reference, title, and monthly base-salary band", () => {
    const payload: JsonLdFetchedPayload = {
      jobPosting: {
        "@type": "JobPosting",
        baseSalary: {
          "@type": "MonetaryAmount",
          currency: "EUR",
          value: {
            "@type": "QuantitativeValue",
            maxValue: 7094,
            minValue: 4818,
            unitText: "MONTH",
          },
        },
        datePosted: "2026-09-09",
        description:
          "Kubernetes Software Platform Engineer in Leeuwarden voor 32-36 uur bij Centraal Justitieel Incassobureau",
        employmentType: "TEMPORARY",
        identifier: { "@type": "PropertyValue", value: "69005" },
        title: "Kubernetes Software Platform Engineer",
      },
      labelBlock: {},
      parserVersion: "werken-voor-nederland/v2",
      slug: "werken-voor-nederland",
      url: "https://www.werkenvoornederland.nl/vacatures/kubernetes-software-platform-engineer-CJIB-2026-9570",
    };

    const draft = normaliseJsonLdObservation(
      new TextEncoder().encode(JSON.stringify(payload)),
      HASH
    );

    expect(draft.bronReferentie.value).toBe(
      "vacatures/kubernetes-software-platform-engineer-CJIB-2026-9570"
    );
    expect(draft.titel.value).toBe("Kubernetes Software Platform Engineer");
    expect(draft.tarief).toEqual({
      eenheid: "maand",
      max: "7094",
      min: "4818",
      valuta: "EUR",
    });
  });
});

describe("normaliseJsonLdObservation -- ASML", () => {
  it("keeps the literal title, Workday id, and Veldhoven location", () => {
    const body = new TextEncoder().encode(
      JSON.stringify({
        jobPosting: {
          "@type": "JobPosting",
          datePosted: "2026-08-17T00:00:00",
          description: "ASML electrical safety role in Veldhoven.",
          employmentType: "FULL_TIME",
          hiringOrganization: { "@type": "Organization", name: "ASML" },
          identifier: {
            "@type": "PropertyValue",
            name: "ASML",
            value: "J-00333473",
          },
          jobLocation: {
            address: {
              addressCountry: "NL",
              addressLocality: "Veldhoven",
            },
          },
          title:
            "Senior Electrical Safety Expert (Nominated Person – Installatie verantwoordelijke EUV Factory)",
        },
        labelBlock: {
          referentienummer: "J-00333473",
          workdayApplyUrl:
            "https://asml.wd3.myworkdayjobs.com/ASMLEXT1/job/Veldhoven-Netherlands/_J-00333473/apply",
        },
        parserVersion: "asml/v2",
        slug: "asml",
        url: "https://www.asml.com/en/careers/find-your-job/senior-electrical-safety-expert-nominated-person--installatie-verantwoordelijke-euv-factory-j00333473",
      })
    );

    const draft = normaliseJsonLdObservation(body, HASH);

    expect(draft.titel.value).toBe(
      "Senior Electrical Safety Expert (Nominated Person – Installatie verantwoordelijke EUV Factory)"
    );
    expect(draft.bronSpecifiek.value).toMatchObject({
      identifier: { value: "J-00333473" },
    });
    expect(draft.locatieTekst.value).toContain("Veldhoven");
  });
});

describe("normaliseJsonLdObservation -- Rabobank", () => {
  it("keeps the literal title, JR identifier, and Utrecht location", () => {
    const body = new TextEncoder().encode(
      JSON.stringify({
        jobPosting: {
          "@type": "JobPosting",
          datePosted: "2026-09-15",
          description:
            "As an Active Directory Engineer within Tech4IAM, you will play a key role.",
          employmentType: "fulltime",
          hiringOrganization: { "@type": "Organization", name: "Rabobank" },
          identifier: {
            "@type": "PropertyValue",
            name: "id",
            value: "JR_00144349",
          },
          jobLocation: {
            address: {
              addressCountry: "nl",
              addressLocality: "Utrecht",
              postalCode: "3521CB",
              streetAddress: "Croeselaan 18",
            },
          },
          title: "Active Directory  Engineer",
        },
        labelBlock: {},
        parserVersion: "rabobank/v2",
        slug: "rabobank",
        url: "https://rabobank.jobs/en/job/active-directory-engineer/JR_00144349/",
      })
    );

    const draft = normaliseJsonLdObservation(body, HASH);

    expect(draft.titel.value).toBe("Active Directory  Engineer");
    expect(draft.bronSpecifiek.value).toMatchObject({
      identifier: { value: "JR_00144349" },
    });
    expect(draft.locatieTekst.value).toContain("Utrecht");
  });
});

describe("normaliseJsonLdObservation -- TBI", () => {
  it("keeps the literal title, ubeeo identifier, and Amersfoort location", () => {
    const body = new TextEncoder().encode(
      JSON.stringify({
        jobPosting: {
          "@type": "JobPosting",
          datePosted: "2026-05-23T12:36:00+02:00",
          description:
            "Wil jij aan de slag als Service Technicus W in Amersfoort bij Croonwolter&dros?",
          employmentType: "Fulltime",
          hiringOrganization: {
            "@id": "ubeeo-8038",
            "@type": "Organization",
            name: "Croonwolter&dros",
          },
          identifier: {
            "@type": "PropertyValue",
            name: "Croonwolter&dros",
            value: "1280611",
          },
          jobLocation: [
            {
              address: {
                addressCountry: "NL",
                addressLocality: "Amersfoort",
              },
            },
          ],
          title: "Service Technicus W",
        },
        labelBlock: {},
        parserVersion: "tbi/v2",
        slug: "tbi",
        url: "https://werkenbij.tbi.nl/vacatures/service-technicus-w-1280611",
      })
    );

    const draft = normaliseJsonLdObservation(body, HASH);

    expect(draft.titel.value).toBe("Service Technicus W");
    expect(draft.bronSpecifiek.value).toMatchObject({
      identifier: { value: "1280611" },
    });
    expect(draft.locatieTekst.value).toContain("Amersfoort");
  });
});

describe("parseJsonLdPayload -- BlueTrail (label block in surrounding HTML, baseSalary present but ignored)", () => {
  const payload: JsonLdFetchedPayload = {
    jobPosting: {
      "@type": "JobPosting",
      // Real BlueTrail baseSalary is a constant Google-for-Jobs placeholder
      // (confirmed identical across 7 live detail pages, 2026-08-31) and must
      // never be used as tarief -- see parseJsonLdPayload's docblock.
      baseSalary: {
        "@type": "MonetaryAmount",
        currency: "EUR",
        value: { "@type": "QuantitativeValue", unitText: "", value: "100" },
      },
      datePosted: "2026-08-24",
      description: "Testscenario's opstellen, uitvoeren en rapporteren.",
      employmentType: "CONTRACTOR",
      hiringOrganization: { "@type": "Organization", name: "Kadaster" },
      identifier: { "@type": "PropertyValue", value: "a0jMI00000Pn1z3YAB" },
      jobLocation: {
        "@type": "Place",
        address: {
          "@type": "PostalAddress",
          addressLocality: "Apeldoorn",
          addressRegion: "Gelderland",
        },
      },
      title: "CIAM Tester",
    },
    labelBlock: {
      // Real "Competenties:" <ul> inner HTML, verbatim from the live
      // recording (fixtures/connectors/bluetrail/detail-adviseur-privacy-ibd.json,
      // captured 2026-09-16) -- including the source's own "<span >" spacing.
      competenties:
        "<li><span >Analytisch &amp; conceptueel sterk</span></li>" +
        "<li><span >Communicatief en verbindend</span></li>" +
        "<li><span >Organisatiesensitief</span></li>" +
        "<li><span >Overtuigingskracht</span></li>" +
        "<li><span >Zelfstandig, maar teamgericht</span></li>" +
        "<li><span >Sterke schrijfvaardigheid</span></li>",
      eindDatum: "31 december 2026",
      locatie: "Apeldoorn",
      referentienummer: "2026-08243",
      sluitingsDatum: "2 september 2026",
      startDatum: "1 september 2026",
      urenPerWeek: "32u p/w",
    },
    parserVersion: "bluetrail/v2",
    slug: "bluetrail",
    url: "https://www.bluetrail.nl/opdrachten/Interim/ciam-tester/",
  };

  it("normalises title, description, location and organisation", () => {
    const draft = parseJsonLdPayload(payload, HASH);
    expect(draft.titel.value).toBe("CIAM Tester");
    expect(draft.beschrijving.value).toBe(
      "Testscenario's opstellen, uitvoeren en rapporteren."
    );
    expect(draft.locatieTekst.value).toBe("Apeldoorn");
    expect(draft.locatieLand.value).toBe("NL");
    expect(draft.opdrachtgeverNaam.value).toBe("Kadaster");
    expect(draft.extractieMethode).toBe("jsonld");
  });

  it("parses the Dutch label-block startDatum into ISO", () => {
    const draft = parseJsonLdPayload(payload, HASH);
    expect(draft.startDatum.value).toBe("2026-09-01");
  });

  it.each(["", "UUR", "HOUR"])(
    "never reads BlueTrail's constant baseSalary for tarief (unitText %p)",
    (unitText) => {
      const draft = parseJsonLdPayload(
        {
          ...payload,
          jobPosting: {
            ...payload.jobPosting,
            baseSalary: {
              "@type": "MonetaryAmount",
              currency: "EUR",
              value: { "@type": "QuantitativeValue", unitText, value: "100" },
            },
          },
        },
        HASH
      );
      expect(draft.tarief).toEqual({
        eenheid: UNKNOWN,
        max: UNKNOWN,
        min: UNKNOWN,
        valuta: "EUR",
      });
    }
  );

  it("puts the reference code and label block into bronSpecifiek for cross-source dedup", () => {
    const draft = parseJsonLdPayload(payload, HASH);
    expect(draft.bronSpecifiek.value).toMatchObject({
      eind_datum: "31 december 2026",
      referentienummer: "2026-08243",
      slug: "bluetrail",
      sluitings_datum: "2 september 2026",
    });
  });

  it("maps the explicit jobLocation.address.addressRegion to the canonical provincie (F04)", () => {
    const draft = parseJsonLdPayload(payload, HASH);
    expect(draft.bronSpecifiek.value).toMatchObject({
      provincie: "Gelderland",
    });
  });

  it("leaves provincie null when the source publishes no addressRegion (honesty)", () => {
    const draft = parseJsonLdPayload(
      {
        ...payload,
        jobPosting: {
          ...payload.jobPosting,
          jobLocation: {
            "@type": "Place",
            address: { "@type": "PostalAddress", addressLocality: "Apeldoorn" },
          },
        },
      },
      HASH
    );
    expect(draft.bronSpecifiek.value).toMatchObject({ provincie: null });
  });

  it("puts employmentType under the contract_type key curate.ts actually reads (F06)", () => {
    const draft = parseJsonLdPayload(payload, HASH);
    expect(draft.bronSpecifiek.value).toMatchObject({
      contract_type: "CONTRACTOR",
    });
    expect(draft.bronSpecifiek.value).not.toMatchObject({
      employment_type: "CONTRACTOR",
    });
  });

  it("cleans the free-text label-block hours into a bare number (F08)", () => {
    const draft = parseJsonLdPayload(payload, HASH);
    expect(draft.bronSpecifiek.value).toMatchObject({ uren_per_week: "32" });
  });

  it("keeps the broker as opdrachtgeverNaam and leaves eindklant_naam null when the source doesn't explicitly label an end client (honesty, F02)", () => {
    const draft = parseJsonLdPayload(payload, HASH);
    expect(draft.opdrachtgeverNaam.value).toBe("Kadaster");
    expect(draft.bronSpecifiek.value).toMatchObject({ eindklant_naam: null });
  });

  it("promotes the explicit end client over the broker hiringOrganization (F02)", () => {
    const draft = parseJsonLdPayload(
      {
        ...payload,
        jobPosting: {
          ...payload.jobPosting,
          hiringOrganization: { "@type": "Organization", name: "Circle8" },
        },
        labelBlock: {
          ...payload.labelBlock,
          eindklant: "Gemeente Stichtse Vecht",
        },
      },
      HASH
    );
    expect(draft.opdrachtgeverNaam.value).toBe("Gemeente Stichtse Vecht");
    expect(draft.bronSpecifiek.value).toMatchObject({
      eindklant_naam: "Gemeente Stichtse Vecht",
    });
  });

  it("maps the structured 'Competenties:' list into skills, trimmed and entity-decoded (F15)", () => {
    const draft = parseJsonLdPayload(payload, HASH);
    expect(draft.bronSpecifiek.value).toMatchObject({
      skills: [
        "Analytisch & conceptueel sterk",
        "Communicatief en verbindend",
        "Organisatiesensitief",
        "Overtuigingskracht",
        "Zelfstandig, maar teamgericht",
        "Sterke schrijfvaardigheid",
      ],
    });
  });

  it("leaves skills empty when the source has no Competenties list (honesty)", () => {
    const { competenties: _competenties, ...labelBlockWithoutCompetenties } =
      payload.labelBlock;
    const draft = parseJsonLdPayload(
      { ...payload, labelBlock: labelBlockWithoutCompetenties },
      HASH
    );
    expect(draft.bronSpecifiek.value).toMatchObject({ skills: [] });
  });

  it("derives bronReferentie from the URL path", () => {
    const draft = parseJsonLdPayload(payload, HASH);
    expect(draft.bronReferentie.value).toBe("opdrachten/Interim/ciam-tester");
    expect(draft.bronUrl.value).toBe(payload.url);
  });
});

describe("parseJsonLdPayload -- Hero.eu (thin JobPosting, no label block)", () => {
  const payload: JsonLdFetchedPayload = {
    jobPosting: {
      "@type": "JobPosting",
      datePosted: "2026-08-25T11:32:08.423+00:00",
      description: "Voor het Nationaal Archief zoeken wij een DevOps Engineer.",
      hiringOrganization: {
        "@type": "Organization",
        name: "Hero Interim Professionals",
      },
      jobLocation: {
        "@type": "Place",
        address: { "@type": "PostalAddress", addressLocality: "Den Haag" },
      },
      title: "DevOps Engineer",
      workHours: "36 uur/week",
    },
    labelBlock: {},
    parserVersion: "hero/v2",
    slug: "hero",
    url: "https://hero.eu/interim-opdrachten/devops-engineer-1f2fde9f",
  };

  it("leaves startDatum UNKNOWN rather than mislabelling datePosted as a start date", () => {
    const draft = parseJsonLdPayload(payload, HASH);
    expect(draft.startDatum.value).toBe(UNKNOWN);
    expect(draft.startDatum.provenance.sourcePath).toBe(
      "labelBlock.startDatum"
    );
  });

  it("leaves tarief UNKNOWN when there is no tarief text", () => {
    const draft = parseJsonLdPayload(payload, HASH);
    expect(draft.tarief).toEqual({
      eenheid: UNKNOWN,
      max: UNKNOWN,
      min: UNKNOWN,
      valuta: "EUR",
    });
  });

  it("reflects the anonymised hiringOrganization, not the real end client in prose", () => {
    const draft = parseJsonLdPayload(payload, HASH);
    expect(draft.opdrachtgeverNaam.value).toBe("Hero Interim Professionals");
  });

  it("cleans workHours free text into a bare number (F08)", () => {
    const draft = parseJsonLdPayload(payload, HASH);
    expect(draft.bronSpecifiek.value).toMatchObject({ uren_per_week: "36" });
  });

  it("formats a dash-range hours text via formatHoursPerWeek's literal en-dash output (F08)", () => {
    const draft = parseJsonLdPayload(
      {
        ...payload,
        jobPosting: { ...payload.jobPosting, workHours: "32-40 uur" },
      },
      HASH
    );
    expect(draft.bronSpecifiek.value).toMatchObject({
      uren_per_week: "32–40",
    });
  });

  it("leaves uren_per_week null when workHours is absent (honesty)", () => {
    const { workHours: _workHours, ...jobPostingWithoutHours } =
      payload.jobPosting;
    const draft = parseJsonLdPayload(
      { ...payload, jobPosting: jobPostingWithoutHours },
      HASH
    );
    expect(draft.bronSpecifiek.value).toMatchObject({ uren_per_week: null });
  });
});

describe("parseJsonLdPayload -- Bij Oranje", () => {
  const payload: JsonLdFetchedPayload = {
    jobPosting: {
      "@type": "JobPosting",
      baseSalary: {
        "@type": "MonetaryAmount",
        currency: "EUR",
        value: { "@type": "QuantitativeValue", unitText: "HOUR", value: 0 },
      },
      datePosted: "2026-09-15",
      description: "Data Analist BI voor OD NHN.",
      employmentType: "CONTRACTOR",
      hiringOrganization: { "@type": "Organization", name: "OD NHN" },
      identifier: {
        "@type": "PropertyValue",
        name: "Bij Oranje",
        value: "65099",
      },
      jobLocation: {
        "@type": "Place",
        address: {
          "@type": "PostalAddress",
          addressCountry: "NL",
          addressRegion: "Noord-Holland",
        },
      },
      title: "Data Analist",
      validThrough: "2026-09-23T00:00:00+00:00",
    },
    labelBlock: {},
    parserVersion: "bij-oranje/v2",
    slug: "bij-oranje",
    url: "https://www.bijoranje.nl/vacatures/onbekend/data-analist-noord-holland-65099",
  };

  it("normalises the sample's shared JSON-LD fields", () => {
    const draft = parseJsonLdPayload(payload, HASH);

    expect(draft.bronReferentie.value).toBe(
      "vacatures/onbekend/data-analist-noord-holland-65099"
    );
    expect(draft.titel.value).toBe("Data Analist");
    expect(draft.opdrachtgeverNaam.value).toBe("OD NHN");
    expect(draft.bronSpecifiek.value).toMatchObject({
      contract_type: "CONTRACTOR",
      identifier: { name: "Bij Oranje", value: "65099" },
      provincie: "Noord-Holland",
      publicatiedatum: "2026-09-15",
      slug: "bij-oranje",
      valid_through: "2026-09-23T00:00:00+00:00",
    });
  });

  it("does not promote the published zero HOUR placeholder to tarief", () => {
    const draft = parseJsonLdPayload(payload, HASH);

    expect(draft.tarief).toEqual({
      eenheid: UNKNOWN,
      max: UNKNOWN,
      min: UNKNOWN,
      valuta: "EUR",
    });
  });

  it("still accepts a positive explicit base-salary amount", () => {
    const draft = parseJsonLdPayload(
      {
        ...payload,
        jobPosting: {
          ...payload.jobPosting,
          baseSalary: {
            "@type": "MonetaryAmount",
            currency: "EUR",
            value: {
              "@type": "QuantitativeValue",
              unitText: "HOUR",
              value: 95,
            },
          },
        },
      },
      HASH
    );

    expect(draft.tarief).toEqual({
      eenheid: "uur",
      max: "95",
      min: "95",
      valuta: "EUR",
    });
  });
});

describe("parseJsonLdPayload -- TenMonks", () => {
  const payload: JsonLdFetchedPayload = {
    jobPosting: {
      "@type": "JobPosting",
      baseSalary: {
        "@type": "MonetaryAmount",
        currency: "EUR",
        value: {
          "@type": "QuantitativeValue",
          maxValue: 5624,
          minValue: 3824,
          unitText: "MONTH",
        },
      },
      datePosted: "2026-09-15",
      description: "<p>Opdrachtomschrijving</p>",
      employmentType: ["FULL_TIME"],
      hiringOrganization: { "@type": "Organization", name: "TenMonks" },
      identifier: {
        "@type": "PropertyValue",
        name: "TenMonks",
        value: "JP033750",
      },
      jobLocation: [
        {
          "@type": "Place",
          address: {
            "@type": "PostalAddress",
            addressCountry: "NL",
            addressLocality: "Noord-Holland",
          },
        },
      ],
      title: "Data Analist",
      validThrough: "2027-01-01T00:00:00+00:00",
    },
    labelBlock: {},
    parserVersion: "tenmonks/v2",
    slug: "tenmonks",
    url: "https://tenmonks.nl/opdrachten/34350/data-analist/",
  };

  it("normalises the URL reference and literal JSON-LD identity fields", () => {
    const draft = parseJsonLdPayload(payload, HASH);

    expect(draft.bronReferentie.value).toBe("opdrachten/34350/data-analist");
    expect(draft.titel.value).toBe("Data Analist");
    expect(draft.bronSpecifiek.value).toMatchObject({
      identifier: { name: "TenMonks", value: "JP033750" },
      publicatiedatum: "2026-09-15",
      slug: "tenmonks",
    });
  });

  it("promotes the explicit EUR/MONTH baseSalary band", () => {
    const draft = parseJsonLdPayload(payload, HASH);

    expect(draft.tarief).toEqual({
      eenheid: "maand",
      max: "5624",
      min: "3824",
      valuta: "EUR",
    });
  });
});

describe("parseJsonLdPayload -- Pro-Act IT (label block embedded in description text)", () => {
  const payload: JsonLdFetchedPayload = {
    jobPosting: {
      "@type": "JobPosting",
      datePosted: "2026-08-25",
      description:
        "<p>Voor onze directe eindklant, Tweede Kamer der Staten-Generaal, zijn wij op zoek naar een Senior Azure Operations Engineer.</p>",
      employmentType: "FULL_TIME",
      hiringOrganization: { "@type": "Organization", name: "Pro-Act IT" },
      title: "Senior Azure Operations Engineer",
      validThrough: "2026-09-01",
    },
    labelBlock: {
      eindDatum: "30 juni 2027",
      eindklant: "Tweede Kamer der Staten-Generaal",
      locatie: "hybride",
      startDatum: "1 oktober 2026",
      tarief: "marktconform",
      urenPerWeek: "36 uur per week",
    },
    parserVersion: "pro-act/v2",
    slug: "pro-act",
    url: "https://pro-act.nl/vacatures/senior-azure-operations-engineer-8793/",
  };

  it("parses the description-embedded label block", () => {
    const draft = parseJsonLdPayload(payload, HASH);
    expect(draft.startDatum.value).toBe("2026-10-01");
    expect(draft.locatieTekst.value).toBe("hybride");
  });

  it("leaves tarief UNKNOWN for the literal 'marktconform' text", () => {
    const draft = parseJsonLdPayload(payload, HASH);
    expect(draft.tarief.max).toBe(UNKNOWN);
  });

  it("promotes the explicitly labelled eindklant over the broker for opdrachtgeverNaam (F02)", () => {
    const draft = parseJsonLdPayload(payload, HASH);
    expect(draft.opdrachtgeverNaam.value).toBe(
      "Tweede Kamer der Staten-Generaal"
    );
    expect(draft.bronSpecifiek.value).toMatchObject({
      eindklant_naam: "Tweede Kamer der Staten-Generaal",
    });
  });

  it("puts employmentType under contract_type (F06)", () => {
    const draft = parseJsonLdPayload(payload, HASH);
    expect(draft.bronSpecifiek.value).toMatchObject({
      contract_type: "FULL_TIME",
    });
  });

  it("leaves contract_type null when employmentType is absent (honesty, F06)", () => {
    const { employmentType: _employmentType, ...jobPostingWithoutType } =
      payload.jobPosting;
    const draft = parseJsonLdPayload(
      { ...payload, jobPosting: jobPostingWithoutType },
      HASH
    );
    expect(draft.bronSpecifiek.value).toMatchObject({ contract_type: null });
  });

  it("sources publicatiedatum from jobPosting.datePosted, never from a label or scraped_at (F12)", () => {
    const draft = parseJsonLdPayload(payload, HASH);
    expect(draft.bronSpecifiek.value).toMatchObject({
      publicatiedatum: "2026-08-25",
    });
  });

  it("leaves publicatiedatum null when datePosted is absent (honesty)", () => {
    const { datePosted: _datePosted, ...jobPostingWithoutDate } =
      payload.jobPosting;
    const draft = parseJsonLdPayload(
      { ...payload, jobPosting: jobPostingWithoutDate },
      HASH
    );
    expect(draft.bronSpecifiek.value).toMatchObject({ publicatiedatum: null });
  });
});

describe("parseJsonLdPayload -- closing lifecycle (RJC-377)", () => {
  const basePayload: JsonLdFetchedPayload = {
    jobPosting: {
      "@type": "JobPosting",
      description: "Testscenario's opstellen, uitvoeren en rapporteren.",
      hiringOrganization: { "@type": "Organization", name: "Kadaster" },
      title: "CIAM Tester",
    },
    labelBlock: {},
    parserVersion: "bluetrail/v2",
    slug: "bluetrail",
    url: "https://www.bluetrail.nl/opdrachten/Interim/ciam-tester/",
  };

  it("closes once BlueTrail's label-block sluitingsDatum has passed", () => {
    const draft = parseJsonLdPayload(
      {
        ...basePayload,
        labelBlock: { sluitingsDatum: "2 januari 2000" },
      },
      HASH
    );
    expect(draft.lifecycle).toBe("closed");
    expect(draft.status).toBe("closed");
  });

  it("stays active while BlueTrail's label-block sluitingsDatum is still in the future", () => {
    const draft = parseJsonLdPayload(
      {
        ...basePayload,
        labelBlock: { sluitingsDatum: "2 januari 2099" },
      },
      HASH
    );
    expect(draft.lifecycle).toBe("active");
    expect(draft.status).toBe("active");
  });

  it("falls back to jobPosting.validThrough when the label block has no sluitingsDatum (Pro-Act)", () => {
    const closed = parseJsonLdPayload(
      {
        ...basePayload,
        jobPosting: { ...basePayload.jobPosting, validThrough: "2000-01-02" },
      },
      HASH
    );
    expect(closed.lifecycle).toBe("closed");

    const active = parseJsonLdPayload(
      {
        ...basePayload,
        jobPosting: { ...basePayload.jobPosting, validThrough: "2099-01-02" },
      },
      HASH
    );
    expect(active.lifecycle).toBe("active");
  });

  it("parses BlueTrail's RFC 2822 validThrough fallback the same as its bare-ISO Pro-Act form", () => {
    const draft = parseJsonLdPayload(
      {
        ...basePayload,
        jobPosting: {
          ...basePayload.jobPosting,
          validThrough: "Sat, 02 Jan 2000 00:00:00 +0000",
        },
      },
      HASH
    );
    expect(draft.lifecycle).toBe("closed");
  });

  it("prefers the label-block sluitingsDatum over a conflicting validThrough", () => {
    const draft = parseJsonLdPayload(
      {
        ...basePayload,
        jobPosting: { ...basePayload.jobPosting, validThrough: "2000-01-02" },
        labelBlock: { sluitingsDatum: "2 januari 2099" },
      },
      HASH
    );
    expect(draft.lifecycle).toBe("active");
  });

  it("stays open (not closed) for Hero.eu, which publishes neither field", () => {
    const draft = parseJsonLdPayload(basePayload, HASH);
    expect(draft.lifecycle).not.toBe("closed");
  });

  it("does not throw and stays open for an unparseable validThrough", () => {
    const draft = parseJsonLdPayload(
      {
        ...basePayload,
        jobPosting: { ...basePayload.jobPosting, validThrough: "not-a-date" },
      },
      HASH
    );
    expect(draft.lifecycle).not.toBe("closed");
  });

  it("stays active while a bare-date sluitingsDatum still holds through end-of-day Amsterdam (RJC-376 discipline)", () => {
    // Today's date in Europe/Amsterdam, formatted as BlueTrail's Dutch
    // sidebar text -- must still be open right up to 23:59:59 local.
    const parts = new Intl.DateTimeFormat("nl-NL", {
      day: "numeric",
      month: "long",
      timeZone: "Europe/Amsterdam",
      year: "numeric",
    }).formatToParts(new Date());
    const get = (type: string) =>
      parts.find((part) => part.type === type)?.value;
    const todayDutch = `${get("day")} ${get("month")} ${get("year")}`;

    const draft = parseJsonLdPayload(
      { ...basePayload, labelBlock: { sluitingsDatum: todayDutch } },
      HASH
    );
    expect(draft.lifecycle).toBe("active");
  });

  it("closes the day after a bare-date sluitingsDatum has fully elapsed", () => {
    const draft = parseJsonLdPayload(
      { ...basePayload, labelBlock: { sluitingsDatum: "1 januari 2000" } },
      HASH
    );
    expect(draft.lifecycle).toBe("closed");
  });

  it("rejects an impossible calendar date from the label block (Feb 30) rather than rolling it over", () => {
    const draft = parseJsonLdPayload(
      { ...basePayload, labelBlock: { sluitingsDatum: "30 februari 2026" } },
      HASH
    );
    expect(draft.lifecycle).not.toBe("closed");
  });

  it("rejects an impossible calendar date from a bare-date validThrough (month 13-equivalent) rather than rolling it over", () => {
    const draft = parseJsonLdPayload(
      {
        ...basePayload,
        jobPosting: { ...basePayload.jobPosting, validThrough: "2026-02-30" },
      },
      HASH
    );
    expect(draft.lifecycle).not.toBe("closed");
  });

  it("treats a validThrough with a time component as an exact instant, never truncating to end-of-day (codex review, RJC-376-in-reverse)", () => {
    // A past instant expressed with an offset near midnight -- if this were
    // ever truncated to a bare date (the pre-fix bug), it would read as
    // "open until end of day Amsterdam" instead of closing at the precise
    // instant it actually passed.
    const closed = parseJsonLdPayload(
      {
        ...basePayload,
        jobPosting: {
          ...basePayload.jobPosting,
          validThrough: "2000-01-02T00:30:00+02:00",
        },
      },
      HASH
    );
    expect(closed.lifecycle).toBe("closed");

    const active = parseJsonLdPayload(
      {
        ...basePayload,
        jobPosting: {
          ...basePayload.jobPosting,
          validThrough: "2099-01-02T00:30:00+02:00",
        },
      },
      HASH
    );
    expect(active.lifecycle).toBe("active");
  });

  it("stays active up to and closes right after an instant validThrough a few minutes from now", () => {
    // Constructs the SAME instant via a +02:00 offset whose local wall-clock
    // date can differ from the instant's own UTC date -- exercises the
    // parse-not-slice fix directly rather than only far past/future values.
    const closed = parseJsonLdPayload(
      {
        ...basePayload,
        jobPosting: {
          ...basePayload.jobPosting,
          validThrough: toOffsetString(new Date(Date.now() - 2 * 60 * 1000)),
        },
      },
      HASH
    );
    expect(closed.lifecycle).toBe("closed");

    const active = parseJsonLdPayload(
      {
        ...basePayload,
        jobPosting: {
          ...basePayload.jobPosting,
          validThrough: toOffsetString(new Date(Date.now() + 2 * 60 * 1000)),
        },
      },
      HASH
    );
    expect(active.lifecycle).toBe("active");
  });
});

describe("BlueTrail broker-fronted live capture through connector and normaliser (CTP-516 F02, CTP-603)", () => {
  const url =
    "https://www.bluetrail.nl/opdrachten/Interim/architect-ict-en-informatielandschap/";

  const normaliseCapture = async () => {
    const client = createJsonLdClient({
      config: bluetrailConfig,
      liveEnabled: false,
    });
    const detail = await client.fetchDetail(url);
    if (!detail.jobPosting) {
      throw new Error("expected a JobPosting in the recorded capture");
    }
    return parseJsonLdPayload(
      {
        jobPosting: detail.jobPosting,
        labelBlock: detail.labelBlock,
        parserVersion: bluetrailConfig.parserVersion,
        slug: bluetrailConfig.slug,
        url,
      },
      HASH
    );
  };

  it("names the end client, not the Circle8 broker, as opdrachtgever", async () => {
    const draft = await normaliseCapture();
    expect(draft.opdrachtgeverNaam.value).toBe("Gemeente Stichtse Vecht");
    expect(draft.bronSpecifiek.value).toMatchObject({
      eindklant_naam: "Gemeente Stichtse Vecht",
      uren_per_week: "24",
    });
  });

  it("leaves tarief unknown despite the recorded 100/HOUR-style baseSalary", async () => {
    const draft = await normaliseCapture();
    expect(draft.tarief).toEqual({
      eenheid: UNKNOWN,
      max: UNKNOWN,
      min: UNKNOWN,
      valuta: "EUR",
    });
  });
});

describe("BlueTrail description tarief false positives (CTP-605)", () => {
  const captures = [
    [
      "https://www.bluetrail.nl/opdrachten/Interim/adviseur-security-privacy/",
      "31-12-2026",
      "operationaliseren",
      "UUR",
    ],
    [
      "https://www.bluetrail.nl/opdrachten/Interim/ontwikkelmanager/",
      "2–3 jaar",
      "strategische",
      "UUR",
    ],
    [
      "https://www.bluetrail.nl/opdrachten/Interim/teamlead-procesbeschrijver-sr/",
      "10-15",
      "team van",
      "HOUR",
    ],
  ] as const;

  it.each(captures)(
    "leaves %s tarief fully unknown despite baseSalary and description range",
    async (url, falseHit, falseHitWord, unitText) => {
      const client = createJsonLdClient({
        config: bluetrailConfig,
        liveEnabled: false,
      });
      const detail = await client.fetchDetail(url);
      if (!detail.jobPosting) {
        throw new Error("expected a JobPosting in the recorded capture");
      }
      expect(detail.labelBlock.tarief).toBeUndefined();
      expect(detail.jobPosting.description).toContain(falseHit);
      expect(detail.jobPosting.description).toContain(falseHitWord);
      expect(detail.jobPosting.baseSalary).toMatchObject({
        value: { unitText, value: "100" },
      });

      const draft = parseJsonLdPayload(
        {
          jobPosting: detail.jobPosting,
          labelBlock: detail.labelBlock,
          parserVersion: bluetrailConfig.parserVersion,
          slug: bluetrailConfig.slug,
          url,
        },
        HASH
      );
      expect(draft.tarief).toEqual({
        eenheid: UNKNOWN,
        max: UNKNOWN,
        min: UNKNOWN,
        valuta: "EUR",
      });
    }
  );
});

describe("parseJsonLdPayload -- contactpersonen (CTP-610)", () => {
  const baseJobPosting = {
    "@type": "JobPosting",
    description: "Spec vacancy description.",
    hiringOrganization: { "@type": "Organization", name: "Spec Org" },
    title: "Spec title",
  };

  it("maps synthesizer-provided payload.contactpersonen with provenance", () => {
    const draft = parseJsonLdPayload(
      {
        contactpersonen: [
          {
            email: "redacted@example.invalid",
            naam: "A. de Vries",
            rol: "recruiter",
            telefoon: "+31000000000",
          },
        ],
        jobPosting: baseJobPosting,
        labelBlock: {},
        parserVersion: "prorail/v2",
        slug: "prorail",
        url: "https://example.test/vacature/1",
      },
      HASH
    );

    expect(draft.contactpersonen?.value).toEqual([
      {
        email: "redacted@example.invalid",
        geinformeerdOp: null,
        naam: "A. de Vries",
        notificatieKanaal: null,
        rol: "recruiter",
        telefoon: "+31000000000",
      },
    ]);
    expect(draft.contactpersonen?.provenance).toEqual({
      parserVersion: "prorail/v2",
      sourcePath: "payload.contactpersonen",
    });
  });

  it("maps a schema.org contactPoint on hiringOrganization (DataJobs/Haert/TBI)", () => {
    const draft = parseJsonLdPayload(
      {
        jobPosting: {
          ...baseJobPosting,
          hiringOrganization: {
            "@type": "Organization",
            contactPoint: {
              "@type": "ContactPoint",
              contactType: "recruiter",
              email: "redacted@example.invalid",
              telephone: "+31000000000",
            },
            name: "Spec Org",
          },
        },
        labelBlock: {},
        parserVersion: "tbi/v2",
        slug: "tbi",
        url: "https://example.test/vacature/2",
      },
      HASH
    );

    expect(draft.contactpersonen?.value).toEqual([
      {
        email: "redacted@example.invalid",
        geinformeerdOp: null,
        naam: null,
        notificatieKanaal: null,
        rol: "recruiter",
        telefoon: "+31000000000",
      },
    ]);
    expect(draft.contactpersonen?.provenance.sourcePath).toBe(
      "jobPosting.hiringOrganization.contactPoint"
    );
  });

  it("leaves contactpersonen absent when the bron publishes none", () => {
    const draft = parseJsonLdPayload(
      {
        jobPosting: baseJobPosting,
        labelBlock: {},
        parserVersion: "eneco/v2",
        slug: "eneco",
        url: "https://example.test/vacature/3",
      },
      HASH
    );

    expect(draft.contactpersonen).toBeUndefined();
  });

  it("drops contacts without naam, email or telefoon", () => {
    const draft = parseJsonLdPayload(
      {
        contactpersonen: [{ rol: "recruiter" }],
        jobPosting: baseJobPosting,
        labelBlock: {},
        parserVersion: "prorail/v2",
        slug: "prorail",
        url: "https://example.test/vacature/4",
      },
      HASH
    );

    expect(draft.contactpersonen).toBeUndefined();
  });

  it("maps jobPosting.applicationContact (TBI publishes it)", () => {
    const draft = parseJsonLdPayload(
      {
        jobPosting: {
          ...baseJobPosting,
          applicationContact: {
            "@type": "ContactPoint",
            contactType: "recruiter",
            email: "redacted@example.invalid",
            name: "B. Bakker",
          },
        },
        labelBlock: {},
        parserVersion: "tbi/v2",
        slug: "tbi",
        url: "https://example.test/vacature/5",
      },
      HASH
    );

    expect(draft.contactpersonen?.value).toEqual([
      {
        email: "redacted@example.invalid",
        geinformeerdOp: null,
        naam: "B. Bakker",
        notificatieKanaal: null,
        rol: "recruiter",
        telefoon: null,
      },
    ]);
    expect(draft.contactpersonen?.provenance.sourcePath).toBe(
      "jobPosting.applicationContact"
    );
  });

  it("maps an org-level email/telephone channel but never a bare org name", () => {
    const withChannel = parseJsonLdPayload(
      {
        jobPosting: {
          ...baseJobPosting,
          hiringOrganization: {
            "@type": "Organization",
            email: "werving@example.invalid",
            name: "Spec Org",
            telephone: "+31000000000",
          },
        },
        labelBlock: {},
        parserVersion: "intermediair/v2",
        slug: "intermediair",
        url: "https://example.test/vacature/6",
      },
      HASH
    );
    expect(withChannel.contactpersonen?.value).toEqual([
      {
        email: "werving@example.invalid",
        geinformeerdOp: null,
        naam: "Spec Org",
        notificatieKanaal: null,
        rol: null,
        telefoon: "+31000000000",
      },
    ]);
    expect(withChannel.contactpersonen?.provenance.sourcePath).toBe(
      "jobPosting.hiringOrganization"
    );

    // A bare org name is not a contact channel: "Spec Org" alone must not
    // become a contactpersoon.
    const nameOnly = parseJsonLdPayload(
      {
        jobPosting: baseJobPosting,
        labelBlock: {},
        parserVersion: "eneco/v2",
        slug: "eneco",
        url: "https://example.test/vacature/7",
      },
      HASH
    );
    expect(nameOnly.contactpersonen).toBeUndefined();
  });

  it("keeps phone-only contacts as distinct entries (contactKey includes telefoon)", () => {
    // Two channel-only contacts sharing naam=null/email=null used to collapse
    // to the same "|" key — the second reachable phone number vanished.
    const draft = parseJsonLdPayload(
      {
        contactpersonen: [
          { telefoon: "+31000000001" },
          { telefoon: "+31000000002" },
          { telefoon: "+31000000001" },
        ],
        jobPosting: baseJobPosting,
        labelBlock: {},
        parserVersion: "prorail/v2",
        slug: "prorail",
        url: "https://example.test/vacature/8",
      },
      HASH
    );

    expect(draft.contactpersonen?.value).toHaveLength(2);
  });
});

describe("parseJsonLdPayload -- CTP-611 published-field coverage", () => {
  const basePayload: JsonLdFetchedPayload = {
    jobPosting: {
      "@type": "JobPosting",
      description: "Spec vacancy description.",
      hiringOrganization: { "@type": "Organization", name: "Spec Org" },
      title: "Spec title",
    },
    labelBlock: {},
    parserVersion: "spec/v1",
    slug: "eneco",
    url: "https://example.test/vacature/1",
  };

  const withJobPosting = (extra: JsonLdNode): JsonLdFetchedPayload => ({
    ...basePayload,
    jobPosting: { ...basePayload.jobPosting, ...extra },
  });

  it("maps educationRequirements as a plain string to opleidingsniveau (prorail 'hbo/wo')", () => {
    const draft = parseJsonLdPayload(
      withJobPosting({ educationRequirements: "hbo/wo" }),
      HASH
    );
    expect(draft.bronSpecifiek.value).toMatchObject({
      opleidingsniveau: "hbo/wo",
    });
  });

  it("maps educationRequirements as a string list (eneco ['MBO','HBO'])", () => {
    const draft = parseJsonLdPayload(
      withJobPosting({ educationRequirements: ["MBO", "HBO"] }),
      HASH
    );
    expect(draft.bronSpecifiek.value).toMatchObject({
      opleidingsniveau: "MBO/HBO",
    });
  });

  it("maps an EducationalOccupationalCredential node's credentialCategory (intermediair)", () => {
    const draft = parseJsonLdPayload(
      withJobPosting({
        educationRequirements: {
          "@type": "EducationalOccupationalCredential",
          credentialCategory: "bachelor degree",
        },
      }),
      HASH
    );
    expect(draft.bronSpecifiek.value).toMatchObject({
      opleidingsniveau: "bachelor degree",
    });
  });

  it("leaves opleidingsniveau null for an empty educationRequirements list (heijmans)", () => {
    const draft = parseJsonLdPayload(
      withJobPosting({ educationRequirements: [] }),
      HASH
    );
    expect(draft.bronSpecifiek.value).toMatchObject({ opleidingsniveau: null });
  });

  it("falls back to qualifications when educationRequirements is absent (tbi 'MBO')", () => {
    const draft = parseJsonLdPayload(
      withJobPosting({ qualifications: "MBO" }),
      HASH
    );
    expect(draft.bronSpecifiek.value).toMatchObject({
      opleidingsniveau: "MBO",
    });
  });

  it("prefers educationRequirements over qualifications when both are published", () => {
    const draft = parseJsonLdPayload(
      withJobPosting({
        educationRequirements: "HBO",
        qualifications: "WO",
      }),
      HASH
    );
    expect(draft.bronSpecifiek.value).toMatchObject({
      opleidingsniveau: "HBO",
    });
  });

  it("parses a bare-number workHours ('40' stedin)", () => {
    const draft = parseJsonLdPayload(withJobPosting({ workHours: "40" }), HASH);
    expect(draft.bronSpecifiek.value).toMatchObject({ uren_per_week: "40" });
  });

  it("parses a unit-less dash-range workHours ('32-36' prorail)", () => {
    const draft = parseJsonLdPayload(
      withJobPosting({ workHours: "32-36" }),
      HASH
    );
    expect(draft.bronSpecifiek.value).toMatchObject({
      uren_per_week: "32–36",
    });
  });

  it("parses English 'hours per week' workHours (bam)", () => {
    const draft = parseJsonLdPayload(
      withJobPosting({ workHours: "40 hours per week" }),
      HASH
    );
    expect(draft.bronSpecifiek.value).toMatchObject({ uren_per_week: "40" });
  });

  it("leaves junk workHours ('Full time uur per week') null", () => {
    const draft = parseJsonLdPayload(
      withJobPosting({ workHours: "Full time uur per week" }),
      HASH
    );
    expect(draft.bronSpecifiek.value).toMatchObject({ uren_per_week: null });
  });

  it("maps ['TEMPORARY','FULL_TIME'] to canonical interim and keeps the raw token list", () => {
    const draft = parseJsonLdPayload(
      withJobPosting({ employmentType: ["TEMPORARY", "FULL_TIME"] }),
      HASH
    );
    expect(draft.bronSpecifiek.value).toMatchObject({
      contracttype: "interim",
      employment_type: "TEMPORARY, FULL_TIME",
    });
  });

  it("maps ['TEMPORARY','CONTRACTOR','FULL_TIME'] (opdrachtoverheid) to null -- two published contract forms", () => {
    const draft = parseJsonLdPayload(
      withJobPosting({
        employmentType: ["TEMPORARY", "CONTRACTOR", "FULL_TIME"],
      }),
      HASH
    );
    expect(draft.bronSpecifiek.value).toMatchObject({
      contracttype: null,
      employment_type: "TEMPORARY, CONTRACTOR, FULL_TIME",
    });
  });

  it("keeps ['FULL_TIME','PART_TIME'] contracttype null (no contract form published)", () => {
    const draft = parseJsonLdPayload(
      withJobPosting({ employmentType: ["FULL_TIME", "PART_TIME"] }),
      HASH
    );
    expect(draft.bronSpecifiek.value).toMatchObject({ contracttype: null });
  });

  it("keeps a single-token employmentType landing in contract_type with canonical contracttype", () => {
    const draft = parseJsonLdPayload(
      withJobPosting({ employmentType: "CONTRACTOR" }),
      HASH
    );
    expect(draft.bronSpecifiek.value).toMatchObject({
      contract_type: "CONTRACTOR",
      contracttype: "freelance",
    });
  });

  it("keeps ['OTHER'] honest: contracttype null, raw list preserved", () => {
    const draft = parseJsonLdPayload(
      withJobPosting({ employmentType: ["OTHER"] }),
      HASH
    );
    expect(draft.bronSpecifiek.value).toMatchObject({
      contracttype: null,
      employment_type: "OTHER",
    });
  });
});

describe("CTP-611 published-field coverage through recorded fixtures", () => {
  const captures = [
    [
      "prorail woordvoerder",
      prorailConfig,
      "https://www.werkenbijprorail.nl/vacatures/functie/woordvoerder",
      {
        educationRequirements: "hbo/wo",
        employmentType: "Full-time",
        workHours: "32-36",
      },
      {
        contract_type: "Full-time",
        contracttype: null,
        employment_type: null,
        opleidingsniveau: "hbo/wo",
        uren_per_week: "32–36",
      },
    ],
    [
      "eneco ervaren-accountsupporter",
      enecoConfig,
      "https://www.werkenbijeneco.nl/vacatures/ervaren-accountsupporter-3145",
      {
        educationRequirements: ["MBO", "HBO"],
        employmentType: [],
        workHours: "32 - 40 uur",
      },
      {
        contract_type: null,
        contracttype: null,
        employment_type: null,
        opleidingsniveau: "MBO/HBO",
        uren_per_week: "32–40",
      },
    ],
    [
      "intermediair klantmanager-werk-en-inkomen",
      intermediairConfig,
      "https://www.intermediair.nl/vacature/7fd25dd1-894d-4844-acf7-b5b672a10afc/klantmanager-werk-en-inkomen",
      {
        educationRequirements: {
          "@type": "EducationalOccupationalCredential",
          credentialCategory: "bachelor degree",
        },
        employmentType: "TEMPORARY",
        workHours: "1 - 40 uur per week",
      },
      {
        contract_type: "TEMPORARY",
        contracttype: "interim",
        opleidingsniveau: "bachelor degree",
        uren_per_week: "1–40",
      },
    ],
    [
      "intermediair asfaltuitvoerder",
      intermediairConfig,
      "https://www.intermediair.nl/vacature/0cad6431-f0e1-4d5a-9872-d4cba5ef0225/asfaltuitvoerder",
      {
        educationRequirements: {
          "@type": "EducationalOccupationalCredential",
          credentialCategory: "associate degree",
        },
        employmentType: ["FULL_TIME", "PART_TIME"],
      },
      {
        contracttype: null,
        employment_type: "FULL_TIME, PART_TIME",
        opleidingsniveau: "associate degree",
      },
    ],
    [
      "stedin monteur-gas",
      stedinConfig,
      "https://werkenbij.stedin.net/banen/amstelveen/monteur-gas/3297/35532249792",
      {
        educationRequirements: "MBO - Techniek Overig",
        workHours: "40",
      },
      {
        contract_type: null,
        contracttype: null,
        opleidingsniveau: "MBO - Techniek Overig",
        uren_per_week: "40",
      },
    ],
    [
      "bam tendermanager",
      bamConfig,
      "https://www.bamcareers.com/nl/nl/job/26832/Tendermanager-Bouw",
      {
        employmentType: ["OTHER"],
        workHours: "40 hours per week",
      },
      {
        contracttype: null,
        employment_type: "OTHER",
        opleidingsniveau: null,
        uren_per_week: "40",
      },
    ],
    [
      "datajobs data-engineer-bij-verpact",
      datajobsConfig,
      "https://www.datajobs.nl/vacatures/data-engineer-bij-verpact",
      {
        employmentType: "FULL_TIME",
        workHours: "Full time uur per week",
      },
      {
        contract_type: "FULL_TIME",
        contracttype: null,
        opleidingsniveau: null,
        uren_per_week: null,
      },
    ],
    [
      "randstad operator",
      randstadConfig,
      "https://www.randstad.nl/vacatures/749250/operator",
      {
        educationRequirements: "VMBO/MAVO",
        employmentType: ["TEMPORARY", "FULL_TIME"],
        workHours: "37 - 38 uur per week",
      },
      {
        contracttype: "interim",
        employment_type: "TEMPORARY, FULL_TIME",
        opleidingsniveau: "VMBO/MAVO",
        uren_per_week: "37–38",
      },
    ],
    [
      "ns conducteur-zwolle",
      nsConfig,
      "https://www.werkenbijns.nl/vacatures/conducteur-zwolle-zwolle-1331708",
      {
        educationRequirements: ["MBO"],
        employmentType: ["FULL_TIME"],
        workHours: "24 - 36 uur",
      },
      {
        contracttype: null,
        employment_type: "FULL_TIME",
        opleidingsniveau: "MBO",
        uren_per_week: "24–36",
      },
    ],
    [
      "zzp-opdrachten bouwprojectmanager",
      zzpOpdrachtenConfig,
      "https://www.zzp-opdrachten.nl/vacatures/vacature-bouwprojectmanager-708001/",
      {
        employmentType: ["TEMPORARY"],
      },
      {
        contracttype: "interim",
        employment_type: "TEMPORARY",
        opleidingsniveau: null,
        uren_per_week: null,
      },
    ],
  ] as const;

  it.each(captures)(
    "normalises the recorded %s detail",
    async (name, config, url, published, expected) => {
      const client = createJsonLdClient({ config, liveEnabled: false });
      const detail = await client.fetchDetail(url);
      expect(detail.jobPosting).toMatchObject(published);
      if (!detail.jobPosting) {
        throw new Error(
          `expected a JobPosting in the recorded ${name} capture`
        );
      }
      const payload: JsonLdFetchedPayload = {
        jobPosting: detail.jobPosting,
        labelBlock: detail.labelBlock,
        parserVersion: config.parserVersion,
        slug: config.slug,
        url,
      };
      if (detail.contactpersonen && detail.contactpersonen.length > 0) {
        payload.contactpersonen = detail.contactpersonen;
      }
      const draft = parseJsonLdPayload(payload, HASH);
      expect(draft.bronSpecifiek.value).toMatchObject(expected);
    }
  );
});
