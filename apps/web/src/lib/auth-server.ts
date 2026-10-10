import { getInternalServerUrl } from "@ji/env/web";
import { createAuthClient } from "better-auth/client";

import { stripTrailingSlash } from "./server-url";

type ServerAuthClient = ReturnType<typeof createAuthClient>;

let cachedClient: ServerAuthClient | null = null;

/**
 * Better Auth client for Server Components and route handlers. It runs inside
 * the web container, where the browser-facing NEXT_PUBLIC_SERVER_URL is not
 * necessarily reachable (in Compose it is http://localhost:3000, i.e. the web
 * container itself), so it targets INTERNAL_SERVER_URL instead. Browser code
 * keeps using `authClient` from ./auth-client.
 *
 * Created lazily so importing this module never evaluates server-only env at
 * module load — and so an accidental client-side import fails at the call
 * site (t3-env throws) rather than at bundle time.
 */
export const getServerAuthClient = (): ServerAuthClient => {
  if (cachedClient) {
    return cachedClient;
  }
  cachedClient = createAuthClient({
    // Same rule as the browser client: the path must equal the server-side
    // mount (/api/auth) because better-auth derives its route base from it.
    baseURL: new URL(
      "/api/auth",
      stripTrailingSlash(getInternalServerUrl())
    ).toString(),
  });
  return cachedClient;
};
