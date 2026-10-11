import { web } from "@e2e-dev/web";
import type { E2EConfig } from "e2e";

/**
 * Read-only smoke flows against a deployed web origin. The origin comes from
 * `E2E_LIVE_WEB_URL` and never from git: the secret scan blocks production
 * hostnames in the repo. The default flows are anonymous, only read pages and
 * assert public chrome (hero, login wall, access denial), never vacancy data,
 * like `e2e:live:jobs:anonymous`. The separate credential flow is skipped
 * unless its explicit session-write opt-in is present. Trace and video are
 * switched off explicitly (e2e traces every local attempt by default):
 * captures of a deployed origin are not PR evidence (AGENTS.md, Visual
 * evidence), which comes from seeded or fixture data.
 */
const liveWebUrl = process.env.E2E_LIVE_WEB_URL;
if (liveWebUrl === undefined || liveWebUrl === "") {
  throw new Error(
    "E2E_LIVE_WEB_URL must name the deployed web origin to smoke-test with anonymous, read-only flows"
  );
}

export default {
  credentials: {
    live: {
      password: () => process.env.E2E_USER_LIVE_PASSWORD ?? "",
      username: process.env.E2E_USER_LIVE_USERNAME ?? "",
    },
  },
  targets: [
    {
      app: { url: liveWebUrl },
      engine: web(),
      name: "live",
    },
  ],
  tests: "tests/live/**/*.e2e.ts",
  trace: "off",
  video: "off",
} satisfies E2EConfig;
