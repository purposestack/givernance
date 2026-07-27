# Runbook — Drizzle journal re-spacing: reconcile a long-lived database

> Triage + repair reference for any database that ran `pnpm db:migrate`
> with a journal whose `when` values were later rewritten (typically
> during a rebase). First incident: the `feat/multi-currency-adr-031`
> rebase of 2026-07-21 re-spaced the branch journal; the local dev DB
> hit both failure modes on 2026-07-27 and was reconciled by hand using
> the procedure below.

## Why `when` values are a durable contract

Drizzle's migrator (verified against the pinned drizzle-orm 0.45.2 /
drizzle-kit 0.31.10 — `pg-core/dialect.cjs → migrate()`):

1. Reads `migrations/meta/_journal.json` and, per entry, the matching
   `<tag>.sql` (sha256 of the raw file content becomes the `hash`).
2. Queries **one row**: `SELECT id, hash, created_at FROM
   drizzle.__drizzle_migrations ORDER BY created_at DESC LIMIT 1`.
3. Applies exactly the entries with `when > max(created_at)`, in
   journal-array order, inside a **single transaction**, inserting
   `(hash, when)` as it goes.

Two consequences that make re-spacing dangerous:

- **Hashes are recorded but never compared.** The only thing linking a
  DB to the journal is the set of recorded `created_at` values vs the
  current `when` values.
- **`max(created_at)` is a high-water mark, not a set.** Moving shipped
  entries above it re-applies them; moving unapplied entries below it
  silently skips them forever.

## Failure signatures

After a rebase re-spaces the journal, a DB that migrated pre-rebase
shows one or both of:

- **(a) Skipped-but-never-ran** — entries whose `when` dropped below the
  DB's high-water mark are treated as applied. Nothing fails at migrate
  time; the app later blows up with `42703 column … does not exist` (or
  a missing table/enum) the first time the schema gap is touched.
- **(b) Re-apply abort** — entries whose `when` rose above the
  high-water mark run again against objects that already exist:
  `ERROR: relation "…" already exists (42P07)` (or `42710` for
  enums/roles). The whole run rolls back — repeated `db:migrate`
  attempts fail identically but leave no partial state.

## Am I affected? (diagnosis)

Run from the repo root of the **checked-out branch** whose journal the
DB will migrate with. For staging, run the psql step through kamal
(`bundle exec kamal app exec -c config/deploy-staging.yml --reuse …`)
or SSH + `docker exec` as in
[feature-flag-rollback.md](feature-flag-rollback.md).

```bash
# 1. Dump what the DB has recorded
docker exec -i givernance-postgres-1 \
  psql -U givernance -d givernance -t -A \
  -c "SELECT hash || ' ' || created_at FROM drizzle.__drizzle_migrations ORDER BY created_at" \
  > /tmp/db-migrations.txt

# 2. Compare against the checked-out journal
python3 - <<'EOF'
import hashlib, json, pathlib
mig = pathlib.Path("packages/api/migrations")
journal = json.load(open(mig / "meta/_journal.json"))
db_hashes: set[str] = set()
db_whens: list[int] = []
for line in open("/tmp/db-migrations.txt"):
    h, w = line.split()
    db_hashes.add(h); db_whens.append(int(w))
high_water = max(db_whens) if db_whens else 0
clean = True
for e in journal["entries"]:
    sha = hashlib.sha256((mig / f"{e['tag']}.sql").read_bytes()).hexdigest()
    applied, will_apply = sha in db_hashes, e["when"] > high_water
    if not applied and not will_apply:
        clean = False
        print(f"(a) SKIPPED-NEVER-RAN : {e['tag']}  (when={e['when']} <= high-water {high_water})")
    if applied and will_apply:
        clean = False
        print(f"(b) WILL-RE-APPLY     : {e['tag']}  (when={e['when']} > high-water {high_water})")
        print(f"    INSERT INTO drizzle.__drizzle_migrations (hash, created_at) VALUES ('{sha}', {e['when']});")
print("CLEAN — journal and DB are consistent." if clean else "\nNOT CLEAN — reconcile before the next db:migrate.")
EOF
```

Caveat: "applied" is detected by content hash. A `.sql` file **edited
after** it was applied shows up as a false-positive `(a)` — check
`git log -p` on the file before believing it.

## Reconcile

Order matters: fix `(a)` first (schema gaps), then `(b)` (bookkeeping),
then prove convergence.

1. **Hand-apply every `(a)` file, in journal order.** The
   `--> statement-breakpoint` lines are `--`-comments to psql, so the
   files pipe straight through:

   ```bash
   docker exec -i givernance-postgres-1 \
     psql -U givernance -d givernance -v ON_ERROR_STOP=1 \
     < packages/api/migrations/0086_custom_field_definitions.sql
   ```

   Repeat per file. If a statement fails because a *previous* partial
   attempt already created some objects, resolve statement-by-statement
   — never `DROP` your way out on a shared environment.

2. **Register every `(b)` entry as applied.** The diagnosis script
   already printed exact `INSERT` statements (correct sha256 + the
   *new* `when`). Paste them into psql. This raises the high-water mark
   past the re-spaced entries so drizzle stops trying to re-run them.
   Stale rows from the pre-rebase run can stay — only the max matters,
   but they're useful forensics for "what did this DB actually run".

3. **Prove convergence:**

   ```bash
   pnpm --filter @givernance/api run db:migrate   # must apply nothing, exit 0
   ```

   Re-run the diagnosis script — it must print `CLEAN`. Then boot the
   API/tests against the DB to confirm no `(a)` gap was missed.

## Prevention (do this instead, next time)

- **Never re-space entries that any long-lived DB has migrated.** When
  a rebase conflicts on `_journal.json`: keep main's entries byte-for-
  byte (main's `when`s are staging's contract), and move **your**
  branch entries after main's max `when` (+10 000 000 000 spacing per
  CLAUDE.md). Your branch's dev DBs then need this runbook — that
  trade is correct; breaking staging is not.
- **The baseline guard** in
  [`migrations-journal-parity.test.ts`](../../packages/api/src/tests/integration/migrations-journal-parity.test.ts)
  fails CI whenever the journal diverges from
  `migrations/meta/_journal.baseline.json` other than by pure appends.
  After adding a migration (or completing a legitimate rebase
  resolution), refresh it:

  ```bash
  pnpm --filter @givernance/api run db:journal:baseline
  ```

  If the baseline diff shows **changed `when` on existing entries**,
  that is a re-spacing — reconcile affected DBs (this runbook) before
  refreshing.

## Which environments can be affected — 2026-07-27 audit

Checked after the first incident; re-verify the deploy-run evidence if
you're reading this during a new incident.

| Environment | Verdict | Evidence |
|---|---|---|
| Staging | **Not affected** | Migrates only via `deploy-staging.yml` (`kamal app exec … db:migrate`). Every run since the multi-currency branch existed is a `push` from `main`; the last non-main `workflow_dispatch` deploy was 2026-05-13, months before the branch. Main's own `0086`–`0090` `when`s were never rewritten after landing (2026-07-21) and staging deployed green through 2026-07-24. |
| Production | **Does not exist yet** | `launch-prod.md` journal unfilled; no prod kamal config / workflow in the repo. |
| CI | **Immune** | Fresh Postgres per run; no recorded history to contradict. |
| Dev machines / forks | **Case-by-case** | Any long-lived DB that ran `db:migrate` while on `feat/multi-currency-adr-031` before 2026-07-21 has the signature. The 2026-07-27 local dev DB was reconciled with this procedure. |

Re-verification one-liner for the staging claim:

```bash
gh run list --workflow=deploy-staging.yml --limit 50 --json headBranch,event,createdAt,conclusion
```

## Related

- [CLAUDE.md → "Drizzle migrations: journal must stay in sync"](../../CLAUDE.md) —
  the base rule (journal registration, rebase checklist, `when` spacing).
- [`packages/api/src/tests/integration/migrations-journal-parity.test.ts`](../../packages/api/src/tests/integration/migrations-journal-parity.test.ts) —
  parity + baseline guards; header documents the incident mechanics.
- [feature-flag-rollback.md](feature-flag-rollback.md) — the
  psql-access pattern reused by the diagnosis step.
