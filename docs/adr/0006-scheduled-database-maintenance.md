# ADR 0006: Run retention maintenance as a scheduled database job

Status: Accepted
Date: 2026-09-01

## Context

The published retention policy says expired private messages are deleted, but
deletion ran only when a direct-channel or assistant inbox request happened. A
quiet service therefore retained data past its stated window. R4 also added a
one-shot command for freezing stalled threads without choosing what invokes it
in the deployed two-instance topology.

An in-process timer on every web instance would make cadence depend on the
current instance count and liveness. Scaling would silently add competing
timers, and an exception between requests would be difficult to observe or
retry. A Redis leader lock (`SET NX` with a bounded TTL) could prevent duplicate
work, but the schedule would still depend on at least one web instance being
alive.

## Decision

Provision one Render cron service that runs `npm run maintenance` hourly. The
one-shot command uses a single reference time and one PostgreSQL transaction to
delete expired sessions and private messages, freeze stalled threads, and write
a `maintenance-completed` system security event containing cutoffs and counts.
Request handlers do not perform retention work.

## Consequences

- Retention and thread maintenance run independently of traffic and web-instance
  count. Render exposes each invocation separately for observation and retry.
- The cron service is another billable Render service. Operators must review its
  recurring price as part of the deployment ceiling; R6 accepts that cost to
  uphold C9 and the published retention promise.
- A successful run is atomic and auditable. A failed transaction leaves neither
  partial deletion nor a false completion record; the failed cron invocation
  remains visible in Render.
- If the separate service becomes unaffordable, the documented fallback is an
  in-process scheduler protected by a shared Redis leader lock. That fallback is
  intentionally not implemented because its cadence depends on web liveness.
