# Files

- [Export Approval and Spott.io Integration](export-approval.md) - Human approval workflow for curated data and idempotent export to Spott.io via the capability registry.
- [Health Monitoring and Source Signals](health-monitoring.md) - How source connector health, data freshness, and system vitals are monitored and alerted.
- [Ingest Pipeline](ingest-pipeline.md) - End-to-end flow that polls a bron, runs its connector discover/fetch, records raw observations, normalises them to the shared aanvraag shape, and curates SCD2 rows with outbox events from the on-box poller.
- [Search Projection](search-projection.md) - How curated rows become searchable through outbox drain, the on-box projector, Manticore bulk writes, index versioning, partitioning, and the cached search read path.
