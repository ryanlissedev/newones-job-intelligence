// Browser noise predicates for the Effect E2E lane. Kept pure so the
// suppression policy is unit-testable without launching Chromium.

export const DENIED_RESOURCE_PREFIX =
  "Failed to load resource: the server responded with a status of 403";

// The flow deliberately asserts two denials (recruiter dashboard API 403 via
// a direct status check, recruiter /bronnen via redirect URL). Chromium's
// generic resource-load console error for those responses carries no URL and
// adds no signal on top of the hard assertions, so it is ignored only while
// the denial phase is active — a 403 console error anywhere else still lands
// in browserErrors.
export const isExpectedDenialConsoleError = (
  messageType: string,
  messageText: string,
  denialPhaseActive: boolean
): boolean =>
  denialPhaseActive &&
  messageType === "error" &&
  messageText.startsWith(DENIED_RESOURCE_PREFIX);

export interface RequestFailureFacts {
  readonly errorText: string;
  readonly isNavigation: boolean;
  readonly resourceType: string;
  readonly url: string;
}

// ERR_ABORTED is client-side cancellation: Chromium aborts in-flight
// document, prefetch and Next.js RSC-prefetch requests whenever a newer
// navigation or context teardown supersedes them. Only those superseded
// shapes are ignored — an aborted XHR/fetch or asset request still reports,
// so a regression that cancels a real request cannot pass silently.
export const isSupersededAbort = (facts: RequestFailureFacts): boolean => {
  if (facts.errorText !== "net::ERR_ABORTED") {
    return false;
  }
  if (facts.isNavigation || facts.resourceType === "other") {
    return true;
  }
  try {
    return new URL(facts.url).searchParams.has("_rsc");
  } catch {
    return false;
  }
};
