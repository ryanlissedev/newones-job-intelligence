# OpenWiki in this repository

The `openwiki/` directory holds an **evidence index** generated from source code and tests. It is optional context for agents and humans — not a product spec.

## Rules

- Treat **source code and tests** as authoritative. OpenWiki pages summarize evidence; they do not override briefs or acceptance criteria.
- Do **not** hand-edit generated pages unless explicitly asked. Prefer updating source and running `bun run wiki` locally or waiting for the scheduled CI PR on branch `openwiki/update`.
- Do **not** commit `openwiki/` together with feature code. The pre-commit wiki guard enforces this; CI opens dedicated wiki PRs.
- `docs/` product discovery prose is **out of scope** for OpenWiki rewrites and Markdown formatters.

## Local update

```bash
bun run wiki
```

Requires the `openwiki` CLI and provider credentials (see `.github/workflows/openwiki-update.yml`).

## Ignored paths

Private paths are listed in `.openwikiignore`. Runtime state lives in `.openwiki/` (gitignored).
