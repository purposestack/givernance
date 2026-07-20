-- Migration: 0086_custom_field_definitions (Epic #539; docs/35)
--
-- Per-org custom-field registry — the metadata side of the customization
-- engine. Values live in a `custom` JSONB column on each domain table
-- (migration 0088), never in per-tenant DDL; this table declares what
-- keys exist, their type, and their governance posture (required /
-- filterable / exportable / show_on_related / sensitive).
--
-- Closed enums (Epic #539 §3.1):
--   * `custom_field_domain` — constituent | donation | campaign. `grant`
--     is added additively when the grants domain ships. No custom
--     objects / collections in any form (binding anti-goal #1).
--   * `custom_field_type` — 8 value types, immutable per definition
--     (type change = archive + recreate). Deliberately excludes
--     formula / roll-up / lookup / file / user-reference types.
--
-- Key + options contract:
--   * `key` is the immutable machine identifier (`^[a-z][a-z0-9_]{1,62}$`,
--     CHECK below; RESERVED_KEYS enforcement is service-side). Renames
--     touch `label` only.
--   * `options` embeds picklist options with stable `opt_*` ids —
--     values store ids, never labels, so rename-in-place never rewrites
--     data and merge is the only rewrite operation.
--
-- Soft-archive: `archived_at` hides the definition from forms / filters /
-- columns while values are retained (read-only on detail + exports).
-- The unique constraint is therefore PARTIAL — an archived key can be
-- recreated (archive + recreate is the type-change path).
--
-- CHECK backstops (the API returns the friendly 422s; these keep a
-- buggy code path from persisting an invalid row):
--   * sensitive ⇒ purpose_text present (GDPR Art. 30 record support).
--   * show_on_related ⇒ constituent domain AND NOT sensitive — Art. 9
--     data is structurally ineligible for cross-domain projection.
--
-- FK cascades: `org_id` CASCADE (tenant deletion is total, ADR-021);
-- `created_by` SET NULL (GDPR user erasure never FK-blocks).
--
-- TENANT-SCOPED. RLS enabled + FORCED on `org_id`. Per CLAUDE.md
-- "RLS is the safety net, never the contract" — every API/worker query
-- MUST also carry `eq(customFieldDefinitions.orgId, ctx.orgId)`.

CREATE TYPE custom_field_domain AS ENUM ('constituent', 'donation', 'campaign');

CREATE TYPE custom_field_type AS ENUM (
  'text',
  'long_text',
  'number',
  'date',
  'boolean',
  'picklist',
  'multi_picklist',
  'currency'
);

CREATE TABLE custom_field_definitions (
  id              UUID                PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id          UUID                NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  domain          custom_field_domain NOT NULL,
  key             VARCHAR(63)         NOT NULL,
  label           VARCHAR(120)        NOT NULL,
  description     VARCHAR(500),
  type            custom_field_type   NOT NULL,
  options         JSONB               NOT NULL DEFAULT '[]',
  sort_order      INTEGER             NOT NULL DEFAULT 0,
  required        BOOLEAN             NOT NULL DEFAULT FALSE,
  filterable      BOOLEAN             NOT NULL DEFAULT TRUE,
  exportable      BOOLEAN             NOT NULL DEFAULT TRUE,
  show_on_related BOOLEAN             NOT NULL DEFAULT FALSE,
  sensitive       BOOLEAN             NOT NULL DEFAULT FALSE,
  purpose_text    VARCHAR(500),
  created_by      UUID                REFERENCES users(id) ON DELETE SET NULL,
  archived_at     TIMESTAMPTZ,
  created_at      TIMESTAMPTZ         NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ         NOT NULL DEFAULT NOW(),

  CONSTRAINT custom_field_definitions_key_chk
    CHECK (key ~ '^[a-z][a-z0-9_]{1,62}$'),
  CONSTRAINT custom_field_definitions_purpose_chk
    CHECK (NOT sensitive OR (purpose_text IS NOT NULL AND length(btrim(purpose_text)) > 0)),
  CONSTRAINT custom_field_definitions_show_on_related_chk
    CHECK (NOT show_on_related OR (domain = 'constituent' AND NOT sensitive))
);

-- Partial unique: one ACTIVE definition per (org, domain, key); archived
-- keys can be recreated (type-change path = archive + recreate).
CREATE UNIQUE INDEX custom_field_definitions_org_domain_key_uniq
  ON custom_field_definitions (org_id, domain, key)
  WHERE archived_at IS NULL;

-- Catalog read path: the value-service loads the active defs of one
-- (org × domain) on every cache miss.
CREATE INDEX custom_field_definitions_org_domain_idx
  ON custom_field_definitions (org_id, domain)
  WHERE archived_at IS NULL;

ALTER TABLE custom_field_definitions ENABLE ROW LEVEL SECURITY;
ALTER TABLE custom_field_definitions FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON custom_field_definitions
  USING (org_id = app_current_organization_id());

GRANT SELECT, INSERT, UPDATE, DELETE ON custom_field_definitions TO givernance_app;
