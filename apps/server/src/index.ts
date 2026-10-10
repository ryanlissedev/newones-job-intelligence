import { trpcServer } from "@hono/trpc-server";
import { createContext } from "@ji/api/context";
import { appRouter } from "@ji/api/routers/index";
import { auth } from "@ji/auth";
import {
  closeDb,
  getDbReadiness,
  PostgresSearchProjectorRuntimeStore,
} from "@ji/db";
import { env } from "@ji/env/server";
import { Hono } from "hono";
import { logger } from "hono/logger";

import { createSessionPrincipalResolver } from "./capabilities/auth";
import { PRODUCTION_UNAVAILABLE_CAPABILITIES } from "./capabilities/capability-availability";
import { createCapabilityDiscoveryHandler } from "./capabilities/discovery";
import { createMcpHandler } from "./capabilities/mcp";
import {
  createRestCapabilityHandler,
  restRoutesFromRegistry,
} from "./capabilities/rest";
import { apiCors } from "./cors-policy";
import { createHealthRoutes } from "./http/health";
import { createProjectorRuntimeHandler } from "./http/projector-runtime";
import { createReleaseHandler } from "./http/release";
import { createMarktvragenChatHandler } from "./marktvragen/chat";
import { getMarktvragenModel } from "./marktvragen/model";
import { createTurnRateLimiter } from "./marktvragen/rate-limit";
import { createReadinessDeps, createReadinessHandler } from "./readiness";
import { jsonBodyLimit } from "./request-body-limit";
import { createProductionSliceARegistry } from "./slice-a-registry";

const SHUTDOWN_DRAIN_TIMEOUT_MS = 10_000;

const app = new Hono();
const allowedWebOrigin = new URL(env.CORS_ORIGIN).origin;

app.use(logger());
app.use("/*", apiCors(allowedWebOrigin));
app.use("/v1/*", jsonBodyLimit());
app.use("/mcp", jsonBodyLimit());
app.use("/marktvragen/*", jsonBodyLimit());

app.on(["POST", "GET"], "/api/auth/*", (c) => auth.handler(c.req.raw));

app.use(
  "/trpc/*",
  trpcServer({
    createContext: (_opts, context) => createContext({ context }),
    router: appRouter,
  })
);

app.get("/", (c) => c.text("OK"));
app.get("/version", createReleaseHandler(env.APP_RELEASE_SHA));

const sliceA = await createProductionSliceARegistry({
  databaseUrl: env.DATABASE_URL,
  manticoreUrl: env.MANTICORE_URL,
  nodeEnv: env.NODE_ENV,
  rawObjectStorePath: env.RAW_OBJECT_STORE_PATH,
  rawS3AccessKeyId: env.RAW_S3_ACCESS_KEY_ID,
  rawS3Bucket: env.RAW_S3_BUCKET,
  rawS3Endpoint: env.RAW_S3_ENDPOINT,
  rawS3Region: env.RAW_S3_REGION,
  rawS3SecretAccessKey: env.RAW_S3_SECRET_ACCESS_KEY,
  redisUrl: env.REDIS_URL,
});

// Component-wise readiness (RJC-391): postgres/manticore/rawObjectStore/
// redis/searchProjection, each checked independently — see readiness.ts.
// `/livez` (createHealthRoutes' `live`) stays process-only, unaffected.
const readinessHandler = createReadinessHandler(
  createReadinessDeps({
    checkDbReadiness: getDbReadiness,
    database: sliceA.deps.database,
    manticoreUrl: sliceA.deps.manticoreUrl,
    nodeEnv: env.NODE_ENV,
    objectStore: sliceA.deps.objectStore,
    rawObjectStoreKind: sliceA.deps.rawObjectStoreKind,
    redisUrl: env.REDIS_URL,
  })
);
const healthRoutes = createHealthRoutes(readinessHandler);

app.get("/health", healthRoutes.health);
app.get("/livez", healthRoutes.live);
app.get("/readyz", healthRoutes.ready);

// Deploy readback for the on-box projector, which has no HTTP surface of
// its own. One store for the process, not one per request.
const projectorRuntimeStore = new PostgresSearchProjectorRuntimeStore(
  sliceA.deps.database
);
app.get(
  "/projector/runtime",
  createProjectorRuntimeHandler({ read: () => projectorRuntimeStore.read() })
);

const restRoutes = restRoutesFromRegistry(sliceA.registry);
const resolvePrincipal = createSessionPrincipalResolver(
  (headers) =>
    auth.api.getSession({
      headers,
      query: { disableCookieCache: true },
    }),
  () => new Date(),
  (event) => {
    process.stderr.write(
      `${JSON.stringify({ event: "auth_session_lookup_failed", ...event })}\n`
    );
  }
);
const restHandler = createRestCapabilityHandler(
  sliceA.registry,
  restRoutes,
  resolvePrincipal,
  {
    allowedCookieOrigin: allowedWebOrigin,
    unavailableCapabilities: PRODUCTION_UNAVAILABLE_CAPABILITIES,
  }
);
const capabilityDiscoveryHandler = createCapabilityDiscoveryHandler(
  sliceA.registry,
  sliceA.entries,
  resolvePrincipal,
  PRODUCTION_UNAVAILABLE_CAPABILITIES
);
const mcpHandler = createMcpHandler(sliceA.registry, resolvePrincipal, {
  allowedCookieOrigin: allowedWebOrigin,
  allowedHost: new URL(env.BETTER_AUTH_URL).hostname,
  entries: sliceA.entries,
  recordMetric: (metric) => {
    process.stderr.write(`${JSON.stringify(metric)}\n`);
  },
  unavailableCapabilities: PRODUCTION_UNAVAILABLE_CAPABILITIES,
});

// On-box Marktvragen chat: streamText over the same registry + principal
// resolver the REST/MCP surfaces use. Replaces the Trigger.dev chat.agent
// task — no cloud runs, per-user turn budget via the in-memory limiter.
app.post(
  "/marktvragen/chat",
  createMarktvragenChatHandler({
    model: getMarktvragenModel,
    rateLimiter: createTurnRateLimiter({
      maxPerWindow: env.MARKTVRAGEN_MAX_TURNS_PER_HOUR ?? 30,
    }),
    registry: sliceA.registry,
    resolvePrincipal,
  })
);

app.get("/v1/capabilities", capabilityDiscoveryHandler);
app.all("/v1/*", (context) => restHandler(context));
app.post("/mcp", (context) => mcpHandler(context));

const server = Bun.serve({
  fetch: app.fetch,
  port: env.PORT,
});

let shutdownPromise: Promise<void> | undefined;

const shutdown = async (): Promise<void> => {
  let drainTimedOut = false;

  const markDrainTimeout = async (): Promise<void> => {
    await Bun.sleep(SHUTDOWN_DRAIN_TIMEOUT_MS);
    drainTimedOut = true;
  };

  await Promise.race([server.stop(false), markDrainTimeout()]);

  if (drainTimedOut) {
    await server.stop(true);
  }

  await Promise.all([sliceA.deps.close(), closeDb()]);
  process.exit(drainTimedOut ? 1 : 0);
};

const handleShutdown = (): void => {
  shutdownPromise ??= shutdown();
};

process.once("SIGINT", handleShutdown);
process.once("SIGTERM", handleShutdown);
