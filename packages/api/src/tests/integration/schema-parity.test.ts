/**
 * Issue #261 — Drizzle ↔ SQL parity guard.
 *
 * Drizzle Kit cannot model partial indexes today, so the source of
 * truth for `WHERE deleted_at IS NULL` partial-unique constraints lives
 * in the hand-written SQL migrations (0032 for `users`, 0034 for
 * `platform_admins`). The Drizzle schema declares unconditional
 * `unique()` only for the type-side query-builder parity — Drizzle's
 * understanding of these tables is intentionally lossier than the SQL.
 *
 * Two failure modes this test catches:
 *
 * 1. A future migration drops a partial-unique index and replaces it
 *    with an unconditional one. The Drizzle schema still says "unique",
 *    so type-level assertions stay green; the soft-delete-then-re-bind
 *    flow regresses silently in prod (a re-issued email collides with
 *    the row of an offboarded user).
 *
 * 2. A new soft-deleted table is added without the matching partial-
 *    unique pattern. Same regression, new shape.
 *
 * The test introspects `pg_indexes.indexdef` after migrations apply and
 * pins:
 *   - the index name (so a rename is loud);
 *   - the `WHERE (deleted_at IS NULL)` predicate (the actual canary);
 *   - the unique flag (read from `pg_class.relkind` via a JOIN).
 *
 * If Drizzle Kit ever ships partial-index support, this guard is still
 * the right primitive — it pins the runtime invariant, not the dev-
 * tooling behaviour. (See data-architect M1/M2 from PR #253 review.)
 */

import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { systemDb } from "../../lib/db.js";

interface IndexProbe {
  table: string;
  index: string;
  /**
   * Substring that MUST appear inside `pg_indexes.indexdef`. We don't
   * lock the full DDL string because Postgres re-formats it (column
   * order, schema-qualification, capitalisation) — matching on the
   * load-bearing predicate fragment is enough to catch a regression
   * without false-positiving on cosmetic re-formats.
   */
  expectInDef: string;
  /** When true, the index must also be `is_unique`. */
  unique: boolean;
}

const PARTIAL_UNIQUE_PROBES: IndexProbe[] = [
  // ─── users (ADR-021) ────────────────────────────────────────────────
  {
    table: "users",
    index: "users_org_id_email_active_uniq",
    expectInDef: "deleted_at IS NULL",
    unique: true,
  },

  // ─── platform_admins (ADR-022) ──────────────────────────────────────
  {
    table: "platform_admins",
    index: "platform_admins_keycloak_id_active_uniq",
    expectInDef: "deleted_at IS NULL",
    unique: true,
  },
  {
    table: "platform_admins",
    index: "platform_admins_email_active_uniq",
    expectInDef: "deleted_at IS NULL",
    unique: true,
  },
];

const SORT_INDEX_PROBES: IndexProbe[] = [
  // ─── platform_admins sort indexes (migration 0036, issue #255) ──────
  // Active-only partials so the index size tracks active rows, not
  // ever-growing audit history. Names locked because the list endpoint
  // depends on the planner picking the right one for ORDER BY.
  {
    table: "platform_admins",
    index: "platform_admins_last_name_active_idx",
    expectInDef: "deleted_at IS NULL",
    unique: false,
  },
  {
    table: "platform_admins",
    index: "platform_admins_created_at_active_idx",
    expectInDef: "deleted_at IS NULL",
    unique: false,
  },
  {
    table: "platform_admins",
    index: "platform_admins_last_login_at_active_idx",
    expectInDef: "deleted_at IS NULL",
    unique: false,
  },
];

describe("Drizzle ↔ SQL schema parity (issue #261)", () => {
  beforeAll(async () => {
    // No fixture work — we read pg_indexes directly. Migrations have
    // already run as part of `pnpm db:migrate` in the CI step that
    // precedes `pnpm test` (see `.github/workflows/ci.yml`).
  });

  afterAll(async () => {
    // No teardown — read-only test.
  });

  describe("partial-unique invariant", () => {
    it.each(
      PARTIAL_UNIQUE_PROBES,
    )("$table.$index is unique + partial on `deleted_at IS NULL`", async (probe) => {
      const rows = await systemDb.execute<{
        indexdef: string;
        is_unique: boolean;
      }>(sql`
          SELECT
            i.indexdef,
            ix.indisunique AS is_unique
          FROM pg_indexes i
          JOIN pg_class c   ON c.relname = i.indexname
          JOIN pg_index ix  ON ix.indexrelid = c.oid
          WHERE i.schemaname = 'public'
            AND i.tablename  = ${probe.table}
            AND i.indexname  = ${probe.index}
        `);

      expect(rows.rows.length, `index ${probe.table}.${probe.index} not found`).toBe(1);
      const row = rows.rows[0]!;
      expect(
        row.indexdef,
        `index ${probe.index} is missing the partial predicate; full DDL: ${row.indexdef}`,
      ).toContain(probe.expectInDef);
      expect(row.is_unique, `index ${probe.index} must be UNIQUE`).toBe(probe.unique);
    });
  });

  describe("sort-column index invariant (migration 0036)", () => {
    it.each(
      SORT_INDEX_PROBES,
    )("$table.$index exists with the partial predicate (planner uses it for the list endpoint's ORDER BY)", async (probe) => {
      const rows = await systemDb.execute<{
        indexdef: string;
        is_unique: boolean;
      }>(sql`
          SELECT
            i.indexdef,
            ix.indisunique AS is_unique
          FROM pg_indexes i
          JOIN pg_class c   ON c.relname = i.indexname
          JOIN pg_index ix  ON ix.indexrelid = c.oid
          WHERE i.schemaname = 'public'
            AND i.tablename  = ${probe.table}
            AND i.indexname  = ${probe.index}
        `);

      expect(rows.rows.length, `index ${probe.table}.${probe.index} not found`).toBe(1);
      const row = rows.rows[0]!;
      expect(row.indexdef).toContain(probe.expectInDef);
      expect(row.is_unique).toBe(probe.unique);
    });
  });

  describe("structural lock — no unconditional unique slips onto a soft-deleted table", () => {
    it("every non-PK unique index on a soft-deleted table is either gated on `deleted_at IS NULL` or carries a documented rationale predicate", async () => {
      // The bug we're guarding against: a future migration adds a
      // unique constraint on a soft-deleted table without the `WHERE
      // deleted_at IS NULL` predicate. The first soft-delete-then-
      // re-bind regresses silently in prod (a re-issued email
      // collides with the offboarded row).
      //
      // The query below finds non-PK unique indexes on soft-deleted
      // tables whose `indexdef` doesn't mention either `deleted_at IS
      // NULL` (the canonical pattern) OR a different predicate (which
      // means an explicit decision was taken — documented in the
      // EXPECTED_PREDICATE_OVERRIDES allow-list below).
      //
      // Tables with NO non-PK unique (e.g. `constituents` — same NPO
      // can have two contacts with the same email) don't show up
      // here at all; this lock targets the unique-constraint shape,
      // not the existence of soft-delete itself.
      const rows = await systemDb.execute<{
        tablename: string;
        indexname: string;
        indexdef: string;
      }>(sql`
        SELECT i.tablename, i.indexname, i.indexdef
        FROM pg_indexes i
        JOIN pg_class c   ON c.relname = i.indexname
        JOIN pg_index ix  ON ix.indexrelid = c.oid
        WHERE i.schemaname = 'public'
          AND ix.indisunique = true
          AND ix.indisprimary = false
          AND i.tablename IN (
            SELECT table_name
            FROM information_schema.columns
            WHERE table_schema = 'public'
              AND column_name = 'deleted_at'
          )
        ORDER BY i.tablename, i.indexname
      `);

      // Indexes whose predicate is intentionally NOT
      // \`deleted_at IS NULL\`. Every entry MUST come with a rationale
      // — these are the carve-outs reviewers will scan first when an
      // unfamiliar unique constraint shows up on a soft-deleted table.
      const EXPECTED_PREDICATE_OVERRIDES = new Map<string, { predicate: string; reason: string }>([
        [
          // Only one first-admin per org; the invariant must hold
          // across active + soft-deleted rows so a soft-deleted first
          // admin still blocks a duplicate from being marked as the
          // first admin (the audit / ownership story depends on it).
          // Adding \`AND deleted_at IS NULL\` here would let two rows
          // claim first-admin if one is later soft-deleted — that's
          // the bug, not the fix.
          "users_one_first_admin_per_org",
          { predicate: "first_admin = true", reason: "ADR-021 ownership invariant" },
        ],
        [
          // Issue #326 / migration 0046: at most one non-terminal
          // resume per parent — prevents two concurrent Resume clicks
          // from each inserting a child row that fans out to the same
          // remaining recipients (PR #352 review H1). Soft-deleted
          // resume rows are still a "used" slot semantically: a
          // tenant must explicitly mark the row terminal (or wait for
          // the worker to do so) before they can spawn another active
          // resume, otherwise the soft-delete becomes a backdoor that
          // lets two concurrent in-flight resumes coexist. Predicate
          // is therefore status-based, not deleted_at-based.
          "bulk_email_jobs_one_active_resume_per_parent",
          {
            predicate:
              "(parent_job_id IS NOT NULL) AND (status = ANY (ARRAY['pending'::bulk_email_job_status, 'processing'::bulk_email_job_status]))",
            reason:
              "ADR-021 + issue #326 — non-terminal status, not deleted_at, is the right gate for resume uniqueness",
          },
        ],
        [
          // Epic #363 / migration 0055: the (outbox_event_id, user_id,
          // type) natural key intentionally spans soft-deleted rows.
          // Semantic: once a user dismisses (soft-deletes) a
          // notification, a later outbox redelivery must NOT resurrect
          // a new row for the same recipient — they've explicitly
          // chosen not to see this event again. Adding `WHERE
          // deleted_at IS NULL` would turn dismissal into a backdoor
          // that lets the same event reappear in the panel on every
          // relay retry.
          "notifications_outbox_recipient_type_unique",
          {
            // Match the column list rather than a predicate — this
            // index intentionally has NO `WHERE` clause.
            predicate: "(outbox_event_id, user_id, type)",
            reason:
              "Epic #363 — idempotency key spans active + dismissed rows so an outbox redelivery doesn't resurrect a dismissed notification (PR #393 Worker SRE CRIT-1 fix)",
          },
        ],
      ]);

      const offenders: string[] = [];
      for (const row of rows.rows) {
        if (row.indexdef.includes("WHERE (deleted_at IS NULL)")) continue;
        if (row.indexdef.includes("WHERE ((deleted_at IS NULL)")) continue;
        const override = EXPECTED_PREDICATE_OVERRIDES.get(row.indexname);
        if (override && row.indexdef.includes(override.predicate)) continue;
        offenders.push(`${row.tablename}.${row.indexname} → ${row.indexdef}`);
      }

      expect(
        offenders,
        `non-PK unique indexes on soft-deleted tables that are neither partial on \`deleted_at IS NULL\` nor in the override allow-list:\n  ${offenders.join("\n  ")}\n\nSoft-delete + re-bind requires the partial-unique pattern (ADR-021); see migration 0032 for the canonical shape. If this index intentionally spans active + soft-deleted rows, add it to EXPECTED_PREDICATE_OVERRIDES with a rationale.`,
      ).toEqual([]);
    });
  });
});
