import { cors } from "hono/cors";

/**
 * How long a browser may reuse a CORS preflight answer, in seconds. Without
 * it Chromium re-sends `OPTIONS` after 5 s, so every search and batch POST on
 * /jobs paid an extra round trip before the real request (audit 2026-10-08).
 * Ten minutes covers a working session's burst of searches while keeping a
 * changed policy (a new allowed header) live within minutes. Chromium caps
 * the value at 7200 and Firefox at 86400, so it is honoured as written.
 */
export const CORS_PREFLIGHT_MAX_AGE_SECONDS = 600;

/** The API's CORS policy: one web origin, cookies allowed, cached preflights. */
export const apiCors = (allowedWebOrigin: string) =>
  cors({
    allowHeaders: [
      "Content-Type",
      "Authorization",
      "MCP-Protocol-Version",
      "Mcp-Method",
      "Mcp-Name",
    ],
    allowMethods: ["DELETE", "GET", "POST", "PUT", "OPTIONS"],
    credentials: true,
    maxAge: CORS_PREFLIGHT_MAX_AGE_SECONDS,
    origin: allowedWebOrigin,
  });
