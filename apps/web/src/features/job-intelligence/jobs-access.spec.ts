import { describe, expect, it } from "bun:test";

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { JobsAccessFrame, resolveJobsAccess } from "./jobs-access";

const base = {
  fixtures: false,
  isPending: false,
  mounted: true,
  userId: undefined,
} as const;

describe("resolveJobsAccess", () => {
  it("never decides before the client has mounted (server render and hydration)", () => {
    expect(resolveJobsAccess({ ...base, mounted: false })).toBe("checking");
    expect(
      resolveJobsAccess({ ...base, mounted: false, userId: "user-1" })
    ).toBe("checking");
  });

  it("stays checking while the session request is in flight, even with a cached user", () => {
    expect(resolveJobsAccess({ ...base, isPending: true })).toBe("checking");
    expect(
      resolveJobsAccess({ ...base, isPending: true, userId: "user-1" })
    ).toBe("checking");
  });

  it("is anonymous once the session is known to be absent", () => {
    expect(resolveJobsAccess(base)).toBe("anonymous");
    expect(resolveJobsAccess({ ...base, userId: "" })).toBe("anonymous");
  });

  it("is authenticated only with a resolved user id", () => {
    expect(resolveJobsAccess({ ...base, userId: "user-1" })).toBe(
      "authenticated"
    );
  });

  it("fixture mode needs no session", () => {
    expect(
      resolveJobsAccess({ ...base, fixtures: true, isPending: true })
    ).toBe("fixtures");
  });
});

describe("/jobs server markup before the session is known", () => {
  const pending = renderToStaticMarkup(
    createElement(JobsAccessFrame, { access: "checking" })
  );

  it("paints the page heading and a busy skeleton", () => {
    expect(pending).toContain('id="main-content"');
    expect(pending).toMatch(/<h1[^>]*>Opdrachten<\/h1>/u);
    expect(pending).toContain('aria-busy="true"');
  });

  it("shows neither results nor a sign-in verdict", () => {
    expect(pending).not.toContain("Inloggen");
    expect(pending).not.toContain("Log in om opdrachten te bekijken");
    expect(pending).not.toContain("Zoekresultaten");
  });
});

describe("/jobs for an anonymous visitor", () => {
  const prompt = renderToStaticMarkup(
    createElement(JobsAccessFrame, { access: "anonymous" })
  );

  it("keeps the same heading and asks to sign in", () => {
    expect(prompt).toMatch(/<h1[^>]*>Opdrachten<\/h1>/u);
    expect(prompt).toMatch(/<h2[^>]*>Log in om opdrachten te bekijken<\/h2>/u);
    expect(prompt).toContain('href="/login"');
    expect(prompt).toContain("Inloggen");
  });
});
