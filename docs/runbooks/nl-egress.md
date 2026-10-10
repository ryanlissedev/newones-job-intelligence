# NL egress for geo-blocked sources (CTP-602)

Some Dutch boards answer non-Dutch egress IPs with a hard block. Verified
2026-09-16 from both the production box IP and `<exe-dev-host>` (fra):

| Source | Block observed |
|---|---|
| `rabobank` (rabobank.jobs) | HTTP 403 "Tijdelijk niet beschikbaar" |
| `intermediair` | HTTP 403 / Cloudflare |
| `planet-interim` | HTTP 403 / Cloudflare |
| `techniekwerkt` | HTTP 403 / Cloudflare |

The connectors and fixtures for these sources are in the repo and work; only
the route out is missing. The poller can route selected sources through an
operator-run HTTP forward proxy on a Dutch IP. Everything else keeps fetching
directly.

This change touches `apps/worker/`, `packages/connectors/` and
`packages/env/` — all `blockedReleasePath` manual-lane paths. Merging does not
deploy it. The operator ships it through the manual release path in
[hetzner-deploy.md](hetzner-deploy.md), and `Deploy production` staying red
until then is the gate working, not a bug.

## Environment

Two variables on the `poller` service, both optional:

| Variable | Required | Notes |
|---|---|---|
| `EGRESS_PROXY_URL` | only when sources are routed | `http://` or `https://` forward-proxy endpoint, credentials in the URL if the proxy needs them (`http://user:pass@host:port`). Never logged — `poller_started` reports only `egressProxyConfigured` and `egressProxiedSources`. |
| `EGRESS_PROXY_SOURCES` | only when routing | `*` or a comma-separated list of source slugs — the keys of `SOURCES` in `packages/application/src/sources/registry.ts` (`rabobank`, `intermediair`, `planet-interim`, `techniekwerkt`, ...). |

Both unset is today's behaviour: every source fetches directly. The config
fails closed rather than silently direct:

- `EGRESS_PROXY_SOURCES` set but `EGRESS_PROXY_URL` unset: the poller refuses
  to start (`EgressConfigError`), and a connector constructed on such a config
  throws the same error.
- A malformed URL, a non-http(s) scheme, or a malformed sources entry fails
  env validation at boot and `EgressConfigError` at the connector boundary.
- Egress routing needs Bun's `fetch` `proxy` option. On a runtime without it
  the code throws instead of degrading to direct egress. The poller runs
  under Bun (`bun src/poller/main.ts`), so this only guards other consumers.

A slug in `EGRESS_PROXY_SOURCES` that names no registered source is inert —
nothing routes through it — so check the `poller_started` log line after
configuring.

## Operator steps

Order follows [hetzner-deploy.md](hetzner-deploy.md) →
[automatic-production-deploy.md](automatic-production-deploy.md).

1. **Provide a Dutch-IP forward proxy.** This runbook does not provision one.
   Any HTTP forward proxy whose egress IP is in a NL range works: a tiny VPS
   in a NL region running squid/tinyproxy, or a paid NL residential
   proxy endpoint. Note its URL, including credentials — keep it out of git
   and out of this document.
2. **Ship the code** through the manual release lane (blockedReleasePath:
   `apps/worker/`, `packages/connectors/`, `packages/env/` all qualify).
3. **Set the env on the poller** — Coolify on the box (`ssh <hetzner-alias>`,
   Coolify on port 8000), `poller` application → Environment Variables:
   - `EGRESS_PROXY_URL=<the proxy endpoint>`
   - `EGRESS_PROXY_SOURCES=rabobank,intermediair,planet-interim,techniekwerkt`
     (or the subset you actually want routed)
   Redeploy/restart the `poller` service so the process re-reads env.
4. **Only then set the per-source live flags** (`RABOBANK_LIVE=1` etc.) on the
   same service. Do not set `*_LIVE` before step 3 is verified — a live flag
   on a still-direct source just burns poll budget on 403s and trips the
   discovery-floor alert.

## Verification

1. **Startup log.** The first `poller_started` line after restart carries
   `egressProxyConfigured: true` and `egressProxiedSources: [...]` with the
   slugs you set. `egressProxyConfigured: false` means the URL did not reach
   the process.
2. **Egress IP check.** From the box, confirm the proxy itself exits on a
   Dutch IP: `curl -x <proxy-url> https://api.ipify.org` should answer an NL
   address, and `curl https://api.ipify.org` (no `-x`) shows the box's own IP
   for contrast.
3. **Live fetch through the egress.** For one routed source, fetch its live
   sitemap and one detail page through the proxy:

   ```bash
   curl -x <proxy-url> -s -o /dev/null -w '%{http_code}\n' <source sitemap URL>
   curl -x <proxy-url> -s -o /dev/null -w '%{http_code}\n' <one detail URL from that sitemap>
   ```

   A `200` where direct fetch answers `403` is the proof the route works.
   Keep this to one sitemap plus one detail — the goal is a verdict, not a
   crawl, and these hosts are the ones that blocked us.
4. **Poll run.** Set the source's `*_LIVE` flag, wait for its next due poll
   (or force one per [slice-a-oneshot-poll.md](slice-a-oneshot-poll.md)), and
   read the `poller_source` line: `found` should reflect the real listing,
   not zero with fetch errors. The raw payload for the run lands in the
   object store as usual if a page needs inspecting.

## Rollback

Unset `EGRESS_PROXY_SOURCES` (and `EGRESS_PROXY_URL`) on the poller service
and restart — egress returns to direct for every source. Unset the source's
`*_LIVE` flag too if it was only enabled for the proxy route, or its next
poll goes back to 403s.

## Known limits

- Proxy auth is whatever the `http(s)://user:pass@host:port` URL carries;
  Bun's `proxy` option also accepts a `Proxy-Authorization` header object,
  but this config surface is URL-only. SOCKS endpoints are rejected — front
  the NL exit with an HTTP forward proxy.
- Routing is per source, not per request: listing, pagination and detail
  fetches for a routed slug all take the proxy.
- `EGRESS_PROXY_URL` set with an empty/unset sources list changes nothing —
  deliberate, so the endpoint can be staged before any source is moved.
