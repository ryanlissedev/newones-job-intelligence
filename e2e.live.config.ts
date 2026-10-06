import { web } from "@e2e-dev/web";
import type { E2EConfig } from "e2e";

/**
 * Read-only smoke flows against a deployed web origin. The origin comes from
 * `E2E_LIVE_WEB_URL` and never from git: the secret scan blocks production
 * hostnames in the repo. Every flow here is anonymous and only reads pages.
 */
const liveWebUrl = process.env.E2E_LIVE_WEB_URL;
if (liveWebUrl === undefined || liveWebUrl === "") {
  throw new Error(
    "E2E_LIVE_WEB_URL must name the deployed web origin, e.g. the PRODUCTION_WEB_URL environment variable"
  );
}

export default {
  targets: [
    {
      app: { url: liveWebUrl },
      engine: web(),
      name: "live",
    },
  ],
  tests: "tests/live/**/*.e2e.ts",
  video: "on",
} satisfies E2EConfig;
