import type { Context } from "hono";

export const HEALTH_BODY = "OK" as const;

export const createLivenessHandler =
  () =>
  (context: Context): Response =>
    context.text(HEALTH_BODY);

export const createHealthRoutes = (
  readinessHandler: (context: Context) => Promise<Response>
) => ({
  health: createLivenessHandler(),
  live: createLivenessHandler(),
  ready: readinessHandler,
});
