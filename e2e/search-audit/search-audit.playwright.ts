import { expect, test } from "@playwright/test";
import type { Page, Route } from "@playwright/test";

const COMMA_LOCATION = "Amsterdam, Noord-Holland";
const COMMA_QUERY = `"${COMMA_LOCATION}"`;
const ZERO_TIMEOUT_QUERY = encodeURIComponent('"timeout zero"');
const DETAIL_ID = "00000000-0000-4000-8000-000000000104";
const DETAIL_TITLE = "SYNTHETIC volledige detailopdracht";
const DETAIL_END_MARKER = "SYNTHETIC_DETAIL_END_MARKER_CTP_492";
const LIVE_CATALOG_LABEL = "SYNTHETIC Catalogus Live";
const LIVE_CATALOG_BRON_ID = "00000000-0000-4000-8000-000000000002";
const HISTORICAL_CATALOG_LABEL = "SYNTHETIC Historisch Archief";
const CLOSED_TITLE = "SYNTHETIC gesloten archiefopdracht";
const RATE_CASES = [
  {
    detailRate: /€\s*4\.000–€\s*6\.000 \/ maand/u,
    period: "/ maand",
    title: "SYNTHETIC maandtarief",
    value: /€\s*4\.000–€\s*6\.000/u,
  },
  {
    detailRate: /€\s*500–€\s*750 \/ dag/u,
    period: "/ dag",
    title: "SYNTHETIC dagtarief",
    value: /€\s*500–€\s*750/u,
  },
  {
    detailRate: /€\s*3\.750–€\s*4\.250 \(periode onbekend\)/u,
    period: "(periode onbekend)",
    title: "SYNTHETIC tarief zonder periode",
    value: /€\s*3\.750–€\s*4\.250/u,
  },
  {
    detailRate: /vanaf €\s*650 \/ dag/u,
    period: "/ dag",
    title: "SYNTHETIC minimum dagtarief",
    value: /vanaf €\s*650/u,
  },
] as const;

const openJobs = async (page: Page, url = "/jobs") => {
  await page.goto(url, { waitUntil: "domcontentloaded" });
  // #464 dropped the "Live · U7 REST" badge; the toolbar's preview control
  // only exists once the signed-in search page has rendered.
  await expect(page.getByLabel("Preview UI-state")).toBeVisible();
};

const waitForSearchResponse = (page: Page) =>
  page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      response.url() === "http://localhost:3100/v1/aanvragen/search" &&
      response.ok(),
    { timeout: 15_000 }
  );

const REST_CORS_HEADERS = {
  "access-control-allow-credentials": "true",
  "access-control-allow-origin": "http://localhost:3001",
} as const;

const fulfillRestSearchResponse = async (
  route: Route,
  body: string,
  status: number
) => {
  if (route.request().method() === "OPTIONS") {
    await route.fallback();
    return;
  }
  await route.fulfill({
    body,
    contentType: "application/json",
    headers: REST_CORS_HEADERS,
    status,
  });
};

const emptySearchResponse = {
  archiveTotal: 0,
  facets: {
    bron_id: [],
    contracttype: [],
    locatie: [],
    locatie_land: [],
    provincie: [],
    skills: [],
    status: [],
  },
  hits: [],
  ids: [],
  incomplete: false,
  indexVersion: 0,
  parserVersion: 1,
  scope: "active",
  total: 0,
  windowLimit: 1000,
} as const;

test("renders the REST total and hands returned facets to search", async ({
  page,
}) => {
  const overviewSearchResponse = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      response.url() === "http://localhost:3100/v1/aanvragen/search" &&
      response.ok(),
    { timeout: 15_000 }
  );
  const searchBodies: unknown[] = [];
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (
      request.method() === "POST" &&
      url.origin === "http://localhost:3100" &&
      url.pathname === "/v1/aanvragen/search"
    ) {
      searchBodies.push(request.postDataJSON());
    }
  });

  await page.goto("/", { waitUntil: "domcontentloaded" });
  const searchResponse = await overviewSearchResponse;
  // SAFETY: the successful response comes from the typed synthetic search handler.
  const searchBody = (await searchResponse.json()) as {
    readonly facets: {
      readonly bron_id: readonly { count: number; value: string }[];
    };
    readonly ids: readonly string[];
    readonly total: number;
  };
  await expect(page.getByText("Live overzicht", { exact: true })).toBeVisible();
  await expect(
    page.getByText("Beschikbare opdrachten", { exact: true }).locator("..")
  ).toContainText("8");
  await expect(
    page.getByText("In archief", { exact: true }).locator("..")
  ).toContainText("1");
  expect(searchBody.total).toBe(8);
  expect(searchBody.ids).toHaveLength(1);
  expect(searchBody.facets.bron_id).toEqual(
    expect.arrayContaining([
      {
        count: 1,
        value: LIVE_CATALOG_BRON_ID,
      },
    ])
  );
  expect(searchBodies).toEqual([
    expect.objectContaining({
      limit: 1,
      offset: 0,
      query: "",
      sort: "relevance",
    }),
  ]);

  const liveSourceLink = page.getByRole("link", {
    name: new RegExp(`^${LIVE_CATALOG_LABEL}`, "u"),
  });
  await expect(liveSourceLink).toHaveAttribute(
    "href",
    "/jobs?source=synthetic-catalogus-live"
  );
  const filteredSearchResponse = waitForSearchResponse(page);
  await liveSourceLink.click();
  await expect(page).toHaveURL(
    "http://localhost:3001/jobs?source=synthetic-catalogus-live"
  );
  await filteredSearchResponse;
  expect(searchBodies.at(-1)).toEqual(
    expect.objectContaining({
      filters: expect.objectContaining({ bronIds: [LIVE_CATALOG_BRON_ID] }),
    })
  );
  await expect(
    page.getByRole("checkbox", {
      name: new RegExp(`^${LIVE_CATALOG_LABEL}`, "u"),
    })
  ).toBeChecked();
});

test("renders the live overview after the dashboard server session guard", async ({
  page,
}) => {
  await page.goto("/dashboard", { waitUntil: "domcontentloaded" });
  await expect(page).toHaveURL("http://localhost:3001/dashboard");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Dashboard");
  await expect(
    page.getByText("Welcome Search Audit", { exact: true })
  ).toBeVisible();
  await expect(
    page
      .getByRole("main")
      .getByText("Beschikbare opdrachten", { exact: true })
      .locator("..")
  ).toContainText("8");
  await expect(
    page.getByText("API: This is private", { exact: true })
  ).toHaveCount(0);
});

test("keeps the server-authenticated dashboard when browser session lookup fails", async ({
  page,
}) => {
  await page.route("**/api/auth/get-session", (route) =>
    route.fulfill({
      body: JSON.stringify({ message: "synthetic session lookup outage" }),
      contentType: "application/json",
      headers: REST_CORS_HEADERS,
      status: 503,
    })
  );
  const failedSession = page.waitForResponse(
    (response) =>
      response.url().includes("/api/auth/get-session") &&
      response.status() === 503
  );
  await page.goto("/dashboard", { waitUntil: "domcontentloaded" });
  await failedSession;
  await expect(
    page.getByText("Welcome Search Audit", { exact: true })
  ).toBeVisible();
  await expect(
    page
      .getByRole("main")
      .getByText("Beschikbare opdrachten", { exact: true })
      .locator("..")
  ).toContainText("8");
  await expect(
    page.getByRole("main").getByRole("button", { name: "Inloggen" })
  ).toHaveCount(0);
});

test("keeps anonymous home free of fabricated overview metrics", async ({
  page,
}) => {
  await page.route("**/api/auth/get-session", (route) =>
    route.fulfill({
      body: "null",
      contentType: "application/json",
      headers: REST_CORS_HEADERS,
      status: 200,
    })
  );

  await page.goto("/", { waitUntil: "domcontentloaded" });
  await expect(
    page.getByRole("heading", { name: "Vind de juiste opdracht vóór de rest." })
  ).toBeVisible();
  await expect(
    page
      .getByRole("main")
      .getByRole("button", { exact: true, name: "Inloggen" })
  ).toBeVisible();
  await expect(
    page.getByText("Beschikbare opdrachten", { exact: true })
  ).toHaveCount(0);
  await expect(page.getByText("In archief", { exact: true })).toHaveCount(0);
  await expect(page.getByText("Demogegevens", { exact: true })).toHaveCount(0);
});

test("shows a truthful live overview error when the REST search fails", async ({
  page,
}) => {
  await page.route("**/v1/aanvragen/search", (route) =>
    fulfillRestSearchResponse(
      route,
      JSON.stringify({
        error: {
          code: "INTERNAL_ERROR",
          message: "synthetic overview outage",
        },
      }),
      503
    )
  );

  await page.goto("/", { waitUntil: "domcontentloaded" });
  await expect(page.getByRole("main").getByRole("alert")).toContainText(
    "De actuele aantallen konden niet worden geladen."
  );
  await expect(
    page.getByRole("button", { name: "Opnieuw proberen" })
  ).toBeVisible();
  await expect(
    page.getByText("Beschikbare opdrachten", { exact: true })
  ).toHaveCount(0);
});

test("shows an explicit empty state for a successful zero-hit REST search", async ({
  page,
}) => {
  await page.route("**/v1/aanvragen/search", (route) =>
    fulfillRestSearchResponse(route, JSON.stringify(emptySearchResponse), 200)
  );

  await page.goto("/", { waitUntil: "domcontentloaded" });
  await expect(
    page.getByRole("heading", {
      name: "Geen beschikbare opdrachten gevonden.",
    })
  ).toBeVisible();
  await expect(
    page.getByText("Beschikbare opdrachten", { exact: true })
  ).toHaveCount(0);
  await expect(
    page
      .getByRole("main")
      .getByRole("button", { exact: true, name: "Open job search" })
  ).toBeVisible();
});

test("browses empty and filter-only searches and preserves comma URL state", async ({
  context,
  page,
}) => {
  await openJobs(page);
  const searchInput = page.getByLabel("Zoek opdrachten met Boolean-logica");
  await expect(searchInput).toHaveValue("");
  await expect(page.getByText("Boolean-query klopt nog niet")).toHaveCount(0);
  await expect(
    page.getByRole("region", { name: "Zoekresultaten" })
  ).toContainText("Brongetrouwe onbekende velden");

  const locationFilter = page.getByRole("checkbox", {
    name: new RegExp(`^${COMMA_LOCATION}`, "u"),
  });
  await locationFilter.check();
  await expect(searchInput).toHaveValue("");
  await expect(page).toHaveURL(
    (url) =>
      url.searchParams.get("q") === null &&
      url.searchParams.get("location") === COMMA_LOCATION
  );
  await expect(
    page.getByRole("button", {
      name: "Amsterdam, Noord-Holland platformopdracht",
    })
  ).toBeVisible();

  await searchInput.fill(COMMA_QUERY);
  await page.getByRole("button", { exact: true, name: "Zoeken" }).click();
  await page.reload({ waitUntil: "domcontentloaded" });
  await expect(searchInput).toHaveValue(COMMA_QUERY);
  await expect(page).toHaveURL(
    (url) =>
      url.searchParams.get("q") === COMMA_QUERY &&
      url.searchParams.getAll("location").length === 1 &&
      url.searchParams.get("location") === COMMA_LOCATION
  );

  const sharedUrl = page.url();
  const sharedPage = await context.newPage();
  await openJobs(sharedPage, sharedUrl);
  await expect(
    sharedPage.getByLabel("Zoek opdrachten met Boolean-logica")
  ).toHaveValue(COMMA_QUERY);
  await expect(
    sharedPage.getByRole("checkbox", {
      name: new RegExp(`^${COMMA_LOCATION}`, "u"),
    })
  ).toBeChecked();
  await sharedPage.close();

  await Promise.all([
    waitForSearchResponse(page),
    page
      .getByRole("button", { name: `Zoekterm ${COMMA_QUERY} verwijderen` })
      .click(),
  ]);
  await expect(searchInput).toHaveValue("");
  await expect(page).toHaveURL(
    (url) =>
      url.searchParams.get("q") === null &&
      url.searchParams.get("location") === COMMA_LOCATION
  );
  await expect(
    page.getByRole("button", {
      name: "Amsterdam, Noord-Holland platformopdracht",
    })
  ).toBeVisible();

  await searchInput.fill("(Azure");
  await page.getByRole("button", { exact: true, name: "Zoeken" }).click();
  await expect(
    page.getByRole("heading", { name: "Boolean-query klopt nog niet" })
  ).toBeVisible();
  const malformedQueryChip = page.getByRole("button", {
    exact: true,
    name: "Zoekterm (Azure verwijderen",
  });
  // CTP-512: chip-bar Alles wissen clears filters only; zoekterm stays.
  // Do not waitForResponse(ok): kept malformed q may POST SYNTAX_ERROR, and the
  // prior Zoeken POST can race. Settle on UI/URL instead.
  await malformedQueryChip
    .locator("..")
    .getByRole("button", { exact: true, name: "Alles wissen" })
    .click();
  // URL is source of truth: location facet checkbox may unmount after
  // a syntax-error search empties facets.
  await expect(page).toHaveURL(
    (url) =>
      url.searchParams.get("q") === "(Azure" &&
      url.searchParams.get("location") === null
  );
  await expect(searchInput).toHaveValue("(Azure");
  await Promise.all([waitForSearchResponse(page), malformedQueryChip.click()]);
  await expect(page).toHaveURL("http://localhost:3001/jobs");
  await expect(searchInput).toHaveValue("");
  await expect(malformedQueryChip).toHaveCount(0);
  await expect(
    page.getByRole("heading", { name: "Boolean-query klopt nog niet" })
  ).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Brongetrouwe onbekende velden" })
  ).toBeVisible();
});

test("distinguishes published commercial facts from unknown source facts", async ({
  page,
}, testInfo) => {
  await openJobs(page);
  const results = page.getByRole("region", { name: "Zoekresultaten" });
  const publishedRow = results
    .getByRole("row")
    .filter({ hasText: "Amsterdam, Noord-Holland platformopdracht" });
  const publishedCells = publishedRow.getByRole("cell");
  // Grouped cells: Opdracht / Tarief & uren / Locatie / Bron / Data
  await expect(publishedCells.nth(0)).toContainText("Detachering");
  await expect(publishedCells.nth(1)).toContainText(/€\s*90–€\s*110/u);
  await expect(publishedCells.nth(1)).toContainText("/ uur · remote");
  await expect(publishedCells.nth(2)).toContainText(COMMA_LOCATION);
  await expect(publishedCells.nth(3)).toContainText("TenderNed");
  await expect(publishedCells.nth(4).locator("time")).toHaveText("1 sep 2026");
  await expect(publishedCells.nth(4)).toContainText("Sluit 30 sep 2099");

  const unknownRow = results
    .getByRole("row")
    .filter({ hasText: "Brongetrouwe onbekende velden" });
  const unknownCells = unknownRow.getByRole("cell");
  await expect(unknownCells.nth(1).getByText("—", { exact: true })).toHaveCount(
    2
  );
  await expect(unknownCells.nth(1)).not.toContainText("Tarief onbekend");
  await expect(unknownCells.nth(2)).toHaveText("—");
  await expect(unknownCells.nth(4).locator("time")).toHaveText("—");
  await expect(unknownCells.nth(4)).not.toContainText("Sluit");
  await page.screenshot({
    animations: "disabled",
    fullPage: true,
    path: testInfo.outputPath("published-versus-unknown-fields.png"),
  });
});

for (const { detailRate, period, title, value } of RATE_CASES) {
  test(`shows ${title} in results and detail`, async ({ page }) => {
    await openJobs(page);
    const results = page.getByRole("region", { name: "Zoekresultaten" });
    const row = results.getByRole("row").filter({ hasText: title });
    await expect(row).toBeVisible();
    const condities = row.getByRole("cell").nth(1);
    await expect(condities).toContainText(value);
    await expect(condities).toContainText(period);
    await expect(condities).not.toContainText("/ uur");

    await row.getByRole("button", { name: title }).click();
    const detail = page.getByRole("dialog", { exact: true, name: title });
    await expect(detail).toBeVisible();
    await expect(detail.getByRole("heading", { name: title })).toBeVisible();
    await expect(detail).toContainText(detailRate);
    await expect(detail).not.toContainText("/ uur");

    await detail
      .getByRole("button", { name: "Vacaturedetail sluiten" })
      .click();
    await expect(detail).toHaveCount(0);
  });
}

test("shows catalog labels, historical archive filters, and closed results", async ({
  page,
}) => {
  await openJobs(page);
  const results = page.getByRole("region", { name: "Zoekresultaten" });
  await expect(results).toContainText(LIVE_CATALOG_LABEL);

  const historicalSourceFilter = page.getByRole("checkbox", {
    name: new RegExp(`^${HISTORICAL_CATALOG_LABEL}`, "u"),
  });
  await expect(historicalSourceFilter).toBeVisible();

  await Promise.all([
    waitForSearchResponse(page),
    page.getByRole("checkbox", { name: "Ook in archief zoeken" }).check(),
  ]);
  const closedRow = results.getByRole("row").filter({ hasText: CLOSED_TITLE });
  await expect(closedRow).toContainText("Gesloten");
  await expect(closedRow).toContainText(HISTORICAL_CATALOG_LABEL);

  await Promise.all([
    waitForSearchResponse(page),
    historicalSourceFilter.check(),
  ]);
  await expect(page).toHaveURL(
    (url) =>
      url.searchParams.get("archief") === "1" &&
      url.searchParams.get("source") === "synthetic-historisch-archief"
  );
  await expect(closedRow).toBeVisible();
});

test("clears sidebar filters while keeping the zoekterm (CTP-510/CTP-512)", async ({
  page,
}) => {
  await openJobs(
    page,
    "/jobs?archief=1&q=archief&source=synthetic-historisch-archief&sort=closing-soon&page=2"
  );

  const searchInput = page.getByLabel("Zoek opdrachten met Boolean-logica");
  const archiveToggle = page.getByRole("checkbox", {
    name: "Ook in archief zoeken",
  });
  const historicalSourceFilter = page.getByRole("checkbox", {
    name: new RegExp(`^${HISTORICAL_CATALOG_LABEL}`, "u"),
  });
  const sortSelect = page.getByRole("combobox", {
    name: "Resultaten sorteren",
  });

  await expect(searchInput).toHaveValue("archief");
  await expect(archiveToggle).toBeChecked();
  await expect(historicalSourceFilter).toBeChecked();
  await expect(sortSelect).toHaveValue("closing-soon");

  // Desktop aside only — JobFilters also mounts in the mobile drawer.
  const sidebarClear = page
    .locator("aside")
    .getByTestId("job-filters-clear-all");
  await expect(sidebarClear).toBeVisible();
  await expect(
    page
      .locator("aside")
      .getByRole("button", { exact: true, name: "Alles wissen" })
  ).toHaveCount(1);
  await Promise.all([waitForSearchResponse(page), sidebarClear.click()]);

  // Mock resetAll: filters only. Zoekterm / archief / sort blijven.
  await expect(page).toHaveURL(
    (url) =>
      url.searchParams.get("q") === "archief" &&
      url.searchParams.get("source") === null &&
      url.searchParams.get("archief") === "1" &&
      url.searchParams.get("sort") === "closing-soon"
  );
  await expect(searchInput).toHaveValue("archief");
  await expect(archiveToggle).toBeChecked();
  await expect(historicalSourceFilter).not.toBeChecked();
  await expect(sortSelect).toHaveValue("closing-soon");
});

test("filters closed status in the archive and preserves it in the URL", async ({
  page,
}) => {
  const searchBodies: unknown[] = [];
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (
      request.method() === "POST" &&
      url.origin === "http://localhost:3100" &&
      url.pathname === "/v1/aanvragen/search"
    ) {
      searchBodies.push(request.postDataJSON());
    }
  });

  await openJobs(page);
  const results = page.getByRole("region", { name: "Zoekresultaten" });
  const closedStatus = page.getByRole("checkbox", { name: /^Gesloten/u });
  await expect(closedStatus).toBeVisible();

  await Promise.all([
    waitForSearchResponse(page),
    page.getByRole("checkbox", { name: "Ook in archief zoeken" }).check(),
  ]);
  await Promise.all([waitForSearchResponse(page), closedStatus.check()]);

  await expect(page).toHaveURL(
    (url) =>
      url.searchParams.get("archief") === "1" &&
      url.searchParams.getAll("status").length === 1 &&
      url.searchParams.get("status") === "closed"
  );
  expect(searchBodies).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        filters: expect.objectContaining({ status: ["closed"] }),
        scope: "all",
      }),
    ])
  );

  const closedRow = results.getByRole("row").filter({ hasText: CLOSED_TITLE });
  await expect(closedRow).toHaveCount(1);
  await expect(closedRow).toContainText("Gesloten");

  await page.reload({ waitUntil: "domcontentloaded" });
  await expect(
    page.getByRole("checkbox", { name: /^Gesloten/u })
  ).toBeChecked();
  await expect(
    page.getByRole("checkbox", { name: "Ook in archief zoeken" })
  ).toBeChecked();
  await expect(
    page
      .getByRole("region", { name: "Zoekresultaten" })
      .getByRole("row")
      .filter({ hasText: CLOSED_TITLE })
  ).toHaveCount(1);
});

test.describe("date-only facts in a negative UTC timezone", () => {
  test.use({ timezoneId: "America/Los_Angeles" });

  test("loads full REST detail without making search batch hydration full", async ({
    page,
  }) => {
    const batchBodies: unknown[] = [];
    page.on("request", (request) => {
      const url = new URL(request.url());
      if (
        request.method() === "POST" &&
        url.origin === "http://localhost:3100" &&
        url.pathname === "/v1/aanvragen/batch"
      ) {
        batchBodies.push(request.postDataJSON());
      }
    });

    await openJobs(page);
    await expect(
      page.getByRole("region", { name: "Zoekresultaten" })
    ).toContainText(LIVE_CATALOG_LABEL);
    const fullDetailResponse = page.waitForResponse(
      (response) => {
        const url = new URL(response.url());
        return (
          response.request().method() === "GET" &&
          url.origin === "http://localhost:3100" &&
          url.pathname === `/v1/aanvragen/${DETAIL_ID}` &&
          url.searchParams.get("full") === "true" &&
          response.ok()
        );
      },
      { timeout: 15_000 }
    );
    await page.getByRole("button", { name: DETAIL_TITLE }).click();
    const detailResponse = await fullDetailResponse;
    // SAFETY: the successful response comes from the typed synthetic get_aanvraag handler.
    const detailBody = (await detailResponse.json()) as {
      aanvraag: {
        beschrijving: string;
        eindDatum: string | null;
        mode: string;
        startDatum: string | null;
        urenPerWeek: string | null;
      };
    };
    expect(detailBody.aanvraag.mode).toBe("full");
    expect(detailBody.aanvraag.beschrijving.length).toBeGreaterThan(500);
    expect(detailBody.aanvraag.beschrijving).toContain(DETAIL_END_MARKER);
    expect(detailBody.aanvraag.eindDatum).toBe("2027-02-28");
    expect(detailBody.aanvraag.startDatum).toBe("2026-10-01");
    expect(detailBody.aanvraag.urenPerWeek).toBe("32");

    await expect(
      page.getByRole("heading", { name: DETAIL_TITLE })
    ).toBeVisible();
    const detailFacts = page.locator("dl:visible");
    await expect(
      detailFacts
        .locator("dt")
        .filter({ hasText: "Uren per week" })
        .locator("..")
    ).toContainText("32");
    await expect(
      detailFacts.locator("dt").filter({ hasText: "Startdatum" }).locator("..")
    ).toContainText("1 okt 2026");
    await expect(
      detailFacts.locator("dt").filter({ hasText: "Einddatum" }).locator("..")
    ).toContainText("28 feb 2027");
    const detailDescription = page
      .locator("[data-body-format]:visible")
      .filter({ hasText: DETAIL_END_MARKER });
    await expect(detailDescription).toBeVisible();
    await expect(detailDescription).toContainText(DETAIL_END_MARKER);
    const detailText = await detailDescription.textContent();
    expect(detailText?.length).toBeGreaterThan(500);

    expect(batchBodies.length).toBeGreaterThan(0);
    expect(batchBodies).not.toContainEqual(
      expect.objectContaining({ full: true })
    );
  });
});

test("shows and retries a zero-hit query timeout", async ({
  page,
}, testInfo) => {
  await openJobs(page, `/jobs?q=${ZERO_TIMEOUT_QUERY}`);
  await expect(
    page.getByRole("heading", { name: "Zoekresultaat is onvolledig" })
  ).toBeVisible();
  const snapshotButton = page.getByRole("button", { name: "Snapshot maken" });
  await expect(snapshotButton).toBeDisabled();
  await page.screenshot({
    animations: "disabled",
    fullPage: true,
    path: testInfo.outputPath("zero-hit-timeout.png"),
  });
  await page.getByRole("button", { name: "Opnieuw proberen" }).click();
  await expect(
    page.getByRole("heading", { name: "Geen opdrachten gevonden" })
  ).toBeVisible();
});

test("keeps partial hits visible and blocks snapshots until retry", async ({
  page,
}, testInfo) => {
  const capabilityRequests: string[] = [];
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (
      url.origin === "http://localhost:3100" &&
      url.pathname.startsWith("/v1/")
    ) {
      capabilityRequests.push(`${request.method()} ${url.pathname}`);
    }
  });
  await openJobs(page, "/jobs?q=timeout");
  const incompleteAlert = page
    .getByRole("region", { name: "Zoekresultaten" })
    .getByRole("alert");
  await expect(incompleteAlert).toContainText("Zoekresultaat is onvolledig");
  await page.getByRole("button", { name: "Timeout platformopdracht" }).click();
  await expect(
    page.getByRole("heading", { name: "Timeout platformopdracht" })
  ).toBeVisible();
  await page.getByRole("button", { name: "Vacaturedetail sluiten" }).click();
  await expect(page.getByRole("dialog")).not.toBeVisible();
  const snapshotButton = page.getByRole("button", { name: "Snapshot maken" });
  await expect(snapshotButton).toBeDisabled();
  await expect(snapshotButton).toHaveAttribute(
    "title",
    "Snapshot is beschikbaar zodra de zoekuitkomst volledig geladen is"
  );
  await page.screenshot({
    animations: "disabled",
    fullPage: true,
    path: testInfo.outputPath("partial-hit-timeout-after-detail.png"),
  });

  await incompleteAlert
    .getByRole("button", { name: "Opnieuw proberen" })
    .click();
  await expect(incompleteAlert).toHaveCount(0);
  await page
    .getByRole("checkbox", {
      name: "Selecteer alle resultaten op deze pagina",
    })
    .check();
  await expect(snapshotButton).toBeEnabled();
  expect(capabilityRequests).toEqual(
    expect.arrayContaining([
      "GET /v1/bronnen",
      "POST /v1/aanvragen/search",
      "POST /v1/aanvragen/batch",
    ])
  );
});

for (const viewport of [
  { height: 960, width: 1440 },
  { height: 844, width: 390 },
]) {
  test(`opens a right-side detail drawer at ${viewport.width}px and restores focus`, async ({
    page,
  }, testInfo) => {
    await page.setViewportSize(viewport);
    await openJobs(page);
    const trigger = page.getByRole("button", {
      name: DETAIL_TITLE,
    });
    await expect(trigger).toBeVisible();
    const resultElement = page.locator('[aria-label="Zoekresultaten"]');
    const before = await resultElement.boundingBox();
    await trigger.click();
    const drawer = page.getByRole("dialog", {
      exact: true,
      name: DETAIL_TITLE,
    });
    await expect(drawer).toBeVisible();
    await expect(page.locator('[data-slot="drawer-overlay"]')).toBeVisible();
    await expect(page).toHaveURL(
      (url) => url.searchParams.get("job") === DETAIL_ID
    );
    await expect
      .poll(async () => {
        const bounds = await drawer.boundingBox();
        return bounds
          ? Math.abs(bounds.x + bounds.width - viewport.width)
          : 999;
      })
      .toBeLessThan(2);
    const bounds = await drawer.boundingBox();
    expect(bounds?.height).toBeGreaterThan(viewport.height - 5);
    if (viewport.width > 800) {
      expect(bounds?.width).toBeGreaterThan(500);
      expect(bounds?.width).toBeLessThan(800);
    } else {
      expect(bounds?.width).toBeGreaterThan(viewport.width - 5);
    }
    const after = await resultElement.boundingBox();
    expect(after?.width).toBeCloseTo(before?.width ?? 0, 0);
    await page.screenshot({
      animations: "disabled",
      path: testInfo.outputPath("right-drawer.png"),
    });
    const close = drawer.getByRole("button", {
      name: "Vacaturedetail sluiten",
    });
    await close.focus();
    await page.keyboard.press("Shift+Tab");
    await expect
      .poll(() =>
        drawer.evaluate((element) =>
          element.contains(element.ownerDocument.activeElement)
        )
      )
      .toBe(true);
    await drawer.locator("[data-body-format]").scrollIntoViewIfNeeded();
    await expect(drawer.locator("[data-body-format]")).toContainText(
      DETAIL_END_MARKER
    );
    await page.keyboard.press("Escape");
    await expect(drawer).not.toBeVisible();
    await expect(page).toHaveURL((url) => !url.searchParams.has("job"));
    await expect(trigger).toBeFocused();
    await trigger.click();
    await expect(drawer).toBeVisible();
    await drawer
      .getByRole("button", { name: "Vacaturedetail sluiten" })
      .click();
    await expect(drawer).not.toBeVisible();
    await expect(trigger).toBeFocused();
  });
}

test("keeps drawer deep links and browser navigation consistent", async ({
  page,
}) => {
  await openJobs(page);
  await page.getByRole("button", { name: DETAIL_TITLE }).click();
  const drawer = page.getByRole("dialog", { exact: true, name: DETAIL_TITLE });
  await expect(drawer).toBeVisible();
  await page.goBack();
  await expect(drawer).not.toBeVisible();
  await page.goForward();
  await expect(drawer).toBeVisible();
  await page.reload();
  await expect(drawer).toBeVisible();
  await page.mouse.click(10, 300);
  await expect(drawer).not.toBeVisible();
  await expect(page).toHaveURL((url) => !url.searchParams.has("job"));
});
