import { describe, expect, it } from "bun:test";

import {
  HttpUrlString,
  NonEmptyString,
  onEnvValidationError,
  toEnvSchema,
  UrlString,
} from "./schema-helpers";

describe("@ji/env schema helpers", () => {
  it("keeps URL fields as strings (not URL objects)", () => {
    const schema = toEnvSchema(UrlString);
    const result = schema["~standard"].validate("https://example.com/path");
    expect(result).not.toBeInstanceOf(Promise);
    if (result instanceof Promise || result.issues) {
      throw new Error("expected success");
    }
    expect(result.value).toBe("https://example.com/path");
  });

  it("rejects non-http(s) schemes for HttpUrlString", () => {
    const schema = toEnvSchema(HttpUrlString);
    const result = schema["~standard"].validate("server:3000");
    expect(result).not.toBeInstanceOf(Promise);
    if (result instanceof Promise || !result.issues) {
      throw new Error("expected failure");
    }
    expect(result.issues[0]?.message).toContain("http");
  });

  it("onEnvValidationError never includes issue values from secrets", () => {
    const secret = "do-not-print-this-secret-value";
    expect(() =>
      onEnvValidationError([
        {
          message: "Expected a value with a length of at least 32",
          path: ["BETTER_AUTH_SECRET"],
        },
      ])
    ).toThrow("Invalid environment variables");
    try {
      onEnvValidationError([
        {
          message: "Expected a value with a length of at least 1",
          path: ["DATABASE_URL"],
        },
      ]);
    } catch (error) {
      const text = error instanceof Error ? error.message : String(error);
      expect(text).toContain("DATABASE_URL");
      expect(text).not.toContain(secret);
    }
  });

  it("NonEmptyString rejects empty string without echoing input", () => {
    const schema = toEnvSchema(NonEmptyString);
    const result = schema["~standard"].validate("");
    expect(result).not.toBeInstanceOf(Promise);
    if (result instanceof Promise || !result.issues) {
      throw new Error("expected failure");
    }
    const joined = result.issues.map((issue) => issue.message).join(" ");
    expect(joined).not.toContain("password");
  });
});
