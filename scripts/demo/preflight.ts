import { z } from "zod";

const SHA_PATTERN = /^[a-f0-9]{40}$/u;

const versionSchema = z
  .object({
    releaseSha: z.string().regex(SHA_PATTERN),
  })
  .strict();

const searchProjectionSchema = z.object({
  lagEvents: z.coerce.number().int().nonnegative(),
  status: z.string(),
});

const readyzSchema = z.object({
  components: z
    .object({
      searchProjection: searchProjectionSchema.optional(),
    })
    .passthrough(),
  status: z.literal("ready"),
});

export interface DemoPreflightTargets {
  readonly apiUrl: string;
  readonly appUrl: string;
}

export interface DemoPreflightResult {
  readonly apiUrl: string;
  readonly appUrl: string;
  readonly lagEvents: number;
  readonly releaseSha: string;
}

export interface DemoPreflightDependencies {
  readonly fetcher?: (input: string, init?: RequestInit) => Promise<Response>;
}

const requireDemoEnv = (
  environment: Readonly<Record<string, string | undefined>>,
  name: "JI_DEMO_API_URL" | "JI_DEMO_APP_URL"
): string => {
  const value = environment[name]?.trim();
  if (!value) {
    throw new Error(
      `${name} is required (point it at the demo environment origin).`
    );
  }
  return value.replace(/\/$/u, "");
};

export const resolveDemoTargets = (
  environment: Readonly<Record<string, string | undefined>> = process.env
): DemoPreflightTargets => ({
  apiUrl: requireDemoEnv(environment, "JI_DEMO_API_URL"),
  appUrl: requireDemoEnv(environment, "JI_DEMO_APP_URL"),
});

/**
 * Live demo recording is allowed only when /version returns a 40-char tip SHA
 * and /readyz reports ready with searchProjection lagEvents === 0.
 */
export const runDemoPreflight = async (
  targets: DemoPreflightTargets,
  dependencies: DemoPreflightDependencies = {}
): Promise<DemoPreflightResult> => {
  const fetcher = dependencies.fetcher ?? fetch;
  const versionUrl = `${targets.apiUrl}/version`;
  const readyzUrl = `${targets.apiUrl}/readyz`;

  const versionResponse = await fetcher(versionUrl, {
    cache: "no-store",
    headers: { Accept: "application/json" },
    method: "GET",
    redirect: "error",
  });
  if (versionResponse.status !== 200) {
    throw new Error(`GET /version returned ${versionResponse.status}.`);
  }
  const versionParsed = versionSchema.safeParse(await versionResponse.json());
  if (!versionParsed.success) {
    throw new Error("GET /version body is not a strict releaseSha payload.");
  }

  const readyzResponse = await fetcher(readyzUrl, {
    cache: "no-store",
    headers: { Accept: "application/json" },
    method: "GET",
    redirect: "error",
  });
  if (readyzResponse.status !== 200) {
    throw new Error(`GET /readyz returned ${readyzResponse.status}.`);
  }
  const readyzParsed = readyzSchema.safeParse(await readyzResponse.json());
  if (!readyzParsed.success) {
    throw new Error("GET /readyz body is not ready.");
  }
  const projection = readyzParsed.data.components.searchProjection;
  if (!projection || projection.status !== "ok") {
    throw new Error("searchProjection is not ok.");
  }
  if (projection.lagEvents !== 0) {
    throw new Error(
      `searchProjection.lagEvents is ${projection.lagEvents}, expected 0.`
    );
  }

  const appResponse = await fetcher(targets.appUrl, {
    cache: "no-store",
    method: "GET",
    redirect: "follow",
  });
  if (appResponse.status !== 200) {
    throw new Error(`GET app home returned ${appResponse.status}.`);
  }

  return {
    apiUrl: targets.apiUrl,
    appUrl: targets.appUrl,
    lagEvents: projection.lagEvents,
    releaseSha: versionParsed.data.releaseSha,
  };
};

const isMain = import.meta.main;

if (isMain) {
  const result = await runDemoPreflight(resolveDemoTargets());
  console.log(
    JSON.stringify(
      {
        appUrl: result.appUrl,
        lagEvents: result.lagEvents,
        ok: true,
        releaseSha: result.releaseSha,
      },
      null,
      2
    )
  );
}
