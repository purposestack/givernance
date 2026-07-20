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

1. SSH the environment host and open a psql session **as the owner role** (`givernance`, not `givernance_app`) — see `docs/dev/staging-secrets-setup.md` for connection material.
2. Insert the override (example: raise constituent fields to 40 for one year):

   ```sql
   INSERT INTO customization_quota_overrides
     (org_id, domain, quota_key, value, reason, set_by, expires_at)
   VALUES
     ('<org-uuid>',
      'constituent',            -- or NULL for an all-domain raise
      'fields_per_domain',
      40,
      'Sales exception <ticket/CRM ref>: <one-line business reason>',
      '<your keycloak sub>',
      now() + interval '1 year' -- or NULL for permanent-until-revoked
     );
   ```

3. Verify the effective quota took: as the tenant admin (or via impersonation), open `/settings/custom-fields` — the quota meter reflects the raise on the next request (`getEffectiveQuotas` reads live; no cache to flush).
4. Record the grant in the sales ticket with the row's `id`.

## Revoking

`DELETE FROM customization_quota_overrides WHERE id = '<row-uuid>';` — or let `expires_at` lapse. Existing definitions above the restored quota are **not** deleted; the tenant simply can't create more until back under the limit (the same rule as archived-field restores).

## Post-mortem note

This runbook exists because the Phase 1–2 wedge deliberately deferred the super-admin endpoint (reason-mandatory body + `customization_quota_override.granted` audit row + RBAC/flag tests). When that endpoint ships, retire this runbook.
