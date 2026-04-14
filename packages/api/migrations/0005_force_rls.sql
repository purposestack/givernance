-- Migration: 0005_force_rls
-- Fixes: FORCE ROW LEVEL SECURITY on all tables with tenant_isolation policies.
-- Without FORCE, the table owner role (givernance) bypasses RLS entirely,
-- making tenant isolation ineffective for the application's own queries.

ALTER TABLE users FORCE ROW LEVEL SECURITY;
ALTER TABLE audit_logs FORCE ROW LEVEL SECURITY;
ALTER TABLE constituents FORCE ROW LEVEL SECURITY;
ALTER TABLE donations FORCE ROW LEVEL SECURITY;

-- invitations: FORCE RLS intentionally omitted.
-- The invitation-accept endpoint is unauthenticated — it looks up an invitation by
-- token before the orgId is known.  The existing tenant_isolation policy still
-- applies to non-owner roles; for the owner role, tenant scoping is enforced in
-- application code via withTenantContext() on all authenticated invitation routes.

-- outbox_events: FORCE RLS intentionally omitted.
-- The outbox relay process is a trusted system poller that reads events across ALL
-- tenants (SELECT ... FOR UPDATE SKIP LOCKED).  Forcing RLS would break the relay
-- unless a separate bypass role is created.  Tenant scoping for API-side outbox
-- writes is enforced via withTenantContext() in route handlers.
