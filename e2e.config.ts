import { web } from "@e2e-dev/web";
import type { E2EConfig } from "e2e";

export default {
  targets: [
    {
      app: {
        command: {
          args: ["run", "dev:web"],
          env: {
            NEXT_PUBLIC_SERVER_URL: "http://127.0.0.1:3000",
          },
          executable: "bun",
          log: ".e2e/logs/app.log",
          startupTimeout: 120_000,
        },
        url: "http://localhost:3001",
      },
      engine: web(),
      name: "chromium",
    },
  ],
  tests: "tests/**/*.e2e.ts",
} satisfies E2EConfig;
