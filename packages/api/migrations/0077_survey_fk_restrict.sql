-- Migration: 0077_survey_fk_restrict (Epic #434 security-architect SHOULD-FIX)
--
-- Switch `survey_invitations.org_id` and `survey_responses.org_id` from
-- ON DELETE CASCADE to ON DELETE RESTRICT.
--
-- Why: per CLAUDE.md "Soft-delete is universal across Givernance" and the
-- universal-tracability rule, raw cascade on PII tables defeats the audit
-- trail. A tenant erasure must flow through the explicit worker cascade
-- (ADR-021) which emits one `audit_logs` row per deleted record, not via
-- a silent PG-level cascade that leaves no trace of what was destroyed.
--
-- `invitation_id` cascade on `survey_responses` is intentionally KEPT —
-- it's a thin wrapper to the same audit cascade (the worker logs the
-- invitation deletion, and the response disappears as part of the same
-- transactional unit). The worker is responsible for emitting audit
-- rows for both sides before the invitation row is deleted.

ALTER TABLE survey_invitations
  DROP CONSTRAINT survey_invitations_org_id_fkey,
  ADD CONSTRAINT survey_invitations_org_id_fkey
    FOREIGN KEY (org_id) REFERENCES tenants(id) ON DELETE RESTRICT;

ALTER TABLE survey_responses
  DROP CONSTRAINT survey_responses_org_id_fkey,
  ADD CONSTRAINT survey_responses_org_id_fkey
    FOREIGN KEY (org_id) REFERENCES tenants(id) ON DELETE RESTRICT;
