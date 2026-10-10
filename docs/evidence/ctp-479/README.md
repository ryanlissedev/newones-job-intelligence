# CTP-479 evidence pack (Catapulze)

Herdr lands flags + canary hooks + this checklist. **Live prod evidence** is
Catapulze-owned after Coolify tip MATCH.

See [effectts-production-enablement runbook](../../runbooks/effectts-production-enablement.md).

## Per-flip checklist

- [ ] Coolify tip SHA MATCH `/version`
- [ ] `/readyz` 200
- [ ] Authenticated `/jobs` Boolean returns rows
- [ ] `/bronnen` not access-denied
- [ ] Rollback once (flag off → healthy native path)
- [ ] Only one surface enabled for this flip window

Attach operator notes/screenshots here (no secrets).
