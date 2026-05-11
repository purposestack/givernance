# Runbook — Bulk email job stalled / partial delivery (issue #326)

> **Triage flow** for `bulk_email_jobs` rows that surface to operators as
> *Stalled* or *Partial*. Unlike the other runbooks in this directory,
> this is **not** a one-shot ops procedure — it's the recurring SRE
> playbook for the `bulk_email.partial` alert + operator-reported
> "my email didn't go out".

## Detection

Two signals fire:

1. **Operator-reported** — the "Recent emails" panel in the constituents
   page shows a job stuck at `Sending…` with no progress (server-derived
   `stalled: true` once `updated_at` is older than `BULK_EMAIL_STALL_MS`,
   default 10 min).
2. **Worker log** — a Loki query for
   `{service="worker"} | json | event="bulk_email.partial"` returns
   rows. Every `partial` outcome is logged at `warn`-level by
   `finaliseJob` in [`packages/worker/src/processors/send-bulk-email.ts`].

## Triage — was this a worker death or SMTP refusal?

```sql
-- One row per recipient outcome bucket.
SELECT
  id, status, total_recipients, delivered_count, failed_count,
  total_recipients - delivered_count - failed_count AS missing,
  updated_at, completed_at
FROM bulk_email_jobs
WHERE id = '<job-id>';
```

Decision tree:

| `failed_count > 0` | `missing > 0` | What happened |
|---|---|---|
| Yes | No | SMTP refused for some recipients. Check `provider.email.error` log lines for the failed `constituentId`s. Likely transient (Resend 429, hard bounce). |
| No | Yes | **Worker died mid-fan-out.** BullMQ job dropped (Redis OOM / accessory reboot / `kamal accessory reboot worker`). |
| Yes | Yes | Mixed — both happened. Treat as worker-death (the missing slice is the priority). |
| No | No | Job actually completed; the operator might be looking at a stale poll. Refresh. |

## Recovery

### Operator path (preferred)

Hit **"Resume to remaining"** in the "Recent emails" panel. The server-
side eligibility gate accepts `partial` / `failed` / stalled `processing`.
A new `bulk_email_jobs` row is created with `parent_job_id = source.id`
and `constituent_ids = source.constituent_ids \ delivered_constituent_ids`
— previously SMTP-failed recipients are retried (operator intent: "make
sure everyone who hasn't received it gets it"). The audit chain is
queryable via `parent_job_id`.

### SRE path (when the operator path is unavailable)

If the API is down or the row's RLS context blocks the operator:

```sql
-- Force-stall a `processing` row so its `stalled` flag flips on the
-- next API poll (do NOT use unless you've confirmed the worker is dead).
UPDATE bulk_email_jobs
SET updated_at = NOW() - INTERVAL '30 minutes'
WHERE id = '<job-id>';
```

After this the operator's Resume button becomes available.

If you must intervene at the DB layer (last resort — prefer Resume):

```sql
-- Mark the row terminal so it stops showing as "Sending…" in the UI.
-- Counters are unchanged; the operator can decide whether to Resume.
UPDATE bulk_email_jobs
SET status = 'partial',
    error = 'Marked partial by SRE — worker died mid-fan-out',
    completed_at = NOW(),
    updated_at = NOW()
WHERE id = '<job-id>' AND status = 'processing';
```

## Tuning `BULK_EMAIL_STALL_MS`

Default 10 min. Lives in
[`packages/api/src/modules/constituents/bulk-email-service.ts`]. If a
real send legitimately exceeds 10 min between recipient ticks (large
tenant on a slow SMTP provider, retry-heavy Resend), the API will
incorrectly surface healthy jobs as stalled. Raise the constant; ship
in a PR (no env-var override yet — see PR #352 follow-up notes).

## Related

- [docs/23 § 6.bis](../23-postal-campaigns.md) — domain doc with sequence diagram + PII posture
- [`packages/api/migrations/0045_bulk_email_jobs.sql`] — schema + CHECK constraint
- [`packages/api/migrations/0046_bulk_email_jobs_review_followups.sql`] — composite index + partial unique on active resumes
