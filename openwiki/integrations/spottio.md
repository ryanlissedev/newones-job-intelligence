---
type: integration
title: Spott.io Integration
description: Describes the export integration with Spott.io, including the mapping of aanvragen to Spott.io format and the idempotent export process.
tags: [Spott, export, integration]
verified:
  - by: openwiki/0.7.0
    at: 2026-10-10T14:05:56.822Z
sources:
  - id: openwiki-source-1d42c4069a623b5bf6bfb101
    resource: repo://packages/application/src/export/map-aanvraag-to-spott.ts
generated: { by: "openwiki/0.7.0", at: "2026-10-10T14:05:56.822Z" }
---

# Spott.io Integration

This page explains how the system exports approved job vacancies (aanvragen) to Spott.io. The integration consists of two main parts:

1. **Mapping** – Converting an internal `AanvraagRecord` to the Spott API’s `SpottCreateVacancyRequest` format.
2. **Export Process** – Performing the export in an idempotent manner using an outbox pattern and tracking export events.

## Mapping Aanvragen to Spott Format

The core mapping function is `mapAanvraagToSpottCreateRequest`, located in `packages/application/src/export/map-aanvraag-to-spott.ts`. It transforms an `AanvraagRecord` into a `SpottCreateVacancyRequest` with the following structure:

- **clientContactIds**: Always an empty array. The Spott API uses this field for internal contact IDs, which are not sourced from the aanvraag. Instead, source-published contact persons are included in the vacancy description (see below).
- **companyId**: A fixed fixture ID (`company-fixture-001`) used for all exports.
- **description**: The aanvraag’s `beschrijving` field, optionally followed by a formatted block of contact persons. Each contact person is listed as `- <naam> — (<rol>) — <email> — <telefoon>`, with empty parts omitted. This block is prefixed by `\n\nContactpersonen bij bron:\n` and is only included if the aanvraag has contact persons. This satisfies CTP-610, which mandates that source-published contact data travels with the customer export.
- **employmentType**: Hardcoded to `"contract"`.
- **endAt**: Always `null`.
- **location**: Always `null`.
- **locationType**: Hardcoded to `"remote"`.
- **name**: The aanvraag’s `titel` field.
- **salaryRange**: Always `null`.
- **stageId**: A fixed fixture ID (`stage-fixture-001`) used for all exports.
- **startAt**: Always `null`.
- **targetCompanyId**: Always `null`.
- **teamUserIds**: Always an empty array.

The fixed fixture IDs for company and stage are placeholders; in a real integration, these would be resolved based on the aanvraag’s properties or configuration.

## Export Process

The export process is implemented in `packages/application/src/export/commit-export.ts`. It follows these steps:

1. **Retrieve** the approved aanvraag from the store.
2. **Map** the aanvraag to a Spott create request using `mapAanvraagToSpottCreateRequest`.
3. **Call** the Spott write client’s `createVacancy` method with the mapped request.
4. **Confirm** the creation by fetching the newly created vacancy via its external ID (returned by the create call) to ensure it exists and retrieve any system-generated fields.
5. **Record** an export event in the outbox to prevent duplicate exports (idempotency).

The process is idempotent because each export attempt records an outbox event. If an export event for the same aanvraag already exists, the process is skipped. Additionally, the Spott client may be configured to run in fixture mode (using local JSON files) for testing, or in live mode when a valid API key is provided.

## Error Handling

Specific errors related to the Spott API are modeled as:
- `SpottApiError`: For non-2xx HTTP responses, including the status code and response body.
- `SpottRateLimitError`: A subclass of `SpottApiError` for HTTP 429 responses.

The export handlers in `packages/application/src/registry/handlers/export-handlers.ts` check for the presence of a Spott write client. If none is configured, the export operation fails fast with the message: "Export is disabled because no Spott write client is configured".

## Testing

Unit tests for the mapping function are in `packages/application/src/export/map-aanvraag-to-spott.spec.ts`. They verify:
- The basic mapping of aanvraag fields to Spott fields.
- The inclusion of contact persons in the description when present (CTP-610).
- The exclusion of the contact block when no contact persons are present.

Integration tests for the export process are in `packages/application/src/export/commit-export.spec.ts`. They simulate various scenarios, including:
- Successful create and confirmation.
- Handling of Spott API errors (e.g., 404, 503).
- Idempotency behavior (though the specific idempotency mechanism is tested via the outbox event recording).

## Related Concepts

- The domain model for `AanvraagRecord` is defined in `@ji/domain` and used throughout the system.
- The export approval workflow is detailed in `/openwiki/workflows/export-approval.md`.
- The outbox pattern and event recording are part of the system’s reliability mechanisms.
