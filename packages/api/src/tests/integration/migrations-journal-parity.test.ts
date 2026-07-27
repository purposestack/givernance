/**
 * Drizzle migrations folder ↔ `_journal.json` parity guard.
 *
 * Drizzle Kit's migration runner (`pnpm db:migrate` →
 * `drizzle-kit migrate`) consults `packages/api/migrations/meta/_journal.json`
 * to know which `.sql` files in `packages/api/migrations/` to apply.
 * Adding a file to the folder WITHOUT registering it in the journal is
 * a silent CI break:
 *
 *   1. `pnpm test` locally still passes (the developer applied the
 *      migration by hand via `docker exec psql < …` while iterating).
 *   2. CI's test container starts with an empty Postgres, runs
 *      `pnpm db:migrate`, drizzle-kit silently skips the unregistered
 *      file, and every test that touches the new column / table /
 *      enum / constraint blows up with a 42703-style error.
 *
 * The Epic #363 follow-up (PR #396) hit this gap with
 * `0056_notifications_panel_visible.sql`. This test is the durable
 * regression guard so future hand-written migrations can't ship the
 * same way.
 *
 * The test is pure file-system + JSON: no DB connection, no
 * `withTenantContext`, no fixture wiring. Fast and runs in the same
 * vitest suite as the rest of the API tests so a missed journal entry
 * fails CI BEFORE the integration tests that depend on the schema do.
 *
 * What this test pins:
 *   - Every `NNNN_<name>.sql` file in `migrations/` has a journal
 *     entry with `tag === "NNNN_<name>"`.
 *   - Every journal entry has a matching `.sql` file.
 *   - Journal `idx` values are contiguous (0..N-1, no gaps, no dups).
 *   - Journal `when` values are strictly increasing in `idx` order
 *     (drizzle-kit applies migrations sorted by `when`).
 *   - The journal is APPEND-ONLY relative to the committed baseline
 *     (`meta/_journal.baseline.json`) — see below.
 *
 * ## Why the baseline exists (2026-07-27 re-spacing incident)
 *
 * Drizzle's migrator records each applied entry's `when` as
 * `created_at` in `drizzle.__drizzle_migrations`, then on every later
 * run applies exactly the entries with `when > max(created_at)` —
 * hashes are stored but NEVER compared. So the `when` values are not
 * cosmetic spacing: they are the durable contract with every
 * long-lived database (staging, prod, every dev machine). During the
 * `feat/multi-currency-adr-031` rebase (2026-07-21) the branch's
 * journal was re-spaced: main's `0086`-`0090` kept `when` 1998–2038
 * while the branch's multi-currency entries moved from 1998–2068 up
 * to 2048–2118. Any DB that had migrated with the pre-rebase journal
 * then (a) believed `0086`-`0090` were applied when they never ran and
 * (b) re-applied migrations whose objects already existed, aborting
 * with `already exists`. All four original invariants above hold on a
 * re-spaced journal — only a baseline comparison can catch it.
 *
 * The baseline is a committed mirror of the journal. Three checks:
 *   1. Immutability — every baseline (tag, when) pair appears in the
 *      journal unchanged. A violation means shipped history was
 *      rewritten: STOP, reconcile every long-lived DB first
 *      (docs/runbooks/drizzle-journal-rebase-reconciliation.md),
 *      then refresh the baseline.
 *   2. Append-only — journal entries not in the baseline must sort
 *      after every baseline entry (`when > max(baseline.when)`).
 *   3. Freshness — journal and baseline are identical, so adding a
 *      migration forces a conscious baseline refresh:
 *      `pnpm --filter @givernance/api run db:journal:baseline`
 *      That refresh diff is what makes journal edits VISIBLE in
 *      review; a rebase that silently re-spaces the journal goes red
 *      in CI until someone reads this header.
 *
 * Honest limitation: the baseline is refreshable with one command, so
 * a determined (or hurried) resolver can still mirror a bad re-spacing
 * into both files. The guard's job is to turn a silent foot-gun into
 * an explicit, reviewable act — the runbook it points to explains when
 * refreshing is safe (fresh DBs only) and when it is not.
 *
 * NOT checked:
 *   - Relationship between filename `NNNN` prefix and `idx`.
 *     Migration `0023_multi_currency_schema` and
 *     `0023_onboarding_runtime` share a prefix (legacy parallel-PR
 *     merge); drizzle-kit identifies migrations by `tag`, not prefix,
 *     so both apply correctly. Locking a stricter invariant here
 *     would fail on this legacy pair without catching any new bug.
 *   - `prefix === idx + 1`. The renumber at idx=23 broke that
 *     relationship permanently.
 *   - Actual DB state vs journal (a repo test cannot see a long-lived
 *     database). The runbook's diagnosis script covers that side.
 */

import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const __dirname = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = join(__dirname, "..", "..", "..", "migrations");
const JOURNAL_PATH = join(MIGRATIONS_DIR, "meta", "_journal.json");
// Committed mirror of the journal. Safe to live in `meta/`: drizzle-kit
// only globs `*_snapshot.json` there and reads `_journal.json` by exact
// name (verified against the pinned drizzle-kit 0.31.10).
const BASELINE_PATH = join(MIGRATIONS_DIR, "meta", "_journal.baseline.json");

const REFRESH_CMD = "pnpm --filter @givernance/api run db:journal:baseline";
const RUNBOOK = "docs/runbooks/drizzle-journal-rebase-reconciliation.md";

interface JournalEntry {
  idx: number;
  version: string;
  when: number;
  tag: string;
  breakpoints: boolean;
}

interface Journal {
  version: string;
  dialect: string;
  entries: JournalEntry[];
}

function readJournal(): Journal {
  const raw = readFileSync(JOURNAL_PATH, "utf8");
  return JSON.parse(raw) as Journal;
}

function readBaseline(): Journal {
  const raw = readFileSync(BASELINE_PATH, "utf8");
  return JSON.parse(raw) as Journal;
}

function readSqlFilesSorted(): string[] {
  return readdirSync(MIGRATIONS_DIR)
    .filter((name) => /^\d{4}_.+\.sql$/.test(name))
    .sort();
}

describe("Drizzle migrations: folder ↔ _journal.json parity", () => {
  it("every SQL file is registered in the journal (no orphan migrations)", () => {
    const sqlFiles = readSqlFilesSorted();
    const journal = readJournal();
    const journalTags = new Set(journal.entries.map((e) => e.tag));

    const orphanFiles = sqlFiles.filter((name) => {
      const tag = name.replace(/\.sql$/, "");
      return !journalTags.has(tag);
    });

    expect(orphanFiles, "Add an entry to packages/api/migrations/meta/_journal.json").toEqual([]);
  });

  it("every journal entry has a matching SQL file (no phantom registrations)", () => {
    const sqlFiles = readSqlFilesSorted();
    const journal = readJournal();
    const sqlTags = new Set(sqlFiles.map((name) => name.replace(/\.sql$/, "")));

    const phantomEntries = journal.entries
      .filter((entry) => !sqlTags.has(entry.tag))
      .map((entry) => entry.tag);

    expect(phantomEntries, "Drop the entry or restore the missing .sql file").toEqual([]);
  });

  it("journal idx values are contiguous starting at 0 (no gaps, no dups)", () => {
    const journal = readJournal();
    const indices = journal.entries.map((e) => e.idx).sort((a, b) => a - b);
    const expected = Array.from({ length: indices.length }, (_, i) => i);
    expect(indices).toEqual(expected);
  });

  it("journal `when` is strictly increasing in idx order", () => {
    const journal = readJournal();
    const ordered = [...journal.entries].sort((a, b) => a.idx - b.idx);
    for (let i = 1; i < ordered.length; i++) {
      const prev = ordered[i - 1];
      const curr = ordered[i];
      if (!prev || !curr) continue;
      expect(
        curr.when,
        `Entry idx=${curr.idx} (${curr.tag}) has when=${curr.when}, must be > ${prev.when} (${prev.tag})`,
      ).toBeGreaterThan(prev.when);
    }
  });
});

describe("Drizzle migrations: journal is append-only vs _journal.baseline.json", () => {
  it("baseline entries are immutable — no `when` re-spacing, no removed/renamed tags", () => {
    const journalByTag = new Map(readJournal().entries.map((e) => [e.tag, e]));
    const violations: string[] = [];

    for (const base of readBaseline().entries) {
      const current = journalByTag.get(base.tag);
      if (!current) {
        violations.push(`${base.tag}: present in baseline but missing from the journal`);
      } else if (current.when !== base.when) {
        violations.push(`${base.tag}: when changed ${base.when} -> ${current.when}`);
      }
    }

    expect(
      violations,
      "Shipped journal history was rewritten (typically a rebase re-spacing). " +
        "Every long-lived DB that migrated with the old journal is now inconsistent — " +
        `reconcile them FIRST (${RUNBOOK}), then refresh the baseline with \`${REFRESH_CMD}\`.`,
    ).toEqual([]);
  });

  it("new journal entries sort after every baseline entry (append-only `when`)", () => {
    const baseline = readBaseline();
    const baselineTags = new Set(baseline.entries.map((e) => e.tag));
    const baselineMaxWhen = Math.max(...baseline.entries.map((e) => e.when));

    const misplaced = readJournal()
      .entries.filter((e) => !baselineTags.has(e.tag) && e.when <= baselineMaxWhen)
      .map((e) => `${e.tag} (when=${e.when})`);

    expect(
      misplaced,
      `New migrations must use when > ${baselineMaxWhen} (the baseline max) so already-migrated ` +
        "DBs still pick them up — drizzle only applies entries above the max recorded created_at.",
    ).toEqual([]);
  });

  it("baseline mirrors the journal exactly (refresh it in the same PR as a new migration)", () => {
    const journal = readJournal().entries.map(({ idx, tag, when }) => ({ idx, tag, when }));
    const baseline = readBaseline().entries.map(({ idx, tag, when }) => ({ idx, tag, when }));

    expect(
      baseline,
      `meta/_journal.baseline.json is stale. After adding a migration, refresh it: \`${REFRESH_CMD}\`. ` +
        "If the diff shows CHANGED when values on existing entries instead of pure appends, stop — " +
        `that is a re-spacing; see ${RUNBOOK} before refreshing.`,
    ).toEqual(journal);
  });
});
