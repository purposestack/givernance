# Cross-tenant RLS hardening cutover (issue #430)

> **Operator action required once per environment** — runs on staging today;
> on prod whenever it lands. Driven by [PR linked to issue #430](https://github.com/purposestack/givernance/issues/430).

## 0. Why this exists

On 2026-05-23 staging produced a cross-tenant notification leak: a
`donation.created` event in tenant `…c1` fanned out to org_admins of `…b1`
and `…a1` (4 inserted rows, 3 of them cross-tenant). The root cause was
that `DATABASE_URL_APP` on every container was constructed with the
**owner role `givernance`** (`rolbypassrls=t`) instead of the intended
`givernance_app` (`rolbypassrls=f`). The `users.tenant_isolation` RLS
policy was defined and active — but the connection bypassed RLS, so
every RLS-dependent query leaked.

The PR fixes the leak by:
1. Adding explicit `eq(<table>.orgId, …)` to every tenant-scoped query
   in API + worker code (defence in depth).
2. Adding a boot-time `assertAppRoleSecure` guard that crashes the API +
   worker if `DATABASE_URL_APP` connects as a BYPASSRLS role.
3. Wiring a new `GIVERNANCE_APP_PASSWORD` secret all the way through
   GH Environments → Kamal secrets → Postgres init script → app/worker
   connection strings.
4. Ensuring `tenant_disputes` and `receipt_sequences` have RLS enabled
   + forced + policied (they were the only structural gaps).

This runbook is the one-shot human steps to land all four on staging.

---

## 1. Pre-flight

Verify the PR is merged to `main` and the latest commit shows the
hardening (the bell test of the change is the boot-time guard — see
step 4).

```bash
ssh givernance-staging "docker exec givernance-postgres psql -U givernance -d givernance_staging -c \"SELECT rolname, rolcanlogin, rolbypassrls FROM pg_roles WHERE rolname IN ('givernance', 'givernance_app');\""
```

Expected before cutover:
```
    rolname     | rolcanlogin | rolbypassrls
----------------+-------------+--------------
 givernance     | t           | t
 givernance_app | t           | f
```

If `givernance_app` is missing, halt and investigate — the PR's
migration 0060 should have created it (or migration 0005 originally).

---

## 2. Generate the `GIVERNANCE_APP_PASSWORD` secret

```bash
APP_PW=$(openssl rand -hex 24)
echo "$APP_PW"  # copy to your password manager
gh secret set GIVERNANCE_APP_PASSWORD --env staging --body "$APP_PW"
```

Hex-encoding (not base64) avoids URL-special characters in the
connection string — see the existing pattern in
[`docs/dev/staging-secrets-setup.md`](../dev/staging-secrets-setup.md).

Confirm it landed:
```bash
gh secret list --env staging | grep GIVERNANCE_APP_PASSWORD
```

---

## 3. Rotate the `givernance_app` password on the running cluster

The Postgres init script `02-init-givernance-app-role.sh` runs only on
fresh datadir, so the **existing staging cluster** needs the password
rotated manually. The `ALTER ROLE` is a one-shot privileged-op and is
safe to run while the app is up (the new password takes effect on the
next connection).

```bash
# Use the same hex string you stored in the GH secret above.
ssh givernance-staging "docker exec -i givernance-postgres psql -U givernance -d givernance_staging" <<EOF
ALTER ROLE givernance_app WITH PASSWORD '$APP_PW';
ALTER ROLE givernance_app NOBYPASSRLS;
EOF
```

Verify:
```bash
ssh givernance-staging "docker exec givernance-postgres psql -U givernance -d givernance_staging -c \"SELECT rolname, rolbypassrls FROM pg_roles WHERE rolname='givernance_app';\""
```

---

## 4. Deploy the hardened app + worker

```bash
gh workflow run deploy-staging.yml --ref main
gh run watch
```

The new code's boot-time guard (`assertAppRoleSecure`) will crash the
container if `DATABASE_URL_APP` still connects as the owner role. A
successful deploy is the proof that the wiring is end-to-end correct.

Confirm:
```bash
ssh givernance-staging "docker exec \$(docker ps --filter name=givernance-api- -q | head -1) env | grep DATABASE_URL_APP | sed -E 's|://([^:]+):.*@|://\1:REDACTED@|'"
```

Expected: `DATABASE_URL_APP=postgres://givernance_app:REDACTED@givernance-postgres:5432/givernance_staging`.

---

## 5. Apply the schema migration

`pnpm db:migrate` runs as part of the deploy and applies
`0060_tenant_isolation_hardening.sql`. Confirm:

```bash
ssh givernance-staging "docker exec givernance-postgres psql -U givernance -d givernance_staging -c \"SELECT relname, relrowsecurity, relforcerowsecurity FROM pg_class WHERE relname IN ('tenant_disputes', 'receipt_sequences');\""
```

Expected: both tables show `relrowsecurity=t` and `relforcerowsecurity=t`.

---

## 6. Clean up the leaked notification rows (staging only)

```bash
ssh givernance-staging "docker exec -i givernance-postgres psql -U givernance -d givernance_staging" <<'EOF'
DELETE FROM notifications
WHERE outbox_event_id = '758e77b9-d154-482a-8b02-62e1de1ee220'
  AND user_id IN (
    '8a86d15e-6783-49ab-baae-83a2af770cd8', -- Camille (tenant b1)
    '7a39cec1-b465-4934-92bd-41b31830f412', -- Grégoire (__platform__)
    '8af680bc-d25a-44cd-805e-ce49fde6347e'  -- Magino (__platform__)
  )
RETURNING id;
EOF
```

Three rows should be deleted. If zero rows return, either the cleanup
already ran or the IDs were recycled; cross-check with:

```sql
SELECT n.id, n.user_id, u.email, u.org_id
FROM notifications n
JOIN users u ON u.id = n.user_id
WHERE n.params::text LIKE '%81a67ffa-d1ad-4c3b-938c-0f19ff8a2d44%';
```

The remaining row(s) must all be in tenant `00000000-0000-0000-0000-0000000000c1`.

---

## 7. Smoke-test the fix

End-to-end smoke (using a test donor in tenant `c1`, then verifying
Camille in tenant `b1` does NOT see a notification):

1. Log in as Bob (tenant `c1`) and create a donation.
2. SSH to staging and confirm exactly one notification row was inserted
   for tenant `c1` org_admins (Alice), zero for `b1` / `a1`:
   ```sql
   SELECT n.id, n.org_id, u.email
   FROM notifications n
   JOIN users u ON u.id = n.user_id
   WHERE n.outbox_event_id = (SELECT id FROM outbox_events ORDER BY created_at DESC LIMIT 1);
   ```
3. Log in as Camille (tenant `b1`) and confirm no new notification
   appears in the bell.

---

## 8. Rollback (if step 4 fails)

If the boot-time guard crashes the deploy and you need to roll back:

```bash
gh workflow run deploy-staging.yml --ref <previous-good-commit>
```

The previous code uses the same `DATABASE_URL_APP` (still owner role)
and will boot. The runtime leak persists until you can fix the deploy
config, but at least staging is up. Investigate why the new
`DATABASE_URL_APP` isn't reaching the container (most likely cause: the
GH env secret `GIVERNANCE_APP_PASSWORD` wasn't set in step 2).

---

## 9. Done criteria

- [ ] `pg_roles` shows `givernance_app` with `rolbypassrls=f`
- [ ] API + worker containers running the post-#430 commit, env shows
      `DATABASE_URL_APP=postgres://givernance_app:…`
- [ ] `tenant_disputes` and `receipt_sequences` both have
      `relrowsecurity=t, relforcerowsecurity=t`
- [ ] Three leaked notification rows from outbox event
      `758e77b9-d154-482a-8b02-62e1de1ee220` removed
- [ ] Manual smoke test in step 7 passes
- [ ] Run `ALTER ROLE givernance NOBYPASSRLS` is **not** in this
      runbook — the owner role intentionally keeps BYPASSRLS for
      migrations + legitimate cross-tenant ops. Defence in depth is
      `FORCE RLS` on every tenant-scoped table, which already covers
      the owner.
