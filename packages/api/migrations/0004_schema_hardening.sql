-- Migration: 0004_schema_hardening
-- Fixes: FKs on constituents/donations org_id, UNIQUE on users(org_id, email),
--        FK on audit_logs.org_id, RLS policies, audit immutability trigger

-- ─── Foreign Keys (M4, m1) ──────────────────────────────────────────────────

ALTER TABLE constituents
  ADD CONSTRAINT constituents_org_id_fk FOREIGN KEY (org_id) REFERENCES tenants(id) ON DELETE CASCADE;

ALTER TABLE donations
  ADD CONSTRAINT donations_org_id_fk FOREIGN KEY (org_id) REFERENCES tenants(id) ON DELETE CASCADE;

ALTER TABLE audit_logs
  ADD CONSTRAINT audit_logs_org_id_fk FOREIGN KEY (org_id) REFERENCES tenants(id) ON DELETE RESTRICT;

-- ─── Unique Constraint (M7) ─────────────────────────────────────────────────

ALTER TABLE users
  ADD CONSTRAINT users_org_id_email_uniq UNIQUE (org_id, email);

-- ─── Row-Level Security (C2) ────────────────────────────────────────────────
-- Enable RLS and create tenant isolation policies.
-- The app sets app.current_org_id via set_config() per request (see plugins/rls.ts).

ALTER TABLE users ENABLE ROW LEVEL SECURITY;
ALTER TABLE invitations ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE constituents ENABLE ROW LEVEL SECURITY;
ALTER TABLE donations ENABLE ROW LEVEL SECURITY;
ALTER TABLE outbox_events ENABLE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON users
  USING (org_id = current_setting('app.current_org_id', true)::UUID);
CREATE POLICY tenant_isolation ON invitations
  USING (org_id = current_setting('app.current_org_id', true)::UUID);
CREATE POLICY tenant_isolation ON audit_logs
  USING (org_id = current_setting('app.current_org_id', true)::UUID);
CREATE POLICY tenant_isolation ON constituents
  USING (org_id = current_setting('app.current_org_id', true)::UUID);
CREATE POLICY tenant_isolation ON donations
  USING (org_id = current_setting('app.current_org_id', true)::UUID);
CREATE POLICY tenant_isolation ON outbox_events
  USING (tenant_id = current_setting('app.current_org_id', true)::UUID);

-- Allow the application role to bypass RLS (the app user manages all tenants).
-- RLS only applies to connections that have the GUC set.
-- The superuser/owner bypasses RLS by default; for the app role we set it explicitly.
-- In production, use a restricted role. For Phase 0 dev, the owner role bypasses RLS.

-- ─── Audit Log Immutability (m11) ───────────────────────────────────────────
-- Prevent UPDATE or DELETE on audit_logs — GDPR Art. 5(2) accountability.

CREATE OR REPLACE FUNCTION prevent_audit_log_mutation() RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'audit_logs table is immutable — UPDATE and DELETE are not permitted';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER audit_logs_immutable
  BEFORE UPDATE OR DELETE ON audit_logs
  FOR EACH ROW EXECUTE FUNCTION prevent_audit_log_mutation();
