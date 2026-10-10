# Files

- [MCP Integration](mcp.md) - The Model Context Protocol (MCP) integration provides a standardized transport for agents to interact with the system's capability registry, sharing the same handlers and authorization logic as REST while offering MCP-specific features like tool discovery and structured error handling.
- [Sources Integration](sources.md) - Describes the integration with various job posting sources (Alliander, ASML, BAM, etc.) via the connector framework, including the polling, fetching, and rate limiting mechanisms.
- [Spott.io Integration](spottio.md) - Describes the export integration with Spott.io, including the mapping of aanvragen to Spott.io format and the idempotent export process.
- [Trigger.dev Integration](triggerdev.md) - Describes the use of Trigger.dev for retained jobs (enrich-incomplete, schedule-enrich-incomplete, drain-outbox, backfill-neon-v1) and how they integrate with the system.
