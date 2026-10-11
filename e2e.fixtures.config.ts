import { web } from "@e2e-dev/web";
import type { E2EConfig } from "e2e";

/**
 * Deterministic local e2e target: a production Next build in fixture mode,
 * plus the tiny auth stub used by server-rendered authenticated routes.
 * e2e-dev/web 0.11.2 does not expose locale/timezone engine options, so the
 * app process supplies Europe/Amsterdam and nl-NL is explicit in the UI.
 */
const authPort = process.env.E2E_FIXTURES_AUTH_PORT ?? "3310";

export default {
  credentials: {
    fixture: {
      password: () => process.env.E2E_USER_FIXTURE_PASSWORD ?? "",
      username: "e2e.tester@example.test",
    },
  },
  targets: [
    {
      app: {
        command: {
          args: ["tests/fixtures/support/serve.ts"],
          env: {
            E2E_FIXTURES_AUTH_PORT: authPort,
            E2E_FIXTURES_STUB_PASSWORD:
              process.env.E2E_USER_FIXTURE_PASSWORD ?? "",
            HOME: process.env.HOME ?? "",
            PATH: process.env.PATH ?? "",
            PORT: "{port}",
          },
          executable: "bun",
          log: ".e2e/logs/fixtures-app.log",
          startupTimeout: 120_000,
        },
        url: "http://127.0.0.1:0",
      },
      engine: web({ viewport: { height: 800, width: 1280 } }),
      name: "fixtures",
    },
  ],
  tests: "tests/fixtures/**/*.e2e.ts",
  trace: "retain-on-failure",
  video: "off",
  workers: 1,
} satisfies E2EConfig;
