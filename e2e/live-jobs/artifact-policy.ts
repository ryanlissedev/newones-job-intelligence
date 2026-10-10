import type { LiveJobsEnvironment } from "./config";

export interface LiveJobsArtifactPolicy {
  readonly screenshot: "off";
  readonly trace: "off";
  readonly video: "off";
}

/**
 * No run retains a Playwright trace or automatic screenshot: network bodies
 * and browser storage can otherwise leak through attachments, including in an
 * isolated local environment.
 */
export const readLiveJobsArtifactPolicy = (
  _environment: LiveJobsEnvironment = process.env
): LiveJobsArtifactPolicy => ({
  screenshot: "off",
  trace: "off",
  video: "off",
});
