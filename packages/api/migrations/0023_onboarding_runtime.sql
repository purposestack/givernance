-- 0023_onboarding_runtime.sql
-- Runtime layer of the tenant-onboarding milestone (ADR-016 / doc 22 §§3, 5, 6.3).
--
--  * `users.last_visited_at` supports the org picker's "resume where you left off"
--    behaviour and is updated on every successful `switch-org`. Nullable because
--    pre-existing users pre-date the feature; populated on first visit after
--    deploy.
--  * `users.keycloak_id` needs a filtered index to serve `GET /v1/users/me/organizations`
--    (look up every membership by the Keycloak `sub` claim) without scanning
--    the whole table.

ALTER TABLE users
    ADD COLUMN IF NOT EXISTS last_visited_at TIMESTAMPTZ;

-- `keycloak_id` is NULL until a user completes first login. Partial index keeps
-- the write cost bounded and serves the multi-tenant lookup cheaply.
CREATE INDEX IF NOT EXISTS users_keycloak_id_idx
    ON users (keycloak_id)
    WHERE keycloak_id IS NOT NULL;
