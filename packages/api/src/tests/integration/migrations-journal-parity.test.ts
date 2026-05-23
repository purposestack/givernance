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
 */

import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const __dirname = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = join(__dirname, "..", "..", "..", "migrations");
const JOURNAL_PATH = join(MIGRATIONS_DIR, "meta", "_journal.json");

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
