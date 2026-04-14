-- Migration: 0012_force_rls
-- Adds FORCE ROW LEVEL SECURITY to all tenant-scoped tables that were missing it.
-- FORCE ensures RLS policies apply even to table owners, preventing accidental
-- bypasses when the owner role is used directly.

ALTER TABLE users FORCE ROW LEVEL SECURITY;
ALTER TABLE invitations FORCE ROW LEVEL SECURITY;
ALTER TABLE audit_logs FORCE ROW LEVEL SECURITY;
ALTER TABLE constituents FORCE ROW LEVEL SECURITY;
ALTER TABLE donations FORCE ROW LEVEL SECURITY;
ALTER TABLE outbox_events FORCE ROW LEVEL SECURITY;
ALTER TABLE funds FORCE ROW LEVEL SECURITY;
ALTER TABLE donation_allocations FORCE ROW LEVEL SECURITY;
ALTER TABLE pledges FORCE ROW LEVEL SECURITY;
ALTER TABLE pledge_installments FORCE ROW LEVEL SECURITY;
ALTER TABLE receipts FORCE ROW LEVEL SECURITY;
