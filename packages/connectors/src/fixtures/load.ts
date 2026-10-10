import { readFile } from "node:fs/promises";
import path from "node:path";

import { CONNECTOR_FIXTURE_CONTRACT_VERSION } from "../contract";
import type { ConnectorFixture } from "../contract";
import type { RawContentType } from "../object-store";

const workspaceRoot = path.resolve(import.meta.dirname, "../../../..");

export const fixturePath = (...segments: string[]): string =>
  path.join(workspaceRoot, "fixtures", "connectors", ...segments);

export const loadConnectorFixture = async <Payload>(
  relativePath: string
): Promise<ConnectorFixture & { payload: Payload }> => {
  const raw = await readFile(fixturePath(relativePath), "utf-8");
  // SAFETY: Fixture files are repo-owned envelopes validated against contractVersion.
  const parsed = JSON.parse(raw) as ConnectorFixture;
  if (parsed.contractVersion !== CONNECTOR_FIXTURE_CONTRACT_VERSION) {
    throw new Error(
      `Unsupported fixture contract version: ${parsed.contractVersion}`
    );
  }
  // SAFETY: Callers supply Payload generic for the fixture's source-specific body.
  return parsed as ConnectorFixture & { payload: Payload };
};

export const createFixtureEnvelope = (
  source: string,
  contentType: RawContentType,
  payload: ConnectorFixture["payload"],
  capturedAt = "2026-08-28T10:00:00.000Z"
): ConnectorFixture => ({
  capturedAt,
  contentType,
  contractVersion: CONNECTOR_FIXTURE_CONTRACT_VERSION,
  payload,
  source,
});
