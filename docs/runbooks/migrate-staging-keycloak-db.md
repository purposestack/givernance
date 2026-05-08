# Runbook — Migrate staging Keycloak to its own database (issue #283)

> **One-shot operator task.** Aligns the live staging Postgres with [ADR-017](../adrs/adr-017-one-logical-database-per-tool-isolate-keycloak-from-the-application-db.md) by moving Keycloak's ~95 internal tables out of `givernance_staging` and into a dedicated `givernance_keycloak` database owned by a least-privilege `keycloak` role.
>
> **Pattern.** Blue-green via a *temporary* ghost Keycloak run directly with `docker run` on the kamal Docker network (no Kamal accessory). The live `keycloak` accessory keeps serving `auth.staging.givernance.org` until Step 7. **`auth.staging` downtime ≈ 30 seconds** (a single `kamal accessory reboot keycloak` once `KC_DB_URL` is swapped).
>
> **One-time only.** This runbook runs once, ever; it intentionally lives as paste-able commands rather than a `workflow_dispatch` workflow ([feedback memory](../../.claude — n/a, see PR description)).
>
> **Roadbook contract.** This file is both the plan (forward) AND the operator's journal (backward). The "Journal" and "Post-mortem" sections at the bottom are filled in *during* the run and committed back via the cutover PR — so the merged history shows what was planned and what actually happened, side by side.

---

## Plan

```
                         BEFORE                                  DURING (Steps 2–6)                     AFTER (Steps 7–10)
        ┌────────────────────────────┐               ┌────────────────────────────┐          ┌────────────────────────────┐
        │ givernance-postgres        │               │ givernance-postgres        │          │ givernance-postgres        │
        │ ┌───────────────────────┐  │               │ ┌──────────┐ ┌──────────┐ │          │ ┌──────────┐ ┌──────────┐ │
        │ │ givernance_staging    │  │               │ │ givern.  │ │ givern.  │ │          │ │ givern.  │ │ givern.  │ │
        │ │  - app tables (Drizzle)│  │              │ │ _staging │ │ _keycloak│ │          │ │ _staging │ │ _keycloak│ │
        │ │  - KC tables (~95)    │  │               │ │ app + KC │ │ KC only  │ │          │ │ app only │ │ KC only  │ │
        │ └───────────────────────┘  │               │ └──────────┘ └──────────┘ │          │ └──────────┘ └──────────┘ │
        └─────────────▲──────────────┘               └──────▲──────────────▲─────┘          └──────────────────▲─────────┘
                      │                                     │              │                                   │
        ┌─────────────┴──────────────┐               ┌──────┴───────┐ ┌────┴──────────┐               ┌────────┴──────────┐
        │ keycloak (Kamal accessory) │               │ keycloak     │ │ keycloak     │                │ keycloak (Kamal)  │
        │  KC_DB_URL → _staging       │              │  (Kamal,     │ │  -ghost      │                │  KC_DB_URL →      │
        │  serves auth.staging        │              │   _staging)  │ │  (docker run,│                │   _keycloak       │
        │                            │               │  serves auth │ │   internal)  │                │  serves auth      │
        └────────────────────────────┘               └──────────────┘ └──────────────┘                └───────────────────┘
                                                       (still serving)   (validates                      (one ~30s reboot
                                                                          new DB)                         did the swap)
```

### Pre-flight checklist

- [ ] PR #_____ (this PR — landed `infra/postgres/init/01-init-keycloak-db.sh` into the postgres accessory's `files:` and added `KEYCLOAK_DB_PASSWORD` to `setup-kamal-secrets`) is **merged into `main`** and the resulting `deploy-staging` run is green.
- [ ] You generated a long random `KEYCLOAK_DB_PASSWORD`:
  ```bash
  openssl rand -base64 24
  ```
- [ ] Saved it to the `staging` GitHub Environment:
  ```bash
  gh secret set KEYCLOAK_DB_PASSWORD --env staging --repo purposestack/givernance
  ```
- [ ] Saved it to your team password manager (1Password vault `Givernance · Staging`, item `keycloak DB role`) — **you cannot read it back from GitHub** and Step 2 / Step 7 both need it.
- [ ] Exported the values you'll paste below into your local shell:
  ```bash
  export KEYCLOAK_DB_PASSWORD='...'                              # the value you just generated
  export STAGING_POSTGRES_PASSWORD='...'                         # `gh secret list --env staging` shows POSTGRES_PASSWORD; pull from 1Password
  ```
- [ ] You're on a fresh checkout of `main`, no uncommitted work:
  ```bash
  git fetch origin main && git checkout main && git pull && git status
  ```
- [ ] No deploys in flight: `gh run list --workflow=deploy-staging.yml --limit=1` shows the latest run as `completed/success`.
- [ ] `bundle exec kamal accessory details postgres -c config/deploy-staging.yml` returns `givernance-postgres … running (postgres:17)` — sanity check that the local Kamal can talk to the VPS.
- [ ] You posted a `~30s auth.staging downtime, starting in ~5 min` heads-up in the team channel.

### What we're doing, end-to-end

| Step | What | Where it runs | Reversible? |
|---|---|---|---|
| 1 | Create `keycloak` role + `givernance_keycloak` DB on the live cluster | `ssh` → `docker exec psql` | ✅ `DROP DATABASE` + `DROP ROLE` |
| 2 | Boot a ghost Keycloak via `docker run` on the kamal network, pointed at the new DB | `ssh` → `docker run` | ✅ `docker rm -f givernance-keycloak-ghost` |
| 3 | Wait for ghost ready, capture canonical KC table list from the freshly-Liquibase'd new DB | `ssh` → `docker exec psql` | ✅ no-op |
| 4 | Stop ghost so it doesn't write during the dump | `ssh` → `docker stop` | ✅ |
| 5 | Dump KC tables data-only from `givernance_staging`, restore into `givernance_keycloak`, fix ownership | `ssh` → `docker exec pg_dump`/`psql` | ⚠️ TRUNCATE before restore — the dump file on `/root` is the recovery handle |
| 6 | Restart ghost, validate row counts match source | `ssh` → `docker start` + `psql` | ✅ |
| 7 | **Cutover**: edit `config/deploy-staging.yml` locally, `kamal accessory reboot keycloak` — auth.staging is 502 for ~30s | laptop | ⚠️ revert the file + reboot rolls back |
| 8 | Best-effort non-destructive catch-up sync (writes that landed on the old DB during Steps 5–7) | `ssh` → `docker exec pg_dump`/`psql` | ✅ idempotent (`ON CONFLICT DO NOTHING`) |
| 9 | Stop & remove the ghost docker container | `ssh` → `docker rm -f` | ✅ |
| 10 | Drop KC tables from `givernance_staging` — **point of no return** (rollback requires Step 5 dump) | `ssh` → `docker exec psql` | ❌ recoverable only via dump replay |
| 11 | Push the cutover branch as a PR (the `KC_DB_URL` swap), get it reviewed + merged | laptop | ✅ |

---

## Step 1 — Create the dedicated DB + role

```bash
ssh givernance-staging "docker exec -i -e PGPASSWORD='$STAGING_POSTGRES_PASSWORD' givernance-postgres \
  psql -U givernance -d givernance_staging -v ON_ERROR_STOP=1 \
  -v keycloak_password=\"'$KEYCLOAK_DB_PASSWORD'\"" <<'EOSQL'
SELECT format(
  'CREATE ROLE keycloak WITH LOGIN PASSWORD %L NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS INHERIT',
  :keycloak_password
) AS stmt
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'keycloak') \gexec

SELECT 'CREATE DATABASE givernance_keycloak OWNER keycloak' AS stmt
WHERE NOT EXISTS (SELECT 1 FROM pg_database WHERE datname = 'givernance_keycloak') \gexec

REVOKE ALL ON DATABASE givernance_keycloak FROM PUBLIC;
EOSQL
```

> **`docker exec -i` is load-bearing** on every block in this runbook that pipes SQL via heredoc / `<<<` / a pipe — without `-i`, docker closes stdin and the SQL never reaches psql, which sits idle until the shell heredoc EOF and exits 0 with zero rows changed. Look for "no rows affected" output as the smell.

Then harden the new DB's `public` schema (mirrors `infra/postgres/init/01-init-keycloak-db.sh` Phase 2):

```bash
ssh givernance-staging "docker exec -i -e PGPASSWORD='$STAGING_POSTGRES_PASSWORD' givernance-postgres \
  psql -U givernance -d givernance_keycloak -v ON_ERROR_STOP=1" <<'EOSQL'
REVOKE ALL ON SCHEMA public FROM PUBLIC;
GRANT ALL ON SCHEMA public TO keycloak;
EOSQL
```

Capture the source-side baseline you'll verify against later — record these in the [Journal](#journal-fill-in-during-the-run) at the bottom:

```bash
ssh givernance-staging "docker exec -e PGPASSWORD='$STAGING_POSTGRES_PASSWORD' givernance-postgres \
  psql -U givernance -d givernance_staging -tAc 'SELECT count(*) FROM realm; SELECT count(*) FROM user_entity; SELECT count(*) FROM databasechangelog;'"
```

> **`SRC_REALM` / `SRC_USER` / `SRC_CHANGELOG`** → Journal.

---

## Step 2 — Boot the ghost Keycloak

The ghost runs on the same `kamal` Docker network as the live accessory but is **not** registered with kamal-proxy, so `auth.staging.givernance.org` keeps routing to the live `keycloak` accessory throughout. The image must match the live accessory's image so Liquibase produces the same schema.

```bash
ssh givernance-staging "docker run -d \
  --name givernance-keycloak-ghost \
  --network kamal \
  --restart no \
  -e KC_DB=postgres \
  -e KC_DB_URL=jdbc:postgresql://givernance-postgres:5432/givernance_keycloak \
  -e KC_DB_USERNAME=keycloak \
  -e KC_DB_PASSWORD='$KEYCLOAK_DB_PASSWORD' \
  -e KEYCLOAK_ADMIN=ghost-admin \
  -e KEYCLOAK_ADMIN_PASSWORD=ghost-throwaway-pw \
  -e KC_HOSTNAME_STRICT=false \
  -e KC_HTTP_ENABLED=true \
  -e KC_HEALTH_ENABLED=true \
  ghcr.io/purposestack/givernance-keycloak:latest \
  start-dev"
```

> No `--import-realm` and no realm-import file mounted on purpose: the ghost only needs Liquibase to create the empty schema; the realm rows arrive via the dump in Step 5.

Wait for the ghost to finish Liquibase + open its HTTP port:

```bash
ssh givernance-staging "until docker logs givernance-keycloak-ghost 2>&1 | grep -q 'Listening on:'; do sleep 2; done; echo 'ghost ready'"
```

---

## Step 3 — Confirm Liquibase populated the schema; capture the canonical KC table list

```bash
ssh givernance-staging "docker exec -e PGPASSWORD='$STAGING_POSTGRES_PASSWORD' givernance-postgres \
  psql -U givernance -d givernance_keycloak -tAc 'SELECT count(*) FROM databasechangelog'"
```

> Should equal `SRC_CHANGELOG` (give or take any new Keycloak point-release deltas). Record as **`GHOST_CHANGELOG`** → Journal. If it's 0, the ghost didn't reach Liquibase — `docker logs givernance-keycloak-ghost` and abort.

The ghost's freshly-populated `givernance_keycloak.public` is the authoritative Keycloak table set for *this* image version. Pin it now into a shell array on your laptop (we'll reuse it for both the dump filter and the post-cutover drop):

```bash
KC_TABLES=$(ssh givernance-staging "docker exec -e PGPASSWORD='$STAGING_POSTGRES_PASSWORD' givernance-postgres \
  psql -U givernance -d givernance_keycloak -tAc \"SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename\"")
echo "$KC_TABLES" | wc -l    # ~95 expected
echo "$KC_TABLES" | head -5  # spot-check: realm, user_entity, etc.
```

> Record the count + first 5 tables in Journal as **`KC_TABLE_COUNT`** + **`KC_TABLE_SAMPLE`**.

Build the `pg_dump` filter (one `-t public.<name>` per table):

```bash
DUMP_FILTER=$(echo "$KC_TABLES" | sed 's/^/-t public./' | tr '\n' ' ')
```

---

## Step 4 — Stop the ghost so it doesn't write during the sync

```bash
ssh givernance-staging "docker stop givernance-keycloak-ghost"
```

---

## Step 5 — Initial sync: dump → truncate → restore → fix ownership

> ⚠️ **First destructive moment** (TRUNCATE in `givernance_keycloak`, but that DB only has the empty Liquibase scaffold so far — nothing to lose). The `givernance_staging` side is read-only here.

**Dump KC tables data-only from the live `givernance_staging`:**

```bash
TS=$(date -u +%Y%m%dT%H%M%SZ)
ssh givernance-staging "docker exec -e PGPASSWORD='$STAGING_POSTGRES_PASSWORD' givernance-postgres \
  pg_dump -U givernance -d givernance_staging --data-only --disable-triggers $DUMP_FILTER \
  > /root/kc-data-${TS}.sql"
```

**Sanity-check the dump size** (should be ≥ a few hundred KB on a populated staging realm):

```bash
ssh givernance-staging "wc -c /root/kc-data-${TS}.sql"
```

> Record path + size in Journal as **`DUMP_PATH`** + **`DUMP_BYTES`** — this file is the rollback handle for Step 10.

**Truncate the empty target tables** (one `TRUNCATE … CASCADE` so FK ordering doesn't matter):

```bash
TRUNCATE_LIST=$(echo "$KC_TABLES" | tr '\n' ',' | sed 's/,$//; s/,/, public./g; s/^/public./')
ssh givernance-staging "docker exec -e PGPASSWORD='$STAGING_POSTGRES_PASSWORD' givernance-postgres \
  psql -U givernance -d givernance_keycloak -v ON_ERROR_STOP=1 -c 'TRUNCATE $TRUNCATE_LIST CASCADE'"
```

**Restore.** The dump lives on the VPS host's `/root` (the redirect above happened in the SSH shell, not inside the postgres container), so we pipe it into the container via `docker exec -i`:

```bash
ssh givernance-staging "cat /root/kc-data-${TS}.sql | docker exec -i -e PGPASSWORD='$STAGING_POSTGRES_PASSWORD' givernance-postgres \
  psql -U givernance -d givernance_keycloak -v ON_ERROR_STOP=1"
```

**Transfer table ownership to the `keycloak` role** (the dump created data inside tables that `givernance` owns; flipping the owners makes the least-priv posture audit-visible and matches what a fresh init would produce):

```bash
ssh givernance-staging "docker exec -e PGPASSWORD='$STAGING_POSTGRES_PASSWORD' givernance-postgres \
  psql -U givernance -d givernance_keycloak -tAc \"SELECT 'ALTER TABLE ' || quote_ident(tablename) || ' OWNER TO keycloak;' FROM pg_tables WHERE schemaname='public'\" \
  | docker exec -i -e PGPASSWORD='$STAGING_POSTGRES_PASSWORD' givernance-postgres \
    psql -U givernance -d givernance_keycloak -v ON_ERROR_STOP=1"
ssh givernance-staging "docker exec -e PGPASSWORD='$STAGING_POSTGRES_PASSWORD' givernance-postgres \
  psql -U givernance -d givernance_keycloak -tAc \"SELECT 'ALTER SEQUENCE ' || quote_ident(sequence_name) || ' OWNER TO keycloak;' FROM information_schema.sequences WHERE sequence_schema='public'\" \
  | docker exec -i -e PGPASSWORD='$STAGING_POSTGRES_PASSWORD' givernance-postgres \
    psql -U givernance -d givernance_keycloak -v ON_ERROR_STOP=1"
```

---

## Step 6 — Restart the ghost; validate row counts match

```bash
ssh givernance-staging "docker start givernance-keycloak-ghost"
ssh givernance-staging "until docker logs givernance-keycloak-ghost 2>&1 | tail -50 | grep -q 'Listening on:'; do sleep 2; done"
```

**Spot-check** the ghost can read what we restored:

```bash
ssh givernance-staging "docker exec -e PGPASSWORD='$STAGING_POSTGRES_PASSWORD' givernance-postgres \
  psql -U givernance -d givernance_keycloak -tAc 'SELECT count(*) FROM realm; SELECT count(*) FROM user_entity'"
```

> Should match `SRC_REALM` / `SRC_USER`. Record as **`GHOST_REALM`** / **`GHOST_USER`** → Journal. **If they don't match within ±0, stop here and investigate** — DON'T proceed to Step 7. The ghost is harmless; the live accessory still serves traffic.

**Functional check** — hit the OIDC discovery endpoint from inside the kamal network:

```bash
ssh givernance-staging "docker exec givernance-keycloak-ghost \
  sh -c 'wget -qO- http://localhost:8080/realms/givernance/.well-known/openid-configuration | head -c 200'"
```

> Should print a JSON blob starting with `{"issuer":"https://auth.staging.givernance.org/realms/givernance",…`. If you get an error or empty output, abort and investigate.

---

## Step 7 — Cutover: swap `KC_DB_URL` on the live `keycloak` accessory

> ⚠️ **`auth.staging.givernance.org` returns 502 for ~30 seconds** while the kamal accessory restarts. Time-box this step.

On your laptop, branch off `main` and edit:

```bash
git checkout -b chore/staging-kc-db-cutover
```

Edit `config/deploy-staging.yml` — under `accessories.keycloak.env.clear`, change:

```diff
-        KC_DB_URL: jdbc:postgresql://givernance-postgres:5432/givernance_staging
-        KC_DB_USERNAME: givernance
+        KC_DB_URL: jdbc:postgresql://givernance-postgres:5432/givernance_keycloak
+        KC_DB_USERNAME: keycloak
```

Edit `.github/actions/setup-kamal-secrets/action.yml` — change the `KC_DB_PASSWORD` line in the secrets bag from the postgres bootstrap password to the dedicated KC role password:

```diff
-        KC_DB_PASSWORD=$PG_PASS
+        KC_DB_PASSWORD=$KEYCLOAK_DB_PASS
```

**Don't push yet.** Apply locally first:

```bash
KEYCLOAK_DB_PASSWORD="$KEYCLOAK_DB_PASSWORD" \
  bundle exec kamal accessory reboot keycloak -c config/deploy-staging.yml
```

(Substitute any other staging secrets your local kamal session needs — `POSTGRES_PASSWORD`, etc. — via `gh secret get` or your password manager. The reboot rebuilds `.kamal/secrets` locally via the composite action's logic, but only if the env vars are present at the time of `kamal accessory reboot`.)

Watch the reboot:

```bash
ssh givernance-staging "docker logs --since=30s -f givernance-keycloak"
```

Once you see `Listening on:`, smoke from your laptop:

```bash
curl -fsS https://auth.staging.givernance.org/realms/givernance/.well-known/openid-configuration | jq -r '.issuer, .token_endpoint'
```

> Both lines should print the staging URLs. If you get a 5xx, pause: re-check `docker logs givernance-keycloak`; the most likely cause is a typo in the password env var. Worst case, revert the file edits and re-`kamal accessory reboot keycloak` — the old DB still has all KC tables intact (we haven't dropped yet).

**End-to-end login check** — open `https://staging.givernance.org/login` in a fresh incognito window and log in as `admin@givernance.org`. You should land on `/dashboard` and see seeded data. *Record the result in Journal.*

---

## Step 8 — Catch-up sync (best-effort, non-destructive)

Between Step 5's dump and Step 7's cutover, the live `keycloak` accessory may have written a few rows to the **old** location (sessions, audit events, password counters). Pull them across with `INSERT … ON CONFLICT DO NOTHING`. Acceptable to lose: row updates that landed on the old DB after the dump (e.g. a password change) — only inserts win.

```bash
ssh givernance-staging "docker exec -e PGPASSWORD='$STAGING_POSTGRES_PASSWORD' givernance-postgres \
  pg_dump -U givernance -d givernance_staging --data-only --column-inserts $DUMP_FILTER \
  > /root/kc-catchup-${TS}.sql"
```

Transform the `INSERT … VALUES (…);` statements into `… ON CONFLICT DO NOTHING;`. The regex anchors on the trailing `);` — pg_dump's `--column-inserts` emits one INSERT per line, so single-line `sed` is safe:

```bash
ssh givernance-staging "sed -i.bak -E 's/^(INSERT INTO public\.[^ ]+ \([^)]+\) VALUES \(.*\));$/\1 ON CONFLICT DO NOTHING;/' /root/kc-catchup-${TS}.sql"
```

Apply with `ON_ERROR_STOP=0` so a table without any unique/exclusion constraint (rare in KC; mostly cluster-state tables) doesn't abort the rest. Same `cat … | docker exec -i …` pattern as Step 5's restore — the catch-up dump is on the VPS host, not inside the container:

```bash
ssh givernance-staging "cat /root/kc-catchup-${TS}.sql | docker exec -i -e PGPASSWORD='$STAGING_POSTGRES_PASSWORD' givernance-postgres \
  psql -U givernance -d givernance_keycloak -v ON_ERROR_STOP=0 2>&1 \
  | tail -50"
```

> Look at the tail for `INSERT 0 N` lines (good — N rows recovered) and any `ERROR:` lines. Record an aggregate in Journal as **`CATCHUP_RESULT`** (e.g. `42 rows inserted, 0 errors` or `… 3 errors on tables without uniques (acceptable)`).

---

## Step 9 — Tear down the ghost

```bash
ssh givernance-staging "docker stop givernance-keycloak-ghost && docker rm givernance-keycloak-ghost"
```

---

## Step 10 — Drop the KC tables from `givernance_staging`

> ❌ **Point of no return for the easy rollback path.** After this drop, recovering Keycloak from the *old* location requires replaying `/root/kc-data-${TS}.sql` into a freshly-bootstrapped `givernance_staging` set. Practically: re-create the dropped tables via Keycloak Liquibase (boot a temporary KC pointed at `givernance_staging`), then restore data from the dump. Doable, but minutes-to-hours of work — only proceed once Step 7's smoke + Step 8's catch-up looked clean.

Build the DROP statements **only** from `$KC_TABLES` (the list captured in Step 3) — never from a "diff vs Drizzle" — so an unexpected table can never be dropped by accident:

```bash
DROP_SQL=$(echo "$KC_TABLES" | sed 's/^/DROP TABLE IF EXISTS public./; s/$/ CASCADE;/')
echo "$DROP_SQL" | wc -l           # should equal KC_TABLE_COUNT from Step 3
echo "$DROP_SQL" | head -3         # spot-check the format
ssh givernance-staging "docker exec -i -e PGPASSWORD='$STAGING_POSTGRES_PASSWORD' givernance-postgres \
  psql -U givernance -d givernance_staging -v ON_ERROR_STOP=1" <<<"$DROP_SQL"
```

Verify the app side is untouched:

```bash
ssh givernance-staging "docker exec -e PGPASSWORD='$STAGING_POSTGRES_PASSWORD' givernance-postgres \
  psql -U givernance -d givernance_staging -tAc 'SELECT count(*) FROM users; SELECT count(*) FROM tenants; SELECT count(*) FROM donations'"
```

> Should be unchanged from before Step 1. Record in Journal as **`POST_DROP_APP_COUNTS`**.

And confirm the KC tables are gone from `givernance_staging`:

```bash
ssh givernance-staging "docker exec -e PGPASSWORD='$STAGING_POSTGRES_PASSWORD' givernance-postgres \
  psql -U givernance -d givernance_staging -tAc \"SELECT count(*) FROM information_schema.tables WHERE table_schema='public' AND table_name='realm'\""
```

> Must print `0`.

---

## Step 11 — Push the cutover PR

You already edited `config/deploy-staging.yml` and `.github/actions/setup-kamal-secrets/action.yml` in Step 7 and applied them via `kamal accessory reboot` locally. Now ship them:

1. Update the **Journal** + **Post-mortem** sections of *this file* in your local checkout — that's the load-bearing record of what happened.
2. Commit:
   ```bash
   git add config/deploy-staging.yml .github/actions/setup-kamal-secrets/action.yml docs/runbooks/migrate-staging-keycloak-db.md
   git commit -m "chore(staging): cut over keycloak to givernance_keycloak DB (issue #283)"
   git push origin chore/staging-kc-db-cutover
   ```
3. Open the PR with `close #283` in the body and a one-line summary linking the journal section. Reviewer merges; the next routine `deploy-staging` is a no-op for accessories.

---

## Rollback decision tree

| If you fail at … | Live KC is still on | Rollback recipe |
|---|---|---|
| Step 1 (role/DB create) | old DB | `DROP DATABASE givernance_keycloak; DROP ROLE keycloak;` and you're back to the pre-state. |
| Step 2 (ghost boot) | old DB | `docker rm -f givernance-keycloak-ghost`. |
| Step 3–6 (sync + validate) | old DB | `docker rm -f givernance-keycloak-ghost`, `DROP DATABASE givernance_keycloak`. The dump on `/root` can be deleted. |
| Step 7 (cutover smoke fails) | new DB (broken) | Revert your local edits in `config/deploy-staging.yml` + `setup-kamal-secrets`, re-`kamal accessory reboot keycloak`. KC tables in `givernance_staging` are still intact (Step 10 hasn't run). Then debug and retry Step 7. |
| Step 8 (catch-up errors) | new DB | Catch-up is best-effort — partial errors are OK to log and move on. If `auth.staging` itself broke, treat as Step 7 fail. |
| Step 10 (drop) | new DB | Hard rollback only. Replay `/root/kc-data-${TS}.sql` into a fresh `givernance_staging` Keycloak schema (boot temp KC against `givernance_staging`, restore the dump). |

Keep the dump file (`/root/kc-data-${TS}.sql`) on the VPS for **at least 7 days** after Step 10 before deleting.

---

## Journal (fill in during the run)

| Field | Value |
|---|---|
| Operator | _____ |
| Run start (UTC) | _____ |
| Run end (UTC) | _____ |
| `KEYCLOAK_DB_PASSWORD` set in GH staging env | yes / no |
| `SRC_REALM` | _____ |
| `SRC_USER` | _____ |
| `SRC_CHANGELOG` | _____ |
| `GHOST_CHANGELOG` | _____ |
| `KC_TABLE_COUNT` | _____ |
| `KC_TABLE_SAMPLE` (first 5) | _____ |
| `DUMP_PATH` | `/root/kc-data-_____.sql` |
| `DUMP_BYTES` | _____ |
| `GHOST_REALM` | _____ |
| `GHOST_USER` | _____ |
| Step 6 OIDC discovery on ghost | OK / fail |
| Step 7 cutover start (UTC) | _____ |
| Step 7 cutover end (UTC) | _____ |
| Step 7 measured downtime (s) | _____ |
| Step 7 end-to-end login as `admin@givernance.org` | OK / fail |
| `CATCHUP_RESULT` | _____ rows inserted, _____ errors (note table names if any) |
| `POST_DROP_APP_COUNTS` | users=___ tenants=___ donations=___ |
| Cutover PR | #_____ |
| Deviations from plan | _____ |
| Decisions made on the fly | _____ |

## Post-mortem (fill in after the run)

- [ ] `auth.staging.givernance.org` login flow works end-to-end (admin + at least one regular user)
- [ ] `givernance_keycloak.realm` count == `SRC_REALM`
- [ ] `givernance_keycloak.user_entity` count >= `SRC_USER` (≥ because catch-up may have added a few)
- [ ] No KC tables remain in `givernance_staging` (check `realm`, `user_entity`, `databasechangelog`)
- [ ] `givernance_keycloak` is owned by the `keycloak` role (`\l givernance_keycloak` in psql)
- [ ] All `givernance_keycloak.public` tables + sequences owned by `keycloak` (`\dt+` and `\ds+`)
- [ ] App-side row counts in `givernance_staging` (`users`, `tenants`, `donations`, `audit_logs`) unchanged from pre-Step 1
- [ ] Cutover PR merged + `deploy-staging` post-merge run green
- [ ] Reminder set for `~7 days from cutover` to delete `/root/kc-data-_____.sql` from the VPS
- [ ] Heads-up posted in team channel that staging is now ADR-017 compliant

### What went well

_____

### What went wrong / surprised us

_____

### Follow-up items

- [ ] _____

---

## References

- Issue [#283](https://github.com/purposestack/givernance/issues/283)
- [ADR-017 — One Logical Database per Tool](../adrs/adr-017-one-logical-database-per-tool-isolate-keycloak-from-the-application-db.md)
- [`infra/postgres/init/01-init-keycloak-db.sh`](../../infra/postgres/init/01-init-keycloak-db.sh) — the canonical fresh-init equivalent of Steps 1
- [`docs/infra/README.md` § Databases](../infra/README.md) — local-dev topology this aligns staging with
- PR [#280](https://github.com/purposestack/givernance/pull/280) — sets the migrate-staging precedent (PG 17 cutover) but uses a phased GH workflow instead, since PG major bumps recur. This op runs once.
