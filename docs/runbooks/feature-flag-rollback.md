# Runbook — Feature flag emergency rollback (PR #352)

> SRE-facing reference for the global feature-flag registry shipped in
> PR #352. Use when the Back Office page at `/admin/feature-flags` is
> unavailable (API down, super-admin session compromised, frontend
> regression) AND a flipped flag needs to come down NOW.

## When to use this runbook

Normal flow: a super-admin flips a flag at `/admin/feature-flags` →
Back Office page → the PATCH writes PG, invalidates the Redis cache,
the next API request observes the new value. End of story.

This runbook is for **anything that breaks that flow**:

- Back Office page is broken (frontend bug, layout 500, super-admin
  token expired without refresh).
- A flag was flipped accidentally and is causing observable harm to
  donors / operators.
- API is down but the worker is still picking up gated jobs (worker
  reads PG directly — flag stays effective even with API down).
- An incident response needs the flag's history reconstructed.

## Emergency rollback via psql

The DB is the source of truth — flip the flag there and clear the
Redis cache. The next request rebuilds the cache from PG.

```bash
# 1. Connect to the application DB
ssh givernance-staging   # or givernance-prod
docker exec -it givernance-postgres-1 \
  psql -U givernance -d givernance

# 2. Flip the flag back to OFF (or to a known-good value)
UPDATE feature_flags
   SET enabled    = FALSE,
       updated_at = NOW()
 WHERE key = 'communication.bulk_email';

\q
```

```bash
# 3. Invalidate the Redis cache so the next request rebuilds from PG
docker exec -it givernance-redis-1 \
  redis-cli DEL flags:global
```

Verification: `curl -s -H "Authorization: Bearer $TOKEN"
https://api.staging.givernance.org/v1/feature-flags | jq` — the row
should report `enabled: false`.

## Worker-side: confirm the drop is in effect

The worker reads PG directly (no Redis cache) so a PG-level flip is
observed on the next job pickup. To confirm the drop is hitting:

```bash
# Live tail the worker logs for the drop signal
kamal app logs -r worker --follow -d staging | grep "Bulk email feature flag is off"
```

Each in-flight job that the worker drops will emit one warn line with
`{ orgId, bulkEmailJobId }`. The matching `bulk_email_jobs` row stays
`pending` — re-enabling the flag + clicking Resume from the operator
UI picks the job back up.

## Loki: audit reconciliation

"Who flipped `communication.bulk_email` to ON between 14:00 and
16:00 yesterday?" The audit-plugin row in `audit_logs` is the
authoritative answer. The row's `org_id` is whatever tenant the
super-admin's session was scoped to (see `docs/18 §0 — Audit notes`);
filter on `action` to find every flag toggle regardless of the
operator's session context.

```sql
SELECT created_at, user_id, org_id, action
  FROM audit_logs
 WHERE action = 'PATCH:/v1/admin/feature-flags/:key'
   AND created_at >= '2026-05-10 14:00'
   AND created_at <  '2026-05-10 16:00'
 ORDER BY created_at DESC;
```

Cross-check the value transition in Loki — the route handler emits a
structured `event=feature_flag.toggled` line with BEFORE/AFTER:

```logql
{app="givernance-api"}
  | json
  | event="feature_flag.toggled"
  | flagKey="communication.bulk_email"
```

## Common confusion

- **"I flipped the flag but the UI still shows the button."**
  The constituents page SSR-fetches `/v1/feature-flags` and the
  result is part of the rendered HTML. Hard-refresh the page (the
  cache invalidates on every PATCH, so the API immediately reports
  the new value; the *page* needs the new SSR render to see it).
- **"The worker keeps sending after I disabled the flag."**
  In-flight BullMQ jobs that the worker has already loaded but not
  yet checked the flag for will complete. Drops fire at the start
  of `processSendBulkEmail`, so a job mid-fan-out runs to completion.
  Wait for the active jobs to drain (workers run at concurrency 2,
  each send is sequential).

## Related

- [docs/18-feature-flags.md §0](../18-feature-flags.md) — what's
  shipped, how to add a new flag.
- [docs/23-postal-campaigns.md §6.ter](../23-postal-campaigns.md) —
  bulk-email-specific gate behaviour and three-layer enforcement.
- Migration `0047_feature_flags.sql` — schema + seed.
