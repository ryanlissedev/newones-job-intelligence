# RJC-348 — Performance & delivery evidence index

RJC-348 is closed by the completed child contracts and evidence paths below.

- [RJC-349 measurement contract and closure evidence](../rjc-349/README.md)
- [RJC-352 CI timing](https://github.com/ryanlissedev/rsp-job-intelligence/pull/12)
  and its CI artifacts
- [RJC-350 critical-path evidence](https://github.com/ryanlissedev/rsp-job-intelligence/pull/41)
- [RJC-351 Crabbox/exe.dev lane](https://github.com/ryanlissedev/rsp-job-intelligence/pull/13)
  and [follow-up PR #63](https://github.com/ryanlissedev/rsp-job-intelligence/pull/63)
- [RJC-415 / D9 bron-dashboard product budget evidence](../rjc-415/README.md)
- Production SoR: [ADR-0011](../../adr/ADR-0011-postgres-on-box-trigger-static-ips.md)
  and the completed RJC-418 on-box cutover

The bron-dashboard benchmark can be measured and reported with the versioned
contract using `bun run perf:measure` and `bun run perf:report`; delivery
thresholds remain observe-only until an accepted CI baseline exists.
