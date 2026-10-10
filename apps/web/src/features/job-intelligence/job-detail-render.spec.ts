import { describe, expect, it } from "bun:test";

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { JOB_FIXTURES } from "./fixtures";
import { JobDetail } from "./job-detail";
import { JobResults } from "./job-results";
import type { JobListing } from "./types";

const htmlJob = JOB_FIXTURES.find((job) => job.id === "job-html-nvb");
const plainJob = JOB_FIXTURES.find((job) => job.id === "job-001");

describe("JobDetail Opdracht body + raw scroll (CTP-481 / CTP-483)", () => {
  it("renders NVB HTML body as sanitized markup, not escaped tags", () => {
    if (!htmlJob) {
      throw new Error("Expected job-html-nvb fixture");
    }
    const markup = renderToStaticMarkup(
      createElement(JobDetail, {
        descriptionId: "d",
        job: htmlJob,
        onClose: () => {},
        titleId: "t",
      })
    );
    expect(markup).toContain('data-body-format="html"');
    expect(markup).toContain("<b>TypeScript</b>");
    expect(markup).toContain("<li>React</li>");
    const opdrachtStart = markup.indexOf(">Opdracht<");
    const rawStart = markup.indexOf(">Raw preview<");
    expect(opdrachtStart).toBeGreaterThan(-1);
    expect(rawStart).toBeGreaterThan(opdrachtStart);
    const opdrachtMarkup = markup.slice(opdrachtStart, rawStart);
    // Opdracht must render real tags, not escaped literals.
    expect(opdrachtMarkup).toContain("<p>");
    expect(opdrachtMarkup).not.toContain("&lt;p&gt;");
    expect(opdrachtMarkup).not.toContain("&lt;b&gt;");
  });

  it("renders entity-encoded description as HTML, not visible tags (CTP-483)", () => {
    if (!htmlJob) {
      throw new Error("Expected job-html-nvb fixture");
    }
    const encodedJob: JobListing = {
      ...htmlJob,
      description:
        "&lt;p&gt;Wij zoeken een &lt;b&gt;TypeScript&lt;/b&gt; engineer.&lt;/p&gt;&lt;ul&gt;&lt;li&gt;React&lt;/li&gt;&lt;/ul&gt;",
      summary: "Wij zoeken een TypeScript engineer. React",
    };
    const markup = renderToStaticMarkup(
      createElement(JobDetail, {
        descriptionId: "d",
        job: encodedJob,
        onClose: () => {},
        titleId: "t",
      })
    );
    const opdrachtStart = markup.indexOf(">Opdracht<");
    const rawStart = markup.indexOf(">Raw preview<");
    const opdrachtMarkup = markup.slice(opdrachtStart, rawStart);
    expect(opdrachtMarkup).toContain('data-body-format="html"');
    expect(opdrachtMarkup).toContain("<b>TypeScript</b>");
    expect(opdrachtMarkup).toContain("<li>React</li>");
    expect(opdrachtMarkup).not.toContain("&lt;p&gt;");
    expect(opdrachtMarkup).not.toContain("&lt;b&gt;");
  });

  it("escapes plain-text bron bodies", () => {
    if (!plainJob) {
      throw new Error("Expected job-001 fixture");
    }
    const markup = renderToStaticMarkup(
      createElement(JobDetail, {
        descriptionId: "d",
        job: plainJob,
        onClose: () => {},
        titleId: "t",
      })
    );
    expect(markup).toContain('data-body-format="plain"');
    expect(markup).toContain("datapijplijnen");
  });

  it("exposes a scrollable raw preview container", () => {
    if (!htmlJob) {
      throw new Error("Expected job-html-nvb fixture");
    }
    const markup = renderToStaticMarkup(
      createElement(JobDetail, {
        descriptionId: "d",
        job: htmlJob,
        liveData: true,
        onClose: () => {},
        titleId: "t",
      })
    );
    expect(markup).toContain('data-testid="job-raw-preview-scroll"');
    expect(markup).toContain("overflow-y-auto");
    expect(markup).toContain("max-h-72");
    expect(markup).toContain("min-h-0");
    expect(markup).toContain("nationalevacaturebank");
  });
});

describe("JobResults list card summary (CTP-483)", () => {
  it("does not show raw HTML tags in the mobile summary teaser", () => {
    if (!htmlJob) {
      throw new Error("Expected job-html-nvb fixture");
    }
    const dirtySummaryJob: JobListing = {
      ...htmlJob,
      summary:
        "&lt;p&gt;Wij zoeken een &lt;b&gt;TypeScript&lt;/b&gt; engineer.&lt;/p&gt;",
    };
    const markup = renderToStaticMarkup(
      createElement(JobResults, {
        jobs: [dirtySummaryJob],
        onSelect: () => {},
        selectedJobId: null,
      })
    );
    expect(markup).toContain("Wij zoeken een TypeScript engineer.");
    expect(markup).not.toContain("&lt;p&gt;");
    expect(markup).not.toContain("<b>TypeScript</b>");
  });

  it("renders the catalog display name while keeping the source slug as identity", () => {
    if (!plainJob) {
      throw new Error("Expected job-001 fixture");
    }
    const [fixtureSource] = plainJob.sourceRecords;
    if (!fixtureSource) {
      throw new Error("Expected job-001 source record");
    }
    const catalogNamedJob: JobListing = {
      ...plainJob,
      sourceRecords: [
        {
          ...fixtureSource,
          displayName: "One Fellow",
          name: "one-fellow",
        },
      ],
    };
    const resultsMarkup = renderToStaticMarkup(
      createElement(JobResults, {
        jobs: [catalogNamedJob],
        onSelect: () => {},
        selectedJobId: null,
      })
    );
    const detailMarkup = renderToStaticMarkup(
      createElement(JobDetail, {
        descriptionId: "d",
        job: catalogNamedJob,
        onClose: () => {},
        titleId: "t",
      })
    );

    expect(resultsMarkup).toContain(">One Fellow<");
    expect(detailMarkup).toContain(">One Fellow<");
    expect(catalogNamedJob.sourceRecords[0]?.name).toBe("one-fellow");
  });

  it("renders closed archive rows as Gesloten", () => {
    if (!plainJob) {
      throw new Error("Expected job-001 fixture");
    }
    const markup = renderToStaticMarkup(
      createElement(JobResults, {
        jobs: [{ ...plainJob, status: "closed" }],
        onSelect: () => {},
        selectedJobId: null,
      })
    );

    expect(markup).toContain(">Gesloten<");
    expect(markup).not.toContain(">Open<");
  });
});

describe("JobResults grouped-column layout", () => {
  it("keeps the reference columns visible and adds hours to mobile cards", () => {
    if (!plainJob) {
      throw new Error("Expected job-001 fixture");
    }
    const markup = renderToStaticMarkup(
      createElement(JobResults, {
        jobs: [{ ...plainJob, hoursPerWeek: "36" }],
        onSelect: () => {},
        selectedJobId: null,
      })
    );

    for (const header of [
      "Opdracht",
      "Tarief &amp; uren",
      "Locatie",
      "Bron",
      "Data",
    ]) {
      expect(markup).toContain(header);
    }
    expect(markup).toContain("overflow-x-auto");
    expect(markup).toContain("min-w-[960px]");
    expect(markup).toContain("Gemeente Amsterdam");
    expect(markup).toContain(">36<");
  });
});

describe("CTP-482 aangevuld provenance badge", () => {
  it("renders aangevuld badge with tooltip above UI threshold only", () => {
    if (!plainJob) {
      throw new Error("Expected job-001 fixture");
    }
    const enrichedJob: JobListing = {
      ...plainJob,
      enrichedFields: [
        { confidence: 0.8, field: "locatie", source: "deterministic" },
        { confidence: 0.79, field: "tarief", source: "deterministic" },
      ],
      location: "Utrecht",
      rate: null,
    };
    const markup = renderToStaticMarkup(
      createElement(JobDetail, {
        descriptionId: "d",
        job: enrichedJob,
        onClose: () => {},
        titleId: "t",
      })
    );
    expect(markup).toContain('title="aangevuld (locatie)"');
    expect(markup).toContain(">aangevuld<");
    expect(markup).not.toContain('title="aangevuld (tarief)"');
    expect(markup).toContain("Tarief onbekend");
    expect(markup).toContain("Werkvorm");
  });
});

describe("curated contract period fields", () => {
  it("renders hours and dates and keeps absent values honest", () => {
    if (!plainJob) {
      throw new Error("Expected job-001 fixture");
    }
    const populated = renderToStaticMarkup(
      createElement(JobDetail, {
        descriptionId: "d",
        job: {
          ...plainJob,
          endDate: "2027-02-28",
          hoursPerWeek: "32",
          startDate: "2026-10-01",
        },
        onClose: () => {},
        titleId: "t",
      })
    );
    expect(populated).toContain("Uren per week");
    expect(populated).toContain(">32<");
    expect(populated).toContain("Startdatum");
    expect(populated).toContain("1 okt 2026");
    expect(populated).toContain("Einddatum");
    expect(populated).toContain("28 feb 2027");

    const absent = renderToStaticMarkup(
      createElement(JobDetail, {
        descriptionId: "d",
        job: plainJob,
        onClose: () => {},
        titleId: "t",
      })
    );
    expect(absent).toContain("Uren per week");
    expect(absent).toContain("Startdatum");
    expect(absent).toContain("Einddatum");
    expect(
      absent.match(/>Onbekend<\/span><\/dd>/gu)?.length
    ).toBeGreaterThanOrEqual(3);
  });

  it("preserves invalid or source-provided date text literally", () => {
    if (!plainJob) {
      throw new Error("Expected job-001 fixture");
    }
    const markup = renderToStaticMarkup(
      createElement(JobDetail, {
        descriptionId: "d",
        job: {
          ...plainJob,
          endDate: "zo spoedig mogelijk",
          startDate: "1",
        },
        onClose: () => {},
        titleId: "t",
      })
    );

    expect(markup).toContain(">1</span>");
    expect(markup).toContain(">zo spoedig mogelijk</span>");
  });
});

describe("CTP-610 contactpersonen + duplicaat-indicator", () => {
  it("renders contactpersonen with naam, rol, mailto email and telefoon", () => {
    if (!plainJob) {
      throw new Error("Expected job-001 fixture");
    }
    const markup = renderToStaticMarkup(
      createElement(JobDetail, {
        descriptionId: "d",
        job: {
          ...plainJob,
          contactpersonen: [
            {
              email: "redacted@example.invalid",
              naam: "A. de Vries",
              rol: "recruiter",
              telefoon: "+31000000000",
            },
          ],
        },
        onClose: () => {},
        titleId: "t",
      })
    );
    expect(markup).toContain(">Contactpersonen<");
    expect(markup).toContain("A. de Vries");
    expect(markup).toContain("recruiter");
    expect(markup).toContain('href="mailto:redacted@example.invalid"');
    expect(markup).toContain("+31000000000");
  });

  it("hides the contactpersonen section when the bron published none", () => {
    if (!plainJob) {
      throw new Error("Expected job-001 fixture");
    }
    const markup = renderToStaticMarkup(
      createElement(JobDetail, {
        descriptionId: "d",
        job: { ...plainJob, contactpersonen: [] },
        onClose: () => {},
        titleId: "t",
      })
    );
    expect(markup).not.toContain(">Contactpersonen<");
  });

  it("shows a Duplicaat badge on detail and list rows when dedupGroepId is set", () => {
    if (!plainJob) {
      throw new Error("Expected job-001 fixture");
    }
    const duplicateJob: JobListing = {
      ...plainJob,
      dedupGroepId: "dedup-group-1",
    };
    const detail = renderToStaticMarkup(
      createElement(JobDetail, {
        descriptionId: "d",
        job: duplicateJob,
        onClose: () => {},
        titleId: "t",
      })
    );
    const results = renderToStaticMarkup(
      createElement(JobResults, {
        jobs: [duplicateJob],
        onSelect: () => {},
        selectedJobId: null,
      })
    );
    expect(detail).toContain(">Duplicaat<");
    expect(results).toContain(">Duplicaat<");

    const withoutGroup = renderToStaticMarkup(
      createElement(JobResults, {
        jobs: [plainJob],
        onSelect: () => {},
        selectedJobId: null,
      })
    );
    expect(withoutGroup).not.toContain(">Duplicaat<");
  });
});
