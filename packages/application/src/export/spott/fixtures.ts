import { readFile } from "node:fs/promises";
import path from "node:path";

export const SPOTT_FIXTURE_CONTRACT_VERSION = "spott-fixture/v1";

export interface SpottFixtureEnvelope<TPayload = unknown> {
  capturedAt: string;
  contractVersion: typeof SPOTT_FIXTURE_CONTRACT_VERSION;
  endpoint: string;
  payload: TPayload;
  source: "spott";
}

const workspaceRoot = path.resolve(import.meta.dirname, "../../../../..");

export const spottFixturePath = (...segments: string[]): string =>
  path.join(workspaceRoot, "fixtures", "export", "spott", ...segments);

export const loadSpottFixture = async <Payload>(
  relativePath: string
): Promise<SpottFixtureEnvelope<Payload>> => {
  const raw = await readFile(spottFixturePath(relativePath), "utf-8");
  // SAFETY: Fixture files are repo-owned envelopes validated against contractVersion.
  const parsed = JSON.parse(raw) as SpottFixtureEnvelope<Payload>;
  if (parsed.contractVersion !== SPOTT_FIXTURE_CONTRACT_VERSION) {
    throw new Error(
      `Unsupported Spott fixture contract at ${relativePath}: expected ${SPOTT_FIXTURE_CONTRACT_VERSION}`
    );
  }
  return parsed;
};
