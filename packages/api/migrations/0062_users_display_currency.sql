-- Migration 0062: Add display_currency to users (ADR-031 §2.8, Epic #416 Task 7)
--
-- NULL = use the org's baseCurrency as the display currency.
-- When set, the value must match a currency_metadata.code WHERE enabled = true;
-- this is enforced at the API layer (PATCH /v1/users/me returns 422 on invalid
-- values) rather than a FK so soft-disabling a currency does not cascade-break
-- existing user preferences.

ALTER TABLE users
  ADD COLUMN display_currency VARCHAR(3);
