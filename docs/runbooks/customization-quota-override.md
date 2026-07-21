# Runbook — grant a customization quota override (Epic #539)

> Related: [`docs/35-customization.md`](../35-customization.md) §5 · schema: [`packages/shared/src/schema/customization.ts`](../../packages/shared/src/schema/customization.ts) · migration `0087_customization_supporting_tables.sql`

## When to use this

A tenant on plan quotas (fields-per-domain / options-per-picklist / projected-fields) needs a sales-approved raise **beyond its plan but never beyond the platform ceiling** (50 / 100 / 5 — the effective quota is clamped server-side, so an over-ceiling row is inert, not dangerous). In Phases 1–2 there is **no super-admin endpoint** for this; the write path is this runbook, run with the owner role (`givernance_app` has SELECT-only on the table by design — migration 0087 revokes its write bits).

Overrides only ever **raise**: a row below the plan quota is ignored (`Math.max` in `getEffectiveQuotas`), so revoking an expired exception can never push a tenant below its plan.

## Preconditions

- Written sales/CSM approval naming the tenant, the quota, the value, and the business reason. The `reason` column is `NOT NULL` — this is the paper trail; don't launder it into "requested by sales".
- The tenant's `org_id` (UUID) from the Back Office.
- `quota_key` is one of: `fields_per_domain` · `options_per_picklist` · `show_on_related_fields` (DB CHECK enforces the set).

## Procedure

Steps 2–5 run inside **one transaction**: the audit row (step 3) is **mandatory and written BEFORE the override row** — an override with no `audit_logs` trail is a review-blocking gap (every endpoint-written mutation gets one automatically; this runbook is the endpoint's stand-in until it ships, so it must produce the same trail). If you cannot write the audit row, do not write the override.

1. SSH the environment host and open a psql session **as the owner role** (`givernance`, not `givernance_app`) — see `docs/dev/staging-secrets-setup.md` for connection material.
2. Open the transaction and mint the override row's id up front (the audit row references it):

   ```sql
   BEGIN;
   SELECT gen_random_uuid() AS override_id \gset
   ```

3. **REQUIRED — write the audit row first.** Metadata only: quota key, numeric limit, domain, expiry, ticket reference. Counts/ids/keys only — never tenant field labels or stored custom values:

   ```sql
   INSERT INTO audit_logs
     (org_id, user_id, actor_id, action, resource_type, resource_id, new_values)
   VALUES
     ('<org-uuid>',
      '<your keycloak sub>',
      '<your keycloak sub>',
      'custom_field.quota_override_set',
      'customization_quota_override',
      :'override_id',
      jsonb_build_object(
        'quotaKey',  'fields_per_domain',
        'domain',    'constituent',          -- or NULL for an all-domain raise
        'value',     40,
        'expiresAt', (now() + interval '1 year')::text,
        'ticketRef', '<ticket/CRM ref>'
      )
     );
   ```

4. Insert the override under the same pre-minted id (example: raise constituent fields to 40 for one year):

   ```sql
   INSERT INTO customization_quota_overrides
     (id, org_id, domain, quota_key, value, reason, set_by, expires_at)
   VALUES
     (:'override_id',
      '<org-uuid>',
      'constituent',            -- or NULL for an all-domain raise
      'fields_per_domain',
      40,
      'Sales exception <ticket/CRM ref>: <one-line business reason>',
      '<your keycloak sub>',
      now() + interval '1 year' -- or NULL for permanent-until-revoked
     );
   ```

5. `COMMIT;` — the transaction guarantees override and audit row land together or not at all.
6. Verify the effective quota took: as the tenant admin (or via impersonation), open `/settings/custom-fields` — the quota meter reflects the raise on the next request (`getEffectiveQuotas` reads live; no cache to flush).
7. Record the grant in the sales ticket with the override id (`:override_id`).

## Revoking

Same discipline — audit row first, in the same transaction:

```sql
BEGIN;
INSERT INTO audit_logs (org_id, user_id, actor_id, action, resource_type, resource_id)
VALUES ('<org-uuid>', '<your keycloak sub>', '<your keycloak sub>',
        'custom_field.quota_override_revoked', 'customization_quota_override', '<row-uuid>');
DELETE FROM customization_quota_overrides WHERE id = '<row-uuid>';
COMMIT;
```

— or let `expires_at` lapse (no audit row needed; the grant's own audit row already records the expiry). Existing definitions above the restored quota are **not** deleted; the tenant simply can't create more until back under the limit (the same rule as archived-field restores).

## Post-mortem note

This runbook exists because the Phase 1–2 wedge deliberately deferred the super-admin endpoint (reason-mandatory body + `customization_quota_override.granted` audit row + RBAC/flag tests). When that endpoint ships, retire this runbook.
