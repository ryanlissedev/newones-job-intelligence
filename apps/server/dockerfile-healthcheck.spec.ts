import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";

/**
 * Coolify rolls back when Docker HEALTHCHECK fails. /readyz can 503 while the
 * process is up (deps/migration/projection), which took Traefik offline after
 * tip aca8478. Image HEALTHCHECK must stay on /livez; /readyz remains the app
 * readiness contract outside Docker HEALTHCHECK.
 */
describe("apps/server/Dockerfile HEALTHCHECK", () => {
  const dockerfile = readFileSync(
    path.join(import.meta.dir, "Dockerfile"),
    "utf-8"
  );

  test("probes /livez, not /readyz", () => {
    expect(dockerfile).toContain("HEALTHCHECK");
    expect(dockerfile).toContain("localhost:3000/livez");
    expect(dockerfile).not.toContain("localhost:3000/readyz");
  });
});
