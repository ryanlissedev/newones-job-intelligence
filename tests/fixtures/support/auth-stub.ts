/* oxlint-disable anti-slop/no-unknown-parameters, anti-slop/no-runtime-typeof, anti-slop/no-known-value-widening, anti-slop/require-safety-comment-for-type-assertion -- This tiny auth stub owns its JSON I/O boundary and validates only the two credential fields needed by the fixture contract. */
import { timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createServer } from "node:http";

import { z } from "zod";

const SESSION_COOKIE = "better-auth.session_token";
const FIXTURE_EMAIL = "e2e.tester@example.test";
const FIXTURE_USER = {
  createdAt: "2026-09-01T07:00:00.000Z",
  email: FIXTURE_EMAIL,
  emailVerified: true,
  id: "e2e-user",
  image: null,
  name: "E2E Tester",
  updatedAt: "2026-09-01T07:00:00.000Z",
} as const;
const SESSION = {
  createdAt: "2026-09-01T07:00:00.000Z",
  expiresAt: "2999-01-01T00:00:00.000Z",
  id: "e2e-session",
  ipAddress: null,
  token: "e2e-valid.fixture",
  updatedAt: "2026-09-01T07:00:00.000Z",
  userAgent: null,
  userId: FIXTURE_USER.id,
} as const;

type AuthJsonValue =
  | boolean
  | number
  | string
  | null
  | readonly AuthJsonValue[]
  | { readonly [key: string]: AuthJsonValue };

const signInBodySchema = z.object({
  email: z.string().optional(),
  password: z.string().optional(),
});

const json = (
  response: ServerResponse,
  status: number,
  body: AuthJsonValue
): void => {
  response.writeHead(status, {
    "access-control-allow-credentials": "true",
    "content-type": "application/json",
  });
  response.end(JSON.stringify(body));
};

const cookieValue = (request: IncomingMessage): string | null => {
  const cookieHeader = request.headers.cookie ?? "";
  const cookie = cookieHeader
    .split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${SESSION_COOKIE}=`));
  return cookie?.slice(SESSION_COOKIE.length + 1) ?? null;
};

const readBody = async (request: IncomingMessage): Promise<string> => {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf-8");
};

const readSignInBody = async (
  request: IncomingMessage
): Promise<z.infer<typeof signInBodySchema>> => {
  try {
    const parsed: unknown = JSON.parse(await readBody(request));
    return signInBodySchema.parse(parsed);
  } catch {
    return {};
  }
};

const matchesSecret = (candidate: string, secret: string): boolean => {
  if (secret === "" || candidate.length !== secret.length) {
    return false;
  }
  return timingSafeEqual(Buffer.from(candidate), Buffer.from(secret));
};

const sessionResponse = (token: string) => ({
  session: { ...SESSION, token },
  user: FIXTURE_USER,
});

export const createAuthStub = (port: number) => {
  const server = createServer(async (request, response) => {
    const { origin } = request.headers;
    if (origin) {
      response.setHeader("access-control-allow-origin", origin);
      response.setHeader("vary", "Origin");
    }
    if (request.method === "OPTIONS") {
      response.writeHead(204, {
        "access-control-allow-credentials": "true",
        "access-control-allow-headers": "content-type",
        "access-control-allow-methods": "GET,POST,OPTIONS",
      });
      response.end();
      return;
    }

    const url = new URL(request.url ?? "/", `http://127.0.0.1:${port}`);
    if (request.method === "GET" && url.pathname === "/api/auth/get-session") {
      const token = cookieValue(request);
      json(
        response,
        200,
        token?.startsWith("e2e-valid") ? sessionResponse(token) : null
      );
      return;
    }

    if (
      request.method === "POST" &&
      url.pathname === "/api/auth/sign-in/email"
    ) {
      const body = await readSignInBody(request);
      const valid =
        body.email === FIXTURE_EMAIL &&
        typeof body.password === "string" &&
        matchesSecret(
          body.password,
          process.env.E2E_FIXTURES_STUB_PASSWORD ?? ""
        );
      if (!valid) {
        json(response, 401, {
          code: "INVALID_EMAIL_OR_PASSWORD",
          message: "Invalid email or password",
        });
        return;
      }
      const token = `e2e-valid.${crypto.randomUUID()}`;
      response.setHeader(
        "set-cookie",
        `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax`
      );
      json(response, 200, { redirect: false, token, user: FIXTURE_USER });
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/auth/sign-out") {
      response.setHeader(
        "set-cookie",
        `${SESSION_COOKIE}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax`
      );
      json(response, 200, { success: true });
      return;
    }

    json(response, 503, {
      error: "fixture auth stub: endpoint not implemented",
    });
  });
  // Loopback only: the local Chromium and Next SSR both call it on
  // 127.0.0.1 (see support/test.ts).
  server.listen(port, "127.0.0.1");
  return server;
};
