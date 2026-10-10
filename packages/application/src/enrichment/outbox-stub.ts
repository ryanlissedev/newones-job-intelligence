export {
  enqueueEnrichmentOutboxStub,
  type EnrichmentOutboxStubResult,
} from "./outbox";

export interface EnrichmentOutboxStubInput {
  readonly aanvraagId: string;
  readonly dryRun: boolean;
  readonly fieldCount: number;
}
