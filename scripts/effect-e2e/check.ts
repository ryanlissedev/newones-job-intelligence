import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { chromium, expect } from "@playwright/test";
import type { Page } from "@playwright/test";
import { z } from "zod";

import {
  isExpectedDenialConsoleError,
  isSupersededAbort,
} from "./browser-noise";
import {
  EFFECT_E2E_SCHEMA_VERSION,
  canaryQuery,
  privateAuthPath,
  readEffectE2eConfig,
  seedArtifactSchema,
} from "./contracts";
import type {
  EffectE2eAuthBundle,
  EffectE2eAuthEvidence,
  EffectE2eConfig,
  EffectE2eEnvironment,
} from "./contracts";

const authFileSchema = z.object({
  email: z.string().email(),
  name: z.string().min(1),
  password: z.string().min(12),
  role: z.union([z.literal("operator"), z.literal("recruiter")]),
  subjectId: z.string().min(1),
});
const authBundleSchema = z.object({
  operator: authFileSchema.extend({ role: z.literal("operator") }),
  recruiter: authFileSchema.extend({ role: z.literal("recruiter") }),
});

interface EffectE2eCheckArtifact {
  readonly auth: EffectE2eAuthEvidence;
  readonly canary: {
    readonly digest: string;
    readonly id: string;
    readonly query: string;
  };
  readonly cleanup: {
    readonly database: "disposable";
    readonly seedRead: true;
  };
  readonly browser: {
    readonly operatorBronnen: boolean;
    readonly recruiterBronnenDenied: boolean;
    readonly recruiterDashboardDenied: boolean;
    readonly recruiterSearchResult: boolean;
    readonly seededKpisMatch: boolean;
    readonly seededSourceVisible: boolean;
  };
  readonly evidence: {
    readonly browserErrors: readonly string[];
    readonly checkPath: string;
    readonly forbiddenVisibleText: false;
    readonly frames: readonly string[];
    readonly mp4Path: string;
    readonly readyz: {
      readonly lagEvents: number;
      readonly lagSeconds: number;
      readonly status: "ready";
    };
    readonly releaseSha: string;
    readonly videoInspectionRequired: true;
  };
  readonly seedRows: {
    readonly booleanJobs: 1;
    readonly bronnen: 1;
  };
  readonly schemaVersion: 1;
  readonly status: "passed";
}

interface EffectE2eFailureArtifact {
  readonly auth: EffectE2eAuthEvidence;
  readonly canary: {
    readonly digest: string;
    readonly id: string;
    readonly query: string;
  };
  readonly cleanup: {
    readonly database: "disposable";
    readonly seedRead: boolean;
  };
  readonly browser: {
    readonly operatorBronnen: boolean;
    readonly recruiterBronnenDenied: boolean;
    readonly recruiterDashboardDenied: boolean;
    readonly recruiterSearchResult: boolean;
    readonly seededKpisMatch: boolean;
    readonly seededSourceVisible: boolean;
  };
  readonly evidence: {
    readonly browserErrors: readonly string[];
    readonly checkPath: string;
    readonly failure: string;
  };
  readonly seedRows: {
    readonly booleanJobs: number;
    readonly bronnen: number;
  };
  readonly schemaVersion: 1;
  readonly status: "failed";
}

interface EffectE2eCheckState {
  auth?: EffectE2eAuthBundle;
  readonly browser: {
    operatorBronnen: boolean;
    recruiterBronnenDenied: boolean;
    recruiterDashboardDenied: boolean;
    recruiterSearchResult: boolean;
    seededKpisMatch: boolean;
    seededSourceVisible: boolean;
  };
  readonly browserErrors: string[];
  seed?: z.infer<typeof seedArtifactSchema>;
}

interface JsonResponse {
  readonly body: ParsedJson;
  readonly status: number;
}

type ParsedJson =
  | boolean
  | null
  | number
  | ParsedJson[]
  | string
  | { readonly [key: string]: ParsedJson };

const parsedJsonSchema: z.ZodType<ParsedJson> = z.lazy(() =>
  z.union([
    z.boolean(),
    z.null(),
    z.number(),
    z.string(),
    z.array(parsedJsonSchema),
    z.record(z.string(), parsedJsonSchema),
  ])
);

const safeError = (error: Error): string =>
  error.message
    .replaceAll(/https?:\/\/[^\s/]+/gu, "configured-endpoint")
    .replaceAll(
      /(?<secret>password|token|secret|cookie)[^\s]*/giu,
      "$<secret>-redacted"
    );

const parseJson = (text: string): ParsedJson => {
  try {
    return parsedJsonSchema.parse(JSON.parse(text));
  } catch {
    return text;
  }
};

const fetchJson = async (
  url: string,
  init: RequestInit = {}
): Promise<JsonResponse> => {
  const response = await fetch(url, {
    ...init,
    signal: AbortSignal.timeout(10_000),
  });
  const text = await response.text();
  return { body: parseJson(text), status: response.status };
};

const assertReady = async (config: EffectE2eConfig) => {
  const response = await fetchJson(new URL("/readyz", config.apiUrl).href);
  if (response.status !== 200) {
    throw new Error("/readyz did not return HTTP 200.");
  }
  const componentSchema = z.object({
    lagEvents: z.number().optional(),
    lagSeconds: z.number().optional(),
    status: z.string(),
  });
  const report = z
    .object({
      components: z.record(z.string(), componentSchema),
      status: z.string(),
    })
    .parse(response.body);
  if (report.status !== "ready") {
    throw new Error("/readyz did not report ready.");
  }
  for (const component of [
    "postgres",
    "manticore",
    "rawObjectStore",
    "searchProjection",
  ]) {
    if (report.components[component]?.status !== "ok") {
      throw new Error(`/readyz component ${component} is not ok.`);
    }
  }
  const { redis } = report.components;
  if (!redis || !["ok", "not-configured"].includes(redis.status)) {
    throw new Error("/readyz redis component is not healthy.");
  }
  const projection = report.components.searchProjection;
  if (projection?.lagEvents !== 0 || projection?.lagSeconds !== 0) {
    throw new Error("/readyz search projection lag is not zero.");
  }
  return {
    lagEvents: projection.lagEvents,
    lagSeconds: projection.lagSeconds,
    status: "ready" as const,
  };
};

const assertVersion = async (config: EffectE2eConfig): Promise<string> => {
  const response = await fetchJson(new URL("/version", config.apiUrl).href);
  if (response.status !== 200) {
    throw new Error("/version did not return HTTP 200.");
  }
  const payload = z.object({ releaseSha: z.string() }).parse(response.body);
  if (payload.releaseSha !== config.expectedSha) {
    throw new Error("/version release SHA does not match the expected SHA.");
  }
  return payload.releaseSha;
};

const readSeed = async (config: EffectE2eConfig) => {
  const seedPath = path.join(config.artifactDir, "seed.json");
  const seedText = await readFile(seedPath, "utf-8");
  const parsed = seedArtifactSchema.parse(parseJson(seedText));
  if (
    parsed.canary.id !== config.canaryId ||
    parsed.canary.digest !== config.canaryDigest ||
    parsed.auth.recruiter.role !== "recruiter" ||
    parsed.auth.operator.role !== "operator"
  ) {
    throw new Error("seed.json does not match the configured canary.");
  }
  return parsed;
};

const readAuth = async (
  environment: EffectE2eEnvironment,
  config: EffectE2eConfig
): Promise<EffectE2eAuthBundle> => {
  const authPath = privateAuthPath(environment, config.privateDir);
  const authText = await readFile(authPath, "utf-8");
  return authBundleSchema.parse(parseJson(authText));
};

const runFfmpeg = async (args: readonly string[]): Promise<void> => {
  const process = Bun.spawn(["ffmpeg", ...args], {
    stderr: "pipe",
    stdout: "pipe",
  });
  const exitCode = await process.exited;
  if (exitCode !== 0) {
    throw new Error("ffmpeg could not create the H264 evidence artifact.");
  }
};

const transcodeAndExtractFrames = async (
  config: EffectE2eConfig,
  webmPath: string
): Promise<{
  readonly frames: readonly string[];
  readonly mp4Path: string;
}> => {
  const mp4Path = path.join(config.artifactDir, "browser-flow.mp4");
  const firstFrame = path.join(config.artifactDir, "browser-flow-first.png");
  const lastFrame = path.join(config.artifactDir, "browser-flow-last.png");
  await runFfmpeg([
    "-y",
    "-loglevel",
    "error",
    "-i",
    webmPath,
    "-c:v",
    "libx264",
    "-preset",
    "medium",
    "-crf",
    "23",
    "-pix_fmt",
    "yuv420p",
    "-movflags",
    "+faststart",
    mp4Path,
  ]);
  await runFfmpeg([
    "-y",
    "-loglevel",
    "error",
    "-i",
    mp4Path,
    "-frames:v",
    "1",
    firstFrame,
  ]);
  await runFfmpeg([
    "-y",
    "-loglevel",
    "error",
    "-sseof",
    "-0.5",
    "-i",
    mp4Path,
    "-frames:v",
    "1",
    lastFrame,
  ]);
  return { frames: [firstFrame, lastFrame], mp4Path };
};

const attachBrowserErrorListeners = (
  page: Page,
  errors: string[],
  expectedDenials?: { active: boolean }
): void => {
  page.on("pageerror", (error) => {
    errors.push(`pageerror:${error.message.slice(0, 160)}`);
  });
  page.on("console", (message) => {
    const messageText = message.text();
    if (
      isExpectedDenialConsoleError(
        message.type(),
        messageText,
        expectedDenials?.active === true
      )
    ) {
      return;
    }
    const isHydrationWarning =
      message.type() === "warning" &&
      /hydration|server-rendered HTML|did not match|React error #418/iu.test(
        messageText
      );
    if (message.type() === "error" || isHydrationWarning) {
      errors.push(`console:${message.type()}:${messageText.slice(0, 160)}`);
    }
  });
  page.on("requestfailed", (request) => {
    const failure = request.failure()?.errorText ?? "unknown";
    const requestUrl = request.url();
    const requestMethod = request.method();
    if (
      isSupersededAbort({
        errorText: failure,
        isNavigation: request.isNavigationRequest(),
        resourceType: request.resourceType(),
        url: requestUrl,
      })
    ) {
      return;
    }
    let pathname = "unknown";
    try {
      ({ pathname } = new URL(requestUrl));
    } catch {
      // Keep malformed URLs out of the receipt rather than recording them.
    }
    errors.push(`requestfailed:${requestMethod}:${pathname}:${failure}`);
  });
  page.on("response", (response) => {
    if (response.status() >= 500) {
      errors.push(`http-${response.status()}`);
    }
  });
};

const inspectApiSearch = async (
  page: Page,
  config: EffectE2eConfig,
  query: string
): Promise<void> => {
  const diagnostic = await page.evaluate(
    async ({ apiUrl, searchQuery }) => {
      const response = await fetch(new URL("/v1/aanvragen/search", apiUrl), {
        body: JSON.stringify({
          filters: {},
          limit: 100,
          offset: 0,
          query: searchQuery,
          scope: "active",
          sort: "relevance",
        }),
        credentials: "include",
        headers: { "content-type": "application/json" },
        method: "POST",
      });
      // SAFETY: Diagnostic output reads only bounded response fields; unknown
      // API fields are ignored and never written to the evidence artifact.
      const body = (await response.json()) as {
        readonly value?: {
          readonly hits?: readonly unknown[];
          readonly ids?: readonly unknown[];
          readonly total?: number;
        };
        readonly hits?: readonly unknown[];
        readonly ids?: readonly unknown[];
        readonly total?: number;
      };
      const result = body.value ?? body;
      const ids = Array.isArray(result.ids) ? result.ids.map(String) : [];
      const hits = Array.isArray(result.hits) ? result.hits.length : 0;
      return {
        hitCount: hits,
        ids,
        keys: Object.keys(result),
        status: response.status,
        total: Number.isFinite(result.total) ? (result.total ?? null) : null,
      };
    },
    { apiUrl: config.apiUrl, searchQuery: query }
  );
  await writeFile(
    path.join(config.artifactDir, "api-search.json"),
    `${JSON.stringify(diagnostic, null, 2)}\n`,
    { encoding: "utf-8", mode: 0o644 }
  );
  if (diagnostic.status !== 200) {
    throw new Error(
      "Authenticated search API diagnostic did not return HTTP 200."
    );
  }
  if (
    diagnostic.hitCount !== 1 ||
    diagnostic.total !== 1 ||
    diagnostic.ids.length !== 1 ||
    diagnostic.ids[0] !== config.canaryId
  ) {
    throw new Error(
      "Authenticated search API diagnostic did not return exactly the seeded canary."
    );
  }
};

const checkState: EffectE2eCheckState = {
  browser: {
    operatorBronnen: false,
    recruiterBronnenDenied: false,
    recruiterDashboardDenied: false,
    recruiterSearchResult: false,
    seededKpisMatch: false,
    seededSourceVisible: false,
  },
  browserErrors: [],
};

const runBrowserFlow = async (
  config: EffectE2eConfig,
  auth: EffectE2eAuthBundle,
  seed: Awaited<ReturnType<typeof readSeed>>
): Promise<{
  readonly browser: EffectE2eCheckState["browser"];
  readonly browserErrors: readonly string[];
  readonly video: {
    readonly frames: readonly string[];
    readonly mp4Path: string;
  };
}> => {
  const browser = await chromium.launch({ headless: true });
  const { browserErrors } = checkState;
  const loginContext = await browser.newContext();
  const loginPage = await loginContext.newPage();
  // Suppression of the generic 403 resource-load console error is scoped to
  // the recruiter denial phase below: outside this window every 403 console
  // error on any page still lands in browserErrors.
  const recruiterDenials = { active: false };
  attachBrowserErrorListeners(loginPage, browserErrors, recruiterDenials);
  try {
    const loginResponse = await loginPage.goto(
      new URL("/login", config.baseUrl).href,
      { waitUntil: "domcontentloaded" }
    );
    if (!loginResponse || loginResponse.status() !== 200) {
      throw new Error("Browser login page did not return HTTP 200.");
    }
    await loginPage.getByLabel("Email").fill(auth.recruiter.email);
    await loginPage.getByLabel("Password").fill(auth.recruiter.password);
    await loginPage.getByRole("button", { name: "Sign In" }).click();
    // The dashboard landing fires the denied /v1/dashboard fetch — the
    // denial phase the 403 console filter exists for.
    recruiterDenials.active = true;
    await loginPage.waitForURL(/\/dashboard$/u, { timeout: 15_000 });
    await loginPage
      .getByText(`Welcome ${auth.recruiter.name}`, { exact: true })
      .waitFor();
    await inspectApiSearch(loginPage, config, seed.canary.query);
    const recruiterDashboardResponse = await loginPage.request.get(
      new URL("/v1/dashboard?window=7d", config.apiUrl).href,
      { failOnStatusCode: false }
    );
    const recruiterDashboardStatus = recruiterDashboardResponse.status();
    if (recruiterDashboardStatus !== 403) {
      throw new Error("Recruiter dashboard API access was not denied.");
    }
    checkState.browser.recruiterDashboardDenied = true;
    await loginPage.goto(new URL("/bronnen?window=7d", config.baseUrl).href, {
      waitUntil: "domcontentloaded",
    });
    const recruiterRedirect = new URL(loginPage.url());
    if (
      recruiterRedirect.pathname !== "/" ||
      recruiterRedirect.searchParams.get("toast") !== "forbidden"
    ) {
      throw new Error(
        "Recruiter /bronnen access was not redirected as forbidden."
      );
    }
    checkState.browser.recruiterBronnenDenied = true;
    recruiterDenials.active = false;
    await writeFile(
      path.join(config.artifactDir, "authorization.json"),
      `${JSON.stringify(
        {
          recruiterBronnenRedirect: {
            pathname: recruiterRedirect.pathname,
            toast: recruiterRedirect.searchParams.get("toast"),
          },
          recruiterDashboardStatus,
        },
        null,
        2
      )}\n`,
      { encoding: "utf-8", mode: 0o644 }
    );

    const storageStatePath = path.join(config.privateDir, "storage-state.json");
    await loginContext.storageState({ path: storageStatePath });
  } catch (error) {
    await browser.close();
    throw error;
  } finally {
    await loginContext.close();
  }

  const videoDir = path.join(config.privateDir, "video");
  await mkdir(videoDir, { mode: 0o700, recursive: true });
  const context = await browser.newContext({
    recordVideo: { dir: videoDir, size: { height: 960, width: 1440 } },
    storageState: path.join(config.privateDir, "storage-state.json"),
    viewport: { height: 960, width: 1440 },
  });
  const page = await context.newPage();
  attachBrowserErrorListeners(page, browserErrors);
  const video = page.video();
  try {
    const jobsResponse = await page.goto(
      new URL("/jobs", config.baseUrl).href,
      { waitUntil: "domcontentloaded" }
    );
    if (!jobsResponse || jobsResponse.status() !== 200) {
      throw new Error("Browser jobs page did not return HTTP 200.");
    }
    await page
      .getByLabel("Zoek opdrachten met Boolean-logica")
      .fill(seed.canary.query);
    await page.getByRole("button", { name: "Zoeken" }).click();
    const resultRegion = page.getByLabel("Zoekresultaten");
    await resultRegion.waitFor({ state: "visible", timeout: 15_000 });
    const exactTitle = resultRegion
      .getByText(seed.canary.title, { exact: true })
      .filter({ visible: true });
    await exactTitle.waitFor({ state: "visible", timeout: 15_000 });
    if ((await exactTitle.count()) !== 1) {
      throw new Error("Boolean search did not return exactly one seeded row.");
    }
    checkState.browser.recruiterSearchResult = true;
    const searchFramePath = path.join(
      config.artifactDir,
      "browser-flow-search.png"
    );
    await page.screenshot({ path: searchFramePath });
    await context.clearCookies();
    await page.goto(new URL("/login", config.baseUrl).href, {
      waitUntil: "domcontentloaded",
    });
    await page.getByLabel("Email").fill(auth.operator.email);
    await page.getByLabel("Password").fill(auth.operator.password);
    await page.getByRole("button", { name: "Sign In" }).click();
    await page.waitForURL(/\/dashboard$/u, { timeout: 15_000 });
    await page
      .getByText(`Welcome ${auth.operator.name}`, { exact: true })
      .waitFor();
    await page.goto(new URL("/bronnen?window=7d", config.baseUrl).href, {
      waitUntil: "domcontentloaded",
    });
    await page
      .getByRole("heading", { exact: true, name: "Bronnen" })
      .waitFor({ state: "visible", timeout: 15_000 });
    checkState.browser.operatorBronnen = true;
    const visibleKpi = (testId: string) =>
      page.locator(`[data-testid="${testId}"]:visible`);
    await visibleKpi("bronnen-kpi-runs").waitFor({
      state: "visible",
      timeout: 15_000,
    });
    await Promise.all(
      [
        "bronnen-kpi-success",
        "bronnen-kpi-nieuw",
        "bronnen-kpi-gewijzigd",
        "bronnen-kpi-ongewijzigd",
        "bronnen-kpi-rejected",
      ].map((testId) =>
        visibleKpi(testId).waitFor({ state: "visible", timeout: 15_000 })
      )
    );
    const seededSourceName = `Effect E2E Source ${seed.canary.id.slice(0, 8)}`;
    const seededSource = page
      .getByText(seededSourceName, { exact: true })
      .filter({ visible: true });
    await expect(seededSource).toHaveCount(1, { timeout: 15_000 });
    checkState.browser.seededSourceVisible = true;
    const expectedKpis = [
      ["bronnen-kpi-runs", "1"],
      ["bronnen-kpi-success", "100%"],
      ["bronnen-kpi-nieuw", "1"],
      ["bronnen-kpi-gewijzigd", "0"],
      ["bronnen-kpi-ongewijzigd", "0"],
      ["bronnen-kpi-rejected", "0"],
    ] as const;
    await Promise.all(
      expectedKpis.map(([testId, expected]) =>
        expect(visibleKpi(testId).locator("p").nth(1)).toHaveText(expected, {
          timeout: 15_000,
        })
      )
    );
    checkState.browser.seededKpisMatch = true;
    const visibleTextParts = await page.locator(":visible").allTextContents();
    const visibleText = visibleTextParts.join(" ").toLowerCase();
    if (
      visibleText.includes("previewdata") ||
      visibleText.includes("fixtures") ||
      visibleText.includes("mock")
    ) {
      throw new Error("Forbidden fixture/mock text is visible in the browser.");
    }
  } finally {
    await context.close();
    await browser.close();
  }
  if (!video) {
    throw new Error("Playwright did not create a browser recording.");
  }
  const webmPath = await video.path();
  const evidenceVideo = await transcodeAndExtractFrames(config, webmPath);
  return {
    browser: checkState.browser,
    browserErrors,
    video: {
      ...evidenceVideo,
      frames: [
        path.join(config.artifactDir, "browser-flow-search.png"),
        ...evidenceVideo.frames,
      ],
    },
  };
};

const writeCheckArtifact = async (
  config: EffectE2eConfig,
  artifact: EffectE2eCheckArtifact | EffectE2eFailureArtifact
): Promise<void> => {
  await mkdir(config.artifactDir, { mode: 0o755, recursive: true });
  await writeFile(
    path.join(config.artifactDir, "check.json"),
    `${JSON.stringify(artifact, null, 2)}\n`,
    { encoding: "utf-8", mode: 0o644 }
  );
};

const main = async (config: EffectE2eConfig): Promise<void> => {
  const seed = await readSeed(config);
  checkState.seed = seed;
  const auth = await readAuth(process.env, config);
  checkState.auth = auth;
  if (
    auth.operator.subjectId !== seed.auth.operator.subjectId ||
    auth.recruiter.subjectId !== seed.auth.recruiter.subjectId
  ) {
    throw new Error("Private auth identity does not match seed.json.");
  }
  const ready = await assertReady(config);
  const releaseSha = await assertVersion(config);
  const browser = await runBrowserFlow(config, auth, seed);
  if (browser.browserErrors.length > 0) {
    throw new Error("Browser flow observed bounded runtime errors.");
  }
  if (Object.values(browser.browser).some((observed) => !observed)) {
    throw new Error("Browser flow did not complete every evidence assertion.");
  }
  const artifact: EffectE2eCheckArtifact = {
    auth: seed.auth,
    browser: browser.browser,
    canary: {
      digest: seed.canary.digest,
      id: seed.canary.id,
      query: seed.canary.query,
    },
    cleanup: { database: "disposable", seedRead: true },
    evidence: {
      browserErrors: browser.browserErrors,
      checkPath: path.join(config.artifactDir, "check.json"),
      forbiddenVisibleText: false,
      frames: browser.video.frames,
      mp4Path: browser.video.mp4Path,
      readyz: ready,
      releaseSha,
      videoInspectionRequired: true,
    },
    schemaVersion: EFFECT_E2E_SCHEMA_VERSION,
    seedRows: seed.rows,
    status: "passed",
  };
  await writeCheckArtifact(config, artifact);
  process.stdout.write(`${JSON.stringify(artifact)}\n`);
};

const writeFailureArtifact = async (
  config: EffectE2eConfig,
  error: Error
): Promise<void> => {
  const { auth, seed } = checkState;
  const artifact: EffectE2eFailureArtifact = {
    auth: auth
      ? {
          operator: {
            role: auth.operator.role,
            subjectId: auth.operator.subjectId,
          },
          recruiter: {
            role: auth.recruiter.role,
            subjectId: auth.recruiter.subjectId,
          },
        }
      : {
          operator: { role: "operator", subjectId: "unavailable" },
          recruiter: { role: "recruiter", subjectId: "unavailable" },
        },
    browser: checkState.browser,
    canary: {
      digest: seed?.canary.digest ?? config.canaryDigest,
      id: seed?.canary.id ?? config.canaryId,
      query: seed?.canary.query ?? canaryQuery(config.canaryId),
    },
    cleanup: { database: "disposable", seedRead: seed !== undefined },
    evidence: {
      browserErrors: checkState.browserErrors,
      checkPath: path.join(config.artifactDir, "check.json"),
      failure: safeError(error),
    },
    schemaVersion: EFFECT_E2E_SCHEMA_VERSION,
    seedRows: seed?.rows ?? { booleanJobs: 0, bronnen: 0 },
    status: "failed",
  };
  await writeCheckArtifact(config, artifact);
};

let activeConfig: EffectE2eConfig | undefined;
try {
  activeConfig = readEffectE2eConfig();
  await main(activeConfig);
} catch (error) {
  const normalizedError =
    error instanceof Error ? error : new Error("Effect E2E check failed.");
  if (activeConfig) {
    await writeFailureArtifact(activeConfig, normalizedError);
  }
  process.stderr.write(`${safeError(normalizedError)}\n`);
  process.exitCode = 1;
}
