-- Migration: 0018_rls_org_id_function
-- Introduces app_current_organization_id() as a stable SQL function that
-- reads app.current_organization_id from the session GUC. All tenant_isolation
-- RLS policies are replaced to call this function, centralising the GUC name
-- so future renames only require touching this migration.
--
-- The GUC is renamed from app.current_org_id to app.current_organization_id
-- for clarity and consistency. The application's withTenantContext /
-- withWorkerContext helpers are updated in the same commit.

-- ─── Helper function ─────────────────────────────────────────────────────────

CREATE FUNCTION app_current_organization_id()
RETURNS uuid
LANGUAGE sql
STABLE
AS $$
  SELECT current_setting('app.current_organization_id', true)::uuid
$$;

-- ─── Replace RLS policies ────────────────────────────────────────────────────

DROP POLICY tenant_isolation ON users;
CREATE POLICY tenant_isolation ON users
  USING (org_id = app_current_organization_id());

DROP POLICY tenant_isolation ON invitations;
CREATE POLICY tenant_isolation ON invitations
  USING (org_id = app_current_organization_id());

DROP POLICY tenant_isolation ON audit_logs;
CREATE POLICY tenant_isolation ON audit_logs
  USING (org_id = app_current_organization_id());

DROP POLICY tenant_isolation ON constituents;
CREATE POLICY tenant_isolation ON constituents
  USING (org_id = app_current_organization_id());

DROP POLICY tenant_isolation ON donations;
CREATE POLICY tenant_isolation ON donations
  USING (org_id = app_current_organization_id());

DROP POLICY tenant_isolation ON outbox_events;
CREATE POLICY tenant_isolation ON outbox_events
  USING (tenant_id = app_current_organization_id());

DROP POLICY tenant_isolation ON funds;
CREATE POLICY tenant_isolation ON funds
  USING (org_id = app_current_organization_id());

DROP POLICY tenant_isolation ON donation_allocations;
CREATE POLICY tenant_isolation ON donation_allocations
  USING (org_id = app_current_organization_id());

DROP POLICY tenant_isolation ON pledges;
CREATE POLICY tenant_isolation ON pledges
  USING (org_id = app_current_organization_id());

DROP POLICY tenant_isolation ON pledge_installments;
CREATE POLICY tenant_isolation ON pledge_installments
  USING (org_id = app_current_organization_id());

DROP POLICY tenant_isolation ON receipts;
CREATE POLICY tenant_isolation ON receipts
  USING (org_id = app_current_organization_id());

DROP POLICY tenant_isolation ON campaigns;
CREATE POLICY tenant_isolation ON campaigns
  USING (org_id = app_current_organization_id());

DROP POLICY tenant_isolation ON campaign_documents;
CREATE POLICY tenant_isolation ON campaign_documents
  USING (org_id = app_current_organization_id());

DROP POLICY tenant_isolation ON campaign_qr_codes;
CREATE POLICY tenant_isolation ON campaign_qr_codes
  USING (org_id = app_current_organization_id());

DROP POLICY tenant_isolation ON campaign_public_pages;
CREATE POLICY tenant_isolation ON campaign_public_pages
  USING (org_id = app_current_organization_id());
