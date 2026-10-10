import { describe, expect, it } from "bun:test";

import {
  canAccessBronnen,
  parseBronnenWindow,
  sessionRoleSchema,
  toDashboardApiWindow,
} from "./bronnen-window";

describe("bronnen window helpers", () => {
  it("parses supported windows and defaults to 7d", () => {
    expect(parseBronnenWindow("24h")).toBe("24h");
    expect(parseBronnenWindow("7d")).toBe("7d");
    expect(parseBronnenWindow("30d")).toBe("30d");
    expect(parseBronnenWindow("1y")).toBe("7d");
    expect(parseBronnenWindow()).toBe("7d");
    expect(parseBronnenWindow(["30d", "7d"])).toBe("30d");
  });

  it("maps 24h to the API 24u alias", () => {
    expect(toDashboardApiWindow("24h")).toBe("24u");
    expect(toDashboardApiWindow("7d")).toBe("7d");
  });

  it("allows only operator and admin roles", () => {
    expect(canAccessBronnen("operator")).toBe(true);
    expect(canAccessBronnen("admin")).toBe(true);
    expect(canAccessBronnen("recruiter")).toBe(false);
    expect(canAccessBronnen(null)).toBe(false);
  });

  it("parses role from a session payload at the I/O boundary", () => {
    expect(
      sessionRoleSchema.parse({ user: { role: "operator" } }).user.role
    ).toBe("operator");
    expect(
      sessionRoleSchema.safeParse({ user: { role: "hacker" } }).success
    ).toBe(false);
  });
});
