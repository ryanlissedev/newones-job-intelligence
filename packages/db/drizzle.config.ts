import dotenv from "dotenv";
import { defineConfig } from "drizzle-kit";

import { requireMigrationDatabaseUrl } from "./src/migration-database-url";

dotenv.config({
  path: "../../apps/server/.env",
});

export default defineConfig({
  dbCredentials: {
    url: requireMigrationDatabaseUrl(),
  },
  dialect: "postgresql",
  out: "./src/migrations",
  schema: [
    "./src/schema/auth.ts",
    "./src/schema/curated.ts",
    "./src/schema/staging.ts",
    "./src/schema/schemas.ts",
  ],
});
