# Files

- [Export & Approval](export-approval.md)
- [Ingest Pipeline](ingest-pipeline.md) - End-to-end flow that polls a bron, runs its connector discover/fetch, records raw observations, normalises them to the shared aanvraag shape, and curates SCD2 rows with outbox events from the on-box poller.
- [Search Projection](search-projection.md) - How curated rows become searchable through outbox drain, the on-box projector, Manticore bulk writes, index versioning, partitioning, and the cached search read path.
