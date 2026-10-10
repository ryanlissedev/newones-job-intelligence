import { describe, expect, it } from "bun:test";

import {
  DENIED_RESOURCE_PREFIX,
  isExpectedDenialConsoleError,
  isSupersededAbort,
} from "./browser-noise";

const abortFacts = {
  errorText: "net::ERR_ABORTED",
  isNavigation: false,
  resourceType: "document",
  url: "http://localhost:3001/vacatures",
} as const;

describe("isExpectedDenialConsoleError", () => {
  it("suppresses the generic 403 resource error while the denial phase runs", () => {
    expect(
      isExpectedDenialConsoleError("error", DENIED_RESOURCE_PREFIX, true)
    ).toBe(true);
  });

  it("reports a 403 console error outside the denial phase", () => {
    expect(
      isExpectedDenialConsoleError("error", DENIED_RESOURCE_PREFIX, false)
    ).toBe(false);
  });

  it("reports non-error console messages even inside the denial phase", () => {
    expect(
      isExpectedDenialConsoleError("warning", DENIED_RESOURCE_PREFIX, true)
    ).toBe(false);
  });

  it("reports error console messages with other bodies", () => {
    expect(
      isExpectedDenialConsoleError(
        "error",
        "Failed to load resource: the server responded with a status of 500",
        true
      )
    ).toBe(false);
  });
});

describe("isSupersededAbort", () => {
  it("suppresses aborted navigations", () => {
    expect(isSupersededAbort({ ...abortFacts, isNavigation: true })).toBe(true);
  });

  it("suppresses aborted prefetch-class requests", () => {
    expect(isSupersededAbort({ ...abortFacts, resourceType: "other" })).toBe(
      true
    );
  });

  it("suppresses aborted Next.js RSC prefetches", () => {
    expect(
      isSupersededAbort({
        ...abortFacts,
        resourceType: "fetch",
        url: "http://localhost:3001/vacatures?_rsc=abc123",
      })
    ).toBe(true);
  });

  it("reports aborted XHR/fetch calls that are not RSC prefetches", () => {
    expect(
      isSupersededAbort({
        ...abortFacts,
        resourceType: "xhr",
        url: "http://localhost:3000/v1/aanvragen/search",
      })
    ).toBe(false);
    expect(
      isSupersededAbort({
        ...abortFacts,
        resourceType: "fetch",
        url: "http://localhost:3000/v1/aanvragen/search",
      })
    ).toBe(false);
  });

  it("reports aborted asset requests", () => {
    for (const resourceType of ["script", "stylesheet", "image", "font"]) {
      expect(isSupersededAbort({ ...abortFacts, resourceType })).toBe(false);
    }
  });

  it("reports non-abort failures regardless of request shape", () => {
    expect(
      isSupersededAbort({
        ...abortFacts,
        errorText: "net::ERR_CONNECTION_REFUSED",
        isNavigation: true,
      })
    ).toBe(false);
  });

  it("treats an unparseable URL as a non-RSC request", () => {
    expect(
      isSupersededAbort({ ...abortFacts, isNavigation: true, url: "not a url" })
    ).toBe(true);
    expect(
      isSupersededAbort({
        ...abortFacts,
        resourceType: "fetch",
        url: "not a url",
      })
    ).toBe(false);
  });
});
