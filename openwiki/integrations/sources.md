---
type: concept
title: Sources Integration
description: Describes the integration with various job posting sources (Alliander, ASML, BAM, etc.) via the connector framework, including the polling, fetching, and rate limiting mechanisms.
tags: [sources, connectors, integration, job-postings]
verified:
  - by: openwiki/0.7.0
    at: 2026-10-10T14:05:56.822Z
sources:
  - id: openwiki-source-146429799d70091aeef80171
    resource: repo://packages/application/src/sources/alliander.ts
  - id: openwiki-source-4ae51fbfdaf46bb998dc3ea2
    resource: repo://packages/application/src/sources/definition.ts
  - id: openwiki-source-2f4997da517fb58afbba238a
    resource: repo://packages/application/src/sources/registry.ts
generated: { by: "openwiki/0.7.0", at: "2026-10-10T14:05:56.822Z" }
---
# Sources Integration

The sources integration enables the system to ingest job postings from diverse external sources (such as Alliander, ASML, BAM, and many others) through a unified connector framework. Each source is encapsulated by a connector that implements discovery (listing available postings) and fetching (retrieving full posting details). The framework supports known-hash optimizations to avoid redundant fetches, enforces per-source rate limiting via crawl delays, and integrates with the worker's poller for scheduled execution.

## Source Definitions

Each ingestible source is defined by a `SourceDefinition` object (located in `/packages/application/src/sources/`). The definition includes:

- **bronId**: A UUID uniquely identifying the source within the domain.
- **createConnector**: A factory function that produces a `Connector` instance given runtime configuration (such as whether to use live data or fixtures, and known hash stores).
- **listingHashCoversDetail**: A boolean indicating whether the hash computed from the listing item (used for known-hash checks) sufficiently covers all fields needed for normalization. If `false`, the connector must not pass known hashes to avoid missing detail-only changes.
- **liveEnv**: The name of the environment variable that enables live HTTP requests (as opposed to using fixtures).
- **runBudgetMs**: Optional maximum wall-clock time allowed for a single connector run, sized to accommodate the source's typical workload.
- **naam**: Human-readable source name (e.g., "Alliander").
- **normalise**: A function that transforms a fetched raw payload (Uint8Array) into a normalized `NormalisedAanvraagDraft`.
- **seed**: Seed configuration used during initial setup, specifying crawl delay (in ms), HTTP method (e.g., "json-ld"), and default voorwaarden status.
- **slug**: A short, stable identifier used in configuration and URLs (e.g., "alliander").

Source definitions are registered in the `SOURCES` map in `/packages/application/src/sources/registry.ts`. Adding a new source requires creating a definition file and adding one line to this registry.

## Connector Framework

The connector framework (defined in `/packages/connectors/src/contract.ts`) standardizes how sources interact with the ingestion pipeline. A `Connector` provides three core operations:

### Discovery (`discover`)

Given an optional checkpoint (for pagination) and an abort signal, `discover` returns a page of `DiscoverItem` objects. Each item includes:

- **bronReferentie**: The source's unique identifier for the posting (often the external ID).
- **contentHash**: A hash of the listing item (used for known-hash checks).
- **listingPayload**: Optional deserialized listing row (if the connector wants to avoid re-fetching during the fetch phase).

The result also includes an updated checkpoint and a `hasMore` flag indicating whether additional pages exist. A `truncated` flag may be set if the connector stopped early due to a page limit (e.g., `STRIIVE_MAX_PAGES`), signaling that the run was incomplete.

### Fetching (`fetch`)

Given a `DiscoverItem`, `fetch` retrieves the full posting payload. The connector may first check whether the item is unchanged using a known-hash store (if `listingHashCoversDetail` is true and known hashes were provided). If unchanged, it returns `null` to skip the fetch (saving a request-limiter slot). Otherwise, it retrieves the payload (e.g., via HTTP or a fixture), computes a content hash, and returns a `ConnectorFetchedResult` containing the body, bronReferentie, contentHash, content type, and a "fetched" status. If the item is invalid (e.g., missing required fields), it returns a `ConnectorRejectedResult` with a reason and optional rejection kind.

### Skip Fetch Optimization (`skipFetch`)

An optional function that, given a `DiscoverItem`, returns `true` if the item is unchanged since the last persisted fetch. When true, the runner skips the fetch call and does not consume a request-limiter slot, treating the item as observed (never missed). This optimization is only safe when the listing hash covers all detail fields relevant to normalization.

### Connector Metadata

- **bronId**: The source identifier (copied from the definition).
- **fetchUsesNetwork**: Optional boolean indicating whether the connector makes network requests. If omitted, the connector is assumed to be network-backed and subject to the per-source request limiter.

## Known-Hash Optimization

To avoid fetching unchanged postings, connectors can leverage a known-hash store (passed via `CreateSourceConnectorInput`). The store maps `bronReferentie` to previously seen content hashes. Before fetching, the connector computes the hash of the listing item (or the full payload, depending on implementation) and checks the store. If the hash matches and `listingHashCoversDetail` is true, the fetch is skipped.

This optimization is only safe for sources where the listing item hash incorporates every field the normalizer reads (e.g., closing date, location, rate, title, description, URLs, and source-specific fields). For sources where the normalizer fetches a detail page containing additional information not present in the listing (e.g., Tenderned), `listingHashCoversDetail` must be `false`, and known hashes must not be passed to the connector.

## Rate Limiting and Crawl Delay

Each source specifies a `crawlDelayMs` in its seed configuration. The worker's poller respects this delay by ensuring that requests to the same source are spaced at least this far apart. The delay is derived from the source's typical crawl rate (e.g., 2000 ms for Alliander) and is configured per source to avoid overloading external endpoints.

The poller also enforces a per-connector run budget (`runBudgetMs`) to prevent any single source from consuming excessive resources. If a connector's healthy run is known to exceed the poller-wide budget (1 hour by default), `runBudgetMs` is sized appropriately (e.g., based on catalog size × crawl delay with headroom) and capped below the abandon threshold (`POLLER_ABANDON_RUN_AFTER_MS`) so the connector can close its own run before the reaper intervenes.

## Integration with the Worker

The worker's poller (located in `/apps/worker/src/`) orchestrates source ingestion:

1. For each source in the `SOURCES` registry, the poller creates a connector instance using the source's `createConnector` factory.
2. The poller invokes the connector's `discover` method iteratively (using checkpoints for pagination) to gather all `DiscoverItem` objects.
3. For each item, the poller checks the known-hash store (if applicable) and may skip the fetch via `skipFetch` or the connector's internal check.
4. If fetching is required, the poller calls the connector's `fetch` method (subject to the source's request limiter).
5. Fetched payloads are passed to the source's `normalise` function to produce a `NormalisedAanvraagDraft`.
6. The drafts are then processed by the normalization pipeline to produce curated `Aanvraag` objects.

Fixture-based runs (for testing or replay) are supported by providing a `listingFixturePath` in `CreateSourceConnectorInput`, which causes the connector to read listings from a committed file instead of making HTTP requests.

## Relationships to Other Concepts

- **Domain Model**: Sources correspond to `bron` records in the domain, each with a `bronId` and metadata such as name and activation status.
- **Ingest Pipeline**: Connectors are the first stage of the ingest pipeline, providing raw payloads that are then normalized and stored.
- **Configuration**: Source-specific behavior is tuned via seed configuration (crawl delay, method, voorwaarden status) and environment variables (e.g., `ALLIANDER_LIVE`).

## Extension Points

Adding a new source involves:
1. Creating a definition file in `/packages/application/src/sources/` (following the pattern of existing sources like `alliander.ts`).
2. Implementing a connector (either by reusing the JSON-LD framework for sources with structured data or writing a custom connector) and wiring it in the definition's `createConnector` factory.
3. Registering the source in the `SOURCES` map in `/packages/application/src/sources/registry.ts`.
4. Providing source-specific normalization logic (if not reusing a shared normalizer like `normaliseJsonLdObservation`).
5. Documenting any special considerations (e.g., whether the listing hash covers detail fields) in the source's definition comment.
