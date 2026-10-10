<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

## React Doctor (advisory)

Complements Ultracite/oxlint with React-specific diagnostics (state/effects, performance, architecture, security, a11y). Config: `doctor.config.json` in this directory. CI runs `.github/workflows/react-doctor.yml` on pull requests that touch `apps/web` and reports only **new** issues vs the PR base (`scope: changed`).

From this directory:

```bash
bunx react-doctor@latest --no-telemetry
```

Use `--verbose --scope changed` before/after React edits to see only introduced findings. Telemetry and score API are off (`--no-telemetry` / `noScore` in config).
