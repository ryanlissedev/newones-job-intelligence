export const CAPABILITY_UNAVAILABLE_CODE = "CAPABILITY_DISABLED";

export const capabilityAvailabilityStatuses = [
  "implemented",
  "disabled",
  "fixture-stub",
  "planned",
] as const;

export type CapabilityAvailabilityStatus =
  (typeof capabilityAvailabilityStatuses)[number];

export interface CapabilityAvailability {
  readonly reason: string;
  readonly safeNextStep: string;
  readonly status: CapabilityAvailabilityStatus;
}

export type CapabilityAvailabilityPolicy = ReadonlyMap<
  string,
  CapabilityAvailability
>;

export const isCapabilityExecutable = (
  availability: Pick<CapabilityAvailability, "status">
): boolean => availability.status === "implemented";

export const PRODUCTION_UNAVAILABLE_CAPABILITIES: CapabilityAvailabilityPolicy =
  new Map([
    [
      "commit_export",
      {
        reason:
          "Export is unavailable until a production export provider is connected",
        safeNextStep:
          "Controleer de snapshot en goedkeuring via de read-only validatiestappen.",
        status: "disabled",
      },
    ],
    [
      "complete_task",
      {
        reason:
          "Task completion is a stub and does not record durable completion",
        safeNextStep:
          "Lees de taakstatus in het bronsysteem; claim geen afgerond effect.",
        status: "fixture-stub",
      },
    ],
    [
      "start_run",
      {
        reason:
          "Run dispatch uses a fixture contract without a durable dispatcher",
        safeNextStep:
          "Bekijk de laatste bronstatus en runs via de read-only bronacties.",
        status: "fixture-stub",
      },
    ],
    [
      "start_test_import",
      {
        reason:
          "Test import dispatch uses a fixture contract without a durable dispatcher",
        safeNextStep:
          "Bekijk de bronstatus en plan een gecontroleerde fixturetest.",
        status: "fixture-stub",
      },
    ],
  ]);

export const unavailableCapabilityReason = (
  policy: CapabilityAvailabilityPolicy | undefined,
  capabilityId: string
): string | undefined => {
  const availability = policy?.get(capabilityId);
  return availability && !isCapabilityExecutable(availability)
    ? availability.reason
    : undefined;
};

export const capabilityAvailability = (
  policy: CapabilityAvailabilityPolicy | undefined,
  capabilityId: string
): CapabilityAvailability => {
  const availability = policy?.get(capabilityId);
  return (
    availability ?? {
      reason: "De registry-handler is beschikbaar voor deze rol.",
      safeNextStep: "Voer de capability uit met de getoonde invoer.",
      status: "implemented",
    }
  );
};
