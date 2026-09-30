import { describe, expect, it } from "bun:test";

import {
  isKnownNeonPoolerHostname,
  parseProjectorDatabaseUrl,
  PROJECTOR_DATABASE_URL_DIRECT_MESSAGE,
} from "./projector-database-url";

describe("projector database URL", () => {
  it("accepts a direct Neon endpoint", () => {
    const directUrl =
      "postgresql://ji_app:secret@ep-example-host.eu-central-1.aws.neon.tech/catapulze?sslmode=require";

    expect(parseProjectorDatabaseUrl(directUrl)).toBe(directUrl);
  });

  it("accepts a direct local Postgres endpoint for development", () => {
    expect(
      parseProjectorDatabaseUrl(
        "postgresql://ji_app:secret@postgres:5432/ji_test"
      )
    ).toBe("postgresql://ji_app:secret@postgres:5432/ji_test");
  });

  it("rejects the current Neon -pooler hostname form", () => {
    expect(() =>
      parseProjectorDatabaseUrl(
        "postgresql://ji_app:secret@ep-example-host-pooler.eu-central-1.aws.neon.tech/catapulze?sslmode=require"
      )
    ).toThrow(PROJECTOR_DATABASE_URL_DIRECT_MESSAGE);
  });

  it("rejects the legacy Neon pooler label form", () => {
    expect(() =>
      parseProjectorDatabaseUrl(
        "postgresql://ji_app:secret@ep-example-host.pooler.eu-central-1.aws.neon.tech/catapulze?sslmode=require"
      )
    ).toThrow(PROJECTOR_DATABASE_URL_DIRECT_MESSAGE);
  });

  it("does not classify unrelated hosts by a partial pooler name", () => {
    expect(isKnownNeonPoolerHostname("pooler.internal.example.com")).toBe(
      false
    );
  });

  it("rejects non-Postgres URLs", () => {
    expect(() =>
      parseProjectorDatabaseUrl(
        "https://ep-example-host.eu.neon.tech/catapulze"
      )
    ).toThrow("postgres:// or postgresql://");
  });

  it("never echoes credentials in rejection messages", () => {
    const password = "super-secret-projector-password-xyzzy";
    try {
      parseProjectorDatabaseUrl(
        `postgresql://ji_app:${password}@ep-example-host-pooler.eu-central-1.aws.neon.tech/catapulze`
      );
      throw new Error("expected throw");
    } catch (error) {
      const text = error instanceof Error ? error.message : String(error);
      expect(text).toBe(PROJECTOR_DATABASE_URL_DIRECT_MESSAGE);
      expect(text).not.toContain(password);
      expect(text).not.toContain("ji_app");
    }
  });
});
