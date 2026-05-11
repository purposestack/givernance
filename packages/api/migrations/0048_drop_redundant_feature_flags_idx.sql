-- 0048 — Drop the redundant `feature_flags_key_idx` index introduced
-- in migration 0047 (PR #352 Platform review Plat-LOW-2a).
--
-- `feature_flags.key` already has a btree index courtesy of the
-- `UNIQUE` constraint. The explicit secondary index is duplicate work
-- on every INSERT and serves no read path the unique-index doesn't
-- already cover (`WHERE key = ?` is satisfied by either).
--
-- Idempotent — `DROP INDEX IF EXISTS` on a missing index is a no-op
-- (fresh checkouts that ran 0047 after this PR landed will already
-- not have the index, courtesy of the migration edit).

DROP INDEX IF EXISTS feature_flags_key_idx;
