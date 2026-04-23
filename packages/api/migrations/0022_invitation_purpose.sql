-- 0022_invitation_purpose.sql
-- Adds `purpose` discriminator to `invitations` to prevent cross-contamination
-- between the team-invite flow and the self-serve signup verification flow
-- (SEC-1 / DATA-3 from the #117 review). Existing rows are back-filled to
-- 'team_invite' (the pre-0021 invite semantics).

ALTER TABLE invitations
    ADD COLUMN IF NOT EXISTS purpose VARCHAR(32) NOT NULL DEFAULT 'team_invite',
    ADD CONSTRAINT invitations_purpose_chk
        CHECK (purpose IN ('team_invite', 'signup_verification'));

CREATE INDEX IF NOT EXISTS invitations_purpose_idx ON invitations (purpose);
