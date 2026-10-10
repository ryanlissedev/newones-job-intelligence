FROM oven/bun:1.3.14@sha256:e10577f0db68676a7024391c6e5cb4b879ebd17188ab750cf10024a6d700e5c4 AS builder
WORKDIR /app
ENV SKIP_ENV_VALIDATION=1

COPY . .
RUN --mount=type=cache,target=/root/.bun/install/cache bun install --frozen-lockfile --ignore-scripts

ENV NODE_ENV=production
RUN cd apps/server && bun run build

FROM oven/bun:1.3.14@sha256:e10577f0db68676a7024391c6e5cb4b879ebd17188ab750cf10024a6d700e5c4 AS runner
WORKDIR /app
ENV NODE_ENV=production
COPY --chown=bun:bun --from=builder /app /app

EXPOSE 3000

WORKDIR /app/apps/server
USER bun
# Coolify treats Docker HEALTHCHECK failure as deploy rollback. Use /livez
# (process up) here; keep /readyz as the app readiness contract (Traefik/ops),
# not the container liveness gate — see docs/runbooks/readiness.md.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD bun -e "fetch('http://localhost:3000/livez').then((response) => process.exit(response.ok ? 0 : 1)).catch(() => process.exit(1))"
CMD ["bun", "dist/index.mjs"]
