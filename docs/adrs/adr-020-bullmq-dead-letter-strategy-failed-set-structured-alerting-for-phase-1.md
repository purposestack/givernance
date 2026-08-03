## ADR-020: BullMQ Dead-Letter Strategy — `failed` Set + Structured Alerting for Phase 1

**Status**: Accepted (Phase 1 Sprint 5, issue #56 Platform #6)
**Related**: `docs/17-log-management.md`, ADR-008 (job queue)

### Context

Worker jobs retry up to 3× with exponential backoff. After attempts exhaust, BullMQ moves the job into the per-queue `failed` set (retained by `removeOnFail: { count: 50 }`). Before issue #56 there was no explicit handler for *terminal* failures — operators found out via BullBoard when a customer complained.

### Decision

**Structured logging + Loki alerting on terminal failure. Keep the BullMQ `failed` set as the operator inspection surface. Revisit if volume grows.**

- **Detection.** Every worker's `on('failed', ...)` handler compares `attemptsMade >= opts.attempts`. Terminal failures log at `error` with `{ dlq: true, tenantId, jobId, jobName, err, stack }`; retryable failures log at `warn`.
- **Inspection.** BullBoard remains the UI. Retention: `removeOnFail: { count: 50 }` per queue — sufficient for Phase 1 volumes; operators triage within days.
- **Alerting.** Loki query `{service="givernance-worker"} | json | dlq=true` drives a Grafana alert (operator setup). The log line reaches Loki through the standard pipeline — pino → stdout → Loki (Scaleway Cockpit on SaaS; self-hosted Loki otherwise); no error-tracking SDK is involved (Sentry is not installed).
- **Replay.** Manual via BullBoard's retry button. No programmatic retry endpoint yet.

### Why not heavier options

- **Separate DLQ queue.** Doubles per-queue ops burden (connections, metrics, retention) for minimal extra capability at current volume. Revisit when BullMQ's 50-item retention isn't enough for triage.
- **Postgres `dead_letter_jobs` table.** Overkill when we see a few terminal failures / day. Revisit when (a) compliance demands > 30-day failure retention, or (b) programmatic replay tooling independent of Redis matters.

### Consequences

- Worker code carries exactly one log-line branch — no new infra.
- BullMQ retry-semantics changes could silently skip the terminal check; we pin the major version and need a follow-up integration test (tracked in issue #56 QA).

### Deviation — events queue (outbox relay)

The generic events queue is enqueued by the relay with `attempts: 5, removeOnFail: 5000` (`packages/relay/src/relay.ts`), not the `removeOnFail: { count: 50 }` default above. Accepted: every domain event funnels through this one queue, so a 50-item failed set could evict entries before an operator triages a burst; 5000 buys a longer forensic window at negligible Redis cost (failed jobs are small JSON envelopes). Terminal-failure detection is unaffected — the `on('failed', ...)` handler compares `attemptsMade` against the job's own `opts.attempts`, so the 5-attempt override is picked up automatically.

### Revisit criteria

- Sustained > 10 terminal jobs / day → separate DLQ queue.
- Compliance requires > 30-day failure retention → Postgres DLQ table.
- Replay becomes frequent enough that BullBoard clicks hurt → build a small admin tool, then decide between queue vs table.

---

