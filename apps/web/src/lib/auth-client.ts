import { env } from "@ji/env/web";
import { createAuthClient } from "better-auth/react";

import { stripTrailingSlash } from "./server-url";

export const authClient = createAuthClient({
  // better-auth derives its route-matching base from this URL's path, so the
  // public auth path must equal the server-side mount (/api/auth everywhere)
  baseURL: new URL(
    "/api/auth",
    stripTrailingSlash(env.NEXT_PUBLIC_SERVER_URL)
  ).toString(),
});
