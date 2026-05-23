# Runbook — Migrate staging Keycloak to its own database (issue #283)

> **One-shot operator task.** Aligns the live staging Postgres with [ADR-017](../adrs/adr-017-one-logical-database-per-tool-isolate-keycloak-from-the-application-db.md) by moving Keycloak's ~95 internal tables out of `givernance_staging` and into a dedicated `givernance_keycloak` database owned by a least-privilege `keycloak` role.
>
> **Pattern.** Blue-green via a *temporary* ghost Keycloak run directly with `docker run` on the kamal Docker network (no Kamal accessory). The live `keycloak` accessory keeps serving `auth.staging.givernance.org` until Step 7. **`auth.staging` downtime ≈ 30 seconds** (a single `kamal accessory reboot keycloak` once `KC_DB_URL` is swapped).
>
> **One-time only.** This runbook runs once, ever; it intentionally lives as paste-able commands rather than a `workflow_dispatch` workflow — PR #280's migrate-staging-postgres pattern is justified for *recurring* ops (PG major bumps), not for one-shots.
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

**Repo + tooling**
- [ ] PR [#334](https://github.com/purposestack/givernance/pull/334) (this PR — landed `infra/postgres/init/01-init-keycloak-db.sh` into the postgres accessory's `files:` and added `KEYCLOAK_DB_PASSWORD` to `setup-kamal-secrets` + the three workflows that consume it) is **merged into `main`** and the resulting `deploy-staging` run is green.
- [ ] Local tooling installed and on PATH:
  ```bash
  bundle exec kamal version    # ≥ 2.x
  jq --version
  curl --version
  openssl version
  yq --version                  # used in Step 7's edit
  ```

**Secrets**
- [x] **Done 2026-05-09 during PR #334 setup** — Generated `KEYCLOAK_DB_PASSWORD` via `openssl rand -base64 24`. (Constraint: base64 charset only — no single quotes / `$` / backticks; later steps interpolate it through nested ssh + docker exec layers.)
- [x] **Done 2026-05-09 during PR #334 setup** — Saved to the `staging` GitHub Environment (Settings → Environments → staging → Environment secrets) via `gh secret set KEYCLOAK_DB_PASSWORD --env staging --repo purposestack/givernance`. Confirmed visible in `gh secret list --env staging`. This locks in the value for every CI run from PR-merge onward; the composite-action fallback `staging_keycloak_db_123` is no longer reachable on staging.
- [x] **Done 2026-05-09 during PR #334 setup** — Saved to the team external secret manager. You cannot read it back from GitHub; Steps 1, 2, and 7 each need it.
- [ ] Locate `STAGING_POSTGRES_PASSWORD`. The bootstrap-superuser password lives in 1Password (`Givernance · Staging` vault → `Postgres bootstrap`). If it's not there, extract from a running runner via the GH `staging` env (`gh secret list --env staging` confirms `POSTGRES_PASSWORD` exists; the value can also be inspected on the live container at `ssh givernance-staging "docker inspect givernance-postgres --format '{{range .Config.Env}}{{println .}}{{end}}' | grep '^POSTGRES_PASSWORD='"` from the operator's session — handle as PII).
- [ ] Export both into your shell — and **keep this terminal session alive through Step 11**, or rely on the state file Step 3 writes:
  ```bash
  export KEYCLOAK_DB_PASSWORD='...'                # value generated above
  export STAGING_POSTGRES_PASSWORD='...'           # value retrieved above
  ```

**Repo state**
- [ ] You're on a fresh checkout of `main`, no uncommitted work:
  ```bash
  git fetch origin main && git checkout main && git pull && git status
  ```
- [ ] No deploys in flight: `gh run list --workflow=deploy-staging.yml --limit=1` shows the latest run as `completed/success`.
- [ ] `bundle exec kamal accessory details postgres -c config/deploy-staging.yml` returns `givernance-postgres … running (postgres:17)` — sanity check that the local Kamal can talk to the VPS.

**Coordination**
- [ ] Posted a `~30s auth.staging downtime, starting in ~5 min` heads-up in the team channel.

**Acquire the kamal lock for the duration of the run.** A teammate pushing to `main` mid-runbook would otherwise trigger `deploy-staging.yml` in parallel — and because `setup-kamal-secrets` now also writes `KEYCLOAK_DB_PASSWORD`, a parallel `kamal setup` could race the live `psql` sessions of Steps 5 / 8 and time out the dump. Releasing in Step 11.

```bash
bundle exec kamal lock acquire -m "issue #283 KC DB cutover" -c config/deploy-staging.yml
```

> If `kamal lock acquire` fails because the lock is already held (a parallel `deploy-staging` or `staging-accessory-reboot` run is in flight), wait for it to finish before proceeding. Don't `kamal lock release` someone else's lock.

### What we're doing, end-to-end

Total operator-on-keyboard ≈ **30 min** (45 min ceiling), of which `auth.staging.givernance.org` is 502 for ~30s during Step 7.

| Step | What | Where it runs | Time | Reversible? |
|---|---|---|---|---|
| 0 | Pre-flight + lock acquire | laptop | ~10 min | ✅ `kamal lock release` |
| 1 | Create `keycloak` role + `givernance_keycloak` DB; capture source counts; persist state | `ssh` → `docker exec psql` | ~1 min | ✅ `DROP DATABASE` + `DROP ROLE` |
| 2 | Boot a ghost Keycloak via `docker run` (image-digest-pinned to live KC), pointed at new DB | `ssh` → `docker run` | 30–90 s (Liquibase) | ✅ `docker rm -f givernance-keycloak-ghost` |
| 3 | Validate Liquibase populated; capture canonical KC table + sequence set; cross-check vs source | `ssh` → `docker exec psql` | ~30 s | ✅ no-op |
| 4 | Stop ghost so it doesn't write during the dump | `ssh` → `docker stop` | 5 s | ✅ |
| 5 | Dump KC tables + sequences data-only from `givernance_staging`, TRUNCATE + restore into `givernance_keycloak`, fix ownership | `ssh` → `docker exec pg_dump`/`psql` | 1–2 min | ⚠️ TRUNCATE before restore — `/root/kc-data-${TS}.sql` (chmod 600) is the recovery handle |
| 6 | Restart ghost, row-count + known-row + OIDC validation | `ssh` → `docker start` + `psql` | ~30 s | ✅ |
| 7 | **Cutover**: edit `config/deploy-staging.yml` + `setup-kamal-secrets/action.yml` locally, hand-build `.kamal/secrets`, `kamal accessory reboot keycloak` — auth.staging is 502 for ~30s | laptop | 3–5 min (incl. ~30s 502) | ⚠️ revert the file + rebuild bag + reboot rolls back |
| 8 | Best-effort non-destructive catch-up sync (writes that landed on the old DB during Steps 5–7); triage error categories | `ssh` → `docker exec pg_dump`/`psql` | ~60 s | ✅ idempotent (`ON CONFLICT DO NOTHING`) |
| 9 | Stop & remove the ghost docker container | `ssh` → `docker rm -f` | 5 s | ✅ |
| 10 | Drop KC tables from `givernance_staging` — **point of no return** (rollback requires Step 5 dump replay) | `ssh` → `docker exec psql` | ~30 s | ❌ recoverable only via dump replay |
| 11 | Release kamal lock, file cleanup issue, push the cutover PR | laptop | 5–10 min | ✅ |

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
  psql -U givernance -d givernance_staging -tAc 'SELECT count(*) FROM realm; SELECT count(*) FROM user_entity; SELECT count(*) FROM databasechangelog; SELECT count(*) FROM users; SELECT count(*) FROM tenants; SELECT count(*) FROM donations; SELECT count(*) FROM pg_policies WHERE schemaname = ''public'';'"
```

> **`SRC_REALM` / `SRC_USER` / `SRC_CHANGELOG` / `SRC_USERS_APP` / `SRC_TENANTS` / `SRC_DONATIONS` / `SRC_RLS_POLICIES`** → Journal. The last four are the "app side untouched" baselines we'll re-check after Step 10's drop.

**Persist the migration state to a file** so you can resume in a fresh terminal if needed (Step 3 / 5 / 7 / 8 / 10 all reference variables set during the run, and a closed terminal would otherwise expand them to empty strings — which silently turns Step 8's catch-up dump into "dump the entire `givernance_staging` DB", and Step 10's drop into a no-op):

```bash
TS=$(date -u +%Y%m%dT%H%M%SZ)
STATE_FILE="${HOME}/.migrate-staging-kc-${TS}.env"
cat > "$STATE_FILE" <<EOF
TS=${TS}
KEYCLOAK_DB_PASSWORD=${KEYCLOAK_DB_PASSWORD}
STAGING_POSTGRES_PASSWORD=${STAGING_POSTGRES_PASSWORD}
EOF
chmod 600 "$STATE_FILE"
echo "State file: $STATE_FILE  — record this path in the Journal"
```

> If you start a new shell partway through, run `source ~/.migrate-staging-kc-<TS>.env` first.

---

## Step 2 — Boot the ghost Keycloak

The ghost runs on the same `kamal` Docker network as the live accessory but is **not** registered with kamal-proxy, so `auth.staging.givernance.org` keeps routing to the live `keycloak` accessory throughout. **Pin the ghost to the live KC's exact image digest** — using `:latest` re-resolves the tag from GHCR (which the operator's docker session may not be authenticated to), and a `:latest` that moved between Step 2 and Step 7 produces a Liquibase changelog drift between ghost and live → Step 5's `--data-only` dump fails to FK-validate against the ghost's schema.

```bash
LIVE_KC_IMAGE_DIGEST=$(ssh givernance-staging "docker inspect --format '{{.Image}}' givernance-keycloak")
echo "Live keycloak image digest: $LIVE_KC_IMAGE_DIGEST"
echo "LIVE_KC_IMAGE_DIGEST=${LIVE_KC_IMAGE_DIGEST}" >> "$STATE_FILE"
```

> Record the digest in Journal as **`LIVE_KC_IMAGE_DIGEST`**. The ghost will boot from this exact image, already in the VPS's local image store (no GHCR pull).

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
  $LIVE_KC_IMAGE_DIGEST \
  start-dev"
```

> No `--import-realm` and no realm-import file mounted on purpose: the ghost only needs Liquibase to create the empty schema; the realm rows arrive via the dump in Step 5. The throwaway `ghost-admin` master-realm row is wiped by Step 5's `TRUNCATE … CASCADE`, then the dump's `admin` row replaces it — it never persists to the post-cutover live KC ([Keycloak ignores `KEYCLOAK_ADMIN` once the master realm exists](https://www.keycloak.org/server/bootstrap-admin-recovery)).

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

The ghost's freshly-populated `givernance_keycloak.public` is the authoritative Keycloak table set for *this* image version. Capture it (plus the sequence set — `pg_dump -t <table>` does **not** include named sequences associated with that table, and Keycloak has a handful of named sequences like `MIGRATION_MODEL_VERSION_SEQ` whose `setval()` we have to pull in explicitly or the post-cutover KC will collide on PK):

```bash
KC_TABLES=$(ssh givernance-staging "docker exec -e PGPASSWORD='$STAGING_POSTGRES_PASSWORD' givernance-postgres \
  psql -U givernance -d givernance_keycloak -tAc \"SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename\"")
KC_SEQUENCES=$(ssh givernance-staging "docker exec -e PGPASSWORD='$STAGING_POSTGRES_PASSWORD' givernance-postgres \
  psql -U givernance -d givernance_keycloak -tAc \"SELECT sequence_name FROM information_schema.sequences WHERE sequence_schema='public' ORDER BY sequence_name\"")
echo "$KC_TABLES" | wc -l        # ~95 expected
echo "$KC_TABLES" | head -5      # spot-check: realm, user_entity, etc.
echo "$KC_SEQUENCES"             # ~few sequences expected
```

> Record the count + first 5 tables in Journal as **`KC_TABLE_COUNT`** + **`KC_TABLE_SAMPLE`**, and the full sequence list as **`KC_SEQUENCES`**.

**Cross-check ghost vs source.** If a teammate hand-created tables in `givernance_staging.public` since Liquibase last ran, they'd be left behind by Step 10's drop (because Step 10 uses `$KC_TABLES`, sourced from the ghost). Fail loudly if there's any drift:

```bash
SOURCE_KC_TABLES=$(ssh givernance-staging "docker exec -e PGPASSWORD='$STAGING_POSTGRES_PASSWORD' givernance-postgres \
  psql -U givernance -d givernance_staging -tAc \"
    SELECT tablename FROM pg_tables WHERE schemaname='public' AND tablename IN (
      SELECT unnest(string_to_array(\$\$$(echo "$KC_TABLES" | tr '\n' ',' | sed 's/,$//')\$\$, ','))
    ) ORDER BY tablename\"")
diff <(echo "$KC_TABLES") <(echo "$SOURCE_KC_TABLES") && echo "  KC table set: ghost ↔ source match ✓"
```

> An empty `diff` means the ghost's KC table set is exactly present in source (no drift). A non-empty diff means investigate before proceeding (a missing table on either side is a real issue).

Build the `pg_dump` filter — one `-t public.<name>` per table AND per sequence:

```bash
DUMP_FILTER=$( (echo "$KC_TABLES"; echo "$KC_SEQUENCES") | grep -v '^[[:space:]]*$' | sed 's/^/-t public./' | tr '\n' ' ')
```

**Persist the discovered state to the state file** (Steps 5, 8, 10 all read `$KC_TABLES` and `$DUMP_FILTER` — a closed terminal between here and there silently turns Step 8's catch-up into "dump everything in `givernance_staging`" without these):

```bash
mkdir -p "${HOME}/.migrate-staging-kc-${TS}"
echo "$KC_TABLES"    > "${HOME}/.migrate-staging-kc-${TS}/kc-tables.txt"
echo "$KC_SEQUENCES" > "${HOME}/.migrate-staging-kc-${TS}/kc-sequences.txt"
chmod 600 "${HOME}/.migrate-staging-kc-${TS}/"*.txt
cat >> "$STATE_FILE" <<EOF
KC_TABLES_FILE=${HOME}/.migrate-staging-kc-${TS}/kc-tables.txt
KC_SEQUENCES_FILE=${HOME}/.migrate-staging-kc-${TS}/kc-sequences.txt
DUMP_FILTER='${DUMP_FILTER}'
EOF
```

> If you start a fresh terminal later: `source $STATE_FILE && KC_TABLES=$(cat $KC_TABLES_FILE) && KC_SEQUENCES=$(cat $KC_SEQUENCES_FILE)` and you're back to where you were.

---

## Step 4 — Stop the ghost so it doesn't write during the sync

```bash
ssh givernance-staging "docker stop givernance-keycloak-ghost"
```

---

## Step 5 — Initial sync: dump → truncate → restore → fix ownership

> ⚠️ **First destructive moment** (TRUNCATE in `givernance_keycloak`, but that DB only has the empty Liquibase scaffold so far — nothing to lose). The `givernance_staging` side is read-only here.

**Dump KC tables data-only from the live `givernance_staging`** (the dump uses `--disable-triggers`, which emits per-table `ALTER TABLE … DISABLE TRIGGER ALL` — only valid because we're connecting as the bootstrap superuser `givernance`. Don't replace `givernance` with `givernance_app` here — `NOBYPASSRLS NOSUPERUSER` would make `--disable-triggers` a silent no-op and FK checks would re-fire mid-restore):

```bash
ssh givernance-staging "docker exec -e PGPASSWORD='$STAGING_POSTGRES_PASSWORD' givernance-postgres \
  pg_dump -U givernance -d givernance_staging --data-only --disable-triggers $DUMP_FILTER \
  > /root/kc-data-${TS}.sql"
ssh givernance-staging "chmod 600 /root/kc-data-${TS}.sql"
```

> The dump contains plaintext PII (KC user emails, password hashes, refresh-token records). `chmod 600` restricts it to `root` only on the VPS. After Step 10's stable-operation observation window (≥ 7 days), delete via the cleanup issue Step 11 files.

**Sanity-check the dump size** (should be ≥ a few hundred KB on a populated staging realm) **and that it includes the sequence `setval()` calls** (otherwise next user creation on KC collides on PK):

```bash
ssh givernance-staging "wc -c /root/kc-data-${TS}.sql"
ssh givernance-staging "grep -c '^SELECT pg_catalog.setval' /root/kc-data-${TS}.sql"   # should equal $(echo \"$KC_SEQUENCES\" | wc -l)
```

> Record path + size + setval count in Journal as **`DUMP_PATH`** + **`DUMP_BYTES`** + **`DUMP_SETVAL_COUNT`** — this file is the rollback handle for Step 10. Record SHA-256 too for tamper-evidence:
> ```bash
> ssh givernance-staging "sha256sum /root/kc-data-${TS}.sql"
> ```

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

**Row-count spot-check** the ghost can read what we restored:

```bash
ssh givernance-staging "docker exec -e PGPASSWORD='$STAGING_POSTGRES_PASSWORD' givernance-postgres \
  psql -U givernance -d givernance_keycloak -tAc 'SELECT count(*) FROM realm; SELECT count(*) FROM user_entity; SELECT count(*) FROM databasechangelog'"
```

> Should match `SRC_REALM` / `SRC_USER` / `SRC_CHANGELOG` exactly. Record as **`GHOST_REALM`** / **`GHOST_USER`** / **`GHOST_CHANGELOG`** → Journal. **If any mismatch, stop here and investigate** — DON'T proceed to Step 7. The ghost is harmless; the live accessory still serves traffic.

**Known-row spot-check** — the seeded `admin@givernance.org` user (created from `infra/keycloak/realm-givernance.json`) MUST exist in the new DB. This is the most reliable signal that the user-credential graph survived the dump+restore intact:

```bash
ssh givernance-staging "docker exec -e PGPASSWORD='$STAGING_POSTGRES_PASSWORD' givernance-postgres \
  psql -U givernance -d givernance_keycloak -tAc \"SELECT username, enabled, email FROM user_entity WHERE email='admin@givernance.org'\""
```

> Should print `admin | t | admin@givernance.org` (or whatever `email` was set to in the realm). Empty result = abort.

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

**Don't push yet.** Apply locally first.

> ⚠️ **`kamal accessory reboot` does NOT auto-invoke `.github/actions/setup-kamal-secrets`** — that composite is a GitHub Actions composite, not a shell function. Kamal reads `.kamal/secrets` if present, else the env vars referenced in the `secret:` blocks of `deploy-staging.yml`. So you must hand-build `.kamal/secrets` to match what the GH Action would produce, OR export every referenced env var into your shell. Easiest: run the composite's logic locally as a shell snippet:

```bash
# Pull the values from 1Password (or wherever you store them) into your shell first.
# Every entry below MUST be set or kamal falls back to the dev defaults — and that's
# how the 2026-04-29 MinIO outage (issue #211) happened. Confirm with `gh secret list --env staging`.
: "${POSTGRES_PASSWORD:?}" "${REDIS_PASSWORD:?}" "${MINIO_ROOT_PASSWORD:?}" "${KEYCLOAK_ADMIN_PASSWORD:?}"
: "${KEYCLOAK_ADMIN_CLIENT_SECRET:?}" "${SESSION_SECRET:?}" "${RESEND_API_KEY:?}"
: "${MINIO_KMS_SECRET_KEY:?}" "${IMPERSONATION_JWT_SECRET:?}" "${KEYCLOAK_DB_PASSWORD:?}"
# STRIPE_* may be empty by precedent (see action.yml).

mkdir -p .kamal
cat > .kamal/secrets <<EOF
GITHUB_TOKEN=$(gh auth token)
POSTGRES_PASSWORD=${POSTGRES_PASSWORD}
REDIS_PASSWORD=${REDIS_PASSWORD}
MINIO_ROOT_PASSWORD=${MINIO_ROOT_PASSWORD}
MINIO_KMS_SECRET_KEY=${MINIO_KMS_SECRET_KEY}
KEYCLOAK_ADMIN_PASSWORD=${KEYCLOAK_ADMIN_PASSWORD}
SESSION_SECRET=${SESSION_SECRET}
KC_DB_PASSWORD=${KEYCLOAK_DB_PASSWORD}
DATABASE_URL=postgres://givernance:${POSTGRES_PASSWORD}@givernance-postgres:5432/givernance_staging
# Issue #430 — DATABASE_URL_APP must connect as `givernance_app` (NOBYPASSRLS),
# NEVER the owner `givernance` role. Before #430 this line had `givernance:` and
# silently bypassed RLS across the app + worker.
DATABASE_URL_APP=postgres://givernance_app:${GIVERNANCE_APP_PASSWORD}@givernance-postgres:5432/givernance_staging
GIVERNANCE_APP_PASSWORD=${GIVERNANCE_APP_PASSWORD}
REDIS_URL=redis://:${REDIS_PASSWORD}@givernance-redis:6379
S3_SECRET_ACCESS_KEY=${MINIO_ROOT_PASSWORD}
KEYCLOAK_ADMIN_CLIENT_SECRET=${KEYCLOAK_ADMIN_CLIENT_SECRET}
RESEND_API_KEY=${RESEND_API_KEY:-}
STRIPE_SECRET_KEY=${STRIPE_SECRET_KEY:-}
STRIPE_WEBHOOK_SECRET=${STRIPE_WEBHOOK_SECRET:-}
IMPERSONATION_JWT_SECRET=${IMPERSONATION_JWT_SECRET}
KEYCLOAK_DB_PASSWORD=${KEYCLOAK_DB_PASSWORD}
EOF
chmod 600 .kamal/secrets

# Now reboot the keycloak accessory with the new config + secrets bag.
bundle exec kamal accessory reboot keycloak -c config/deploy-staging.yml
```

> The `KC_DB_PASSWORD` line above already uses `${KEYCLOAK_DB_PASSWORD}` — that's the post-cutover value, matching what the cutover PR's `setup-kamal-secrets/action.yml` edit will produce on the next CI run.

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

Apply with `ON_ERROR_STOP=0` so a table without any unique/exclusion constraint (rare in KC; mostly cluster-state tables) doesn't abort the rest. Same `cat … | docker exec -i …` pattern as Step 5's restore — the catch-up dump is on the VPS host, not inside the container. Capture the full output to a logfile so post-mortem can grep it:

```bash
CATCHUP_LOG="/root/kc-catchup-${TS}.log"
ssh givernance-staging "cat /root/kc-catchup-${TS}.sql | docker exec -i -e PGPASSWORD='$STAGING_POSTGRES_PASSWORD' givernance-postgres \
  psql -U givernance -d givernance_keycloak -v ON_ERROR_STOP=0 2>&1 \
  | tee $CATCHUP_LOG"
```

**Triage.** Three error categories — only the first is acceptable:

```bash
# ACCEPTABLE — session/event churn during cutover window. These tables are TTL'd
# or rebuildable; losing a few rows is the policy ("no problem if we lose an update").
ssh givernance-staging "grep -E 'ERROR.*\\\"(user_session|offline_user_session|client_session|event_entity|admin_event_entity|user_session_note|offline_client_session|client_session_role|client_session_note|client_session_auth_status|client_user_session_note|user_attribute|fed_user_attribute)' $CATCHUP_LOG | wc -l"

# ABORT-AND-INVESTIGATE — touches identity/credentials/realm, indicates schema or data drift.
# Any non-zero count here = roll back Step 7 (revert config + reboot) and triage offline.
ssh givernance-staging "grep -E 'ERROR.*\\\"(realm|user_entity|credential|user_role_mapping|client|client_scope|component|authentication_execution|authenticator_config|organization)' $CATCHUP_LOG"

# OPERATOR-ERROR — quoting / permissions. Rare but indicates the runbook itself misfired.
ssh givernance-staging "grep -E 'ERROR.*(permission denied|relation .* does not exist|syntax error)' $CATCHUP_LOG"
```

> Record `INSERT 0 N` count + each grep result in Journal as **`CATCHUP_RESULT`** (e.g. `47 rows inserted, 3 acceptable session-table errors, 0 identity errors, 0 operator errors`). **A non-zero count from the second or third category is a roll-back signal** — the runbook is paused; abort to the rollback decision tree.

---

## Step 9 — Tear down the ghost

> Rollback is **still cheap** at this point: KC tables are still intact in `givernance_staging`, the dump is still on `/root`, and reverting the local `config/deploy-staging.yml` + `kamal accessory reboot keycloak` puts auth back on the old DB. Crossing into Step 10 is the breakpoint.

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

Verify the app side is untouched (counts AND RLS policies):

```bash
ssh givernance-staging "docker exec -e PGPASSWORD='$STAGING_POSTGRES_PASSWORD' givernance-postgres \
  psql -U givernance -d givernance_staging -tAc 'SELECT count(*) FROM users; SELECT count(*) FROM tenants; SELECT count(*) FROM donations; SELECT count(*) FROM pg_policies WHERE schemaname=''public''; '"
```

> Compare against `SRC_USERS_APP` / `SRC_TENANTS` / `SRC_DONATIONS` / `SRC_RLS_POLICIES` captured in Step 1 — must be **identical**. Record in Journal as **`POST_DROP_APP_COUNTS`** + **`POST_DROP_RLS_POLICIES`**. A regression in any of these = something dropped that shouldn't have, treat as Step-7-grade rollback (replay the dump into a fresh KC, debug the `$KC_TABLES` derivation).

And confirm the KC tables are gone from `givernance_staging`:

```bash
ssh givernance-staging "docker exec -e PGPASSWORD='$STAGING_POSTGRES_PASSWORD' givernance-postgres \
  psql -U givernance -d givernance_staging -tAc \"SELECT count(*) FROM information_schema.tables WHERE table_schema='public' AND table_name IN ('realm', 'user_entity', 'databasechangelog')\""
```

> Must print `0` three times (one per table-name).

---

## Step 11 — Release the lock + push the cutover PR + file the cleanup issue

Release the kamal lock first so other workflows can run again:

```bash
bundle exec kamal lock release -c config/deploy-staging.yml
```

You already edited `config/deploy-staging.yml` and `.github/actions/setup-kamal-secrets/action.yml` in Step 7 and applied them via `kamal accessory reboot` locally. Now ship them:

1. Update the **Journal** + **Post-mortem** sections of *this file* in your local checkout — that's the load-bearing record of what happened. The cutover-PR diff WILL include this file (the runbook itself is unchanged from `main`; only the journal/post-mortem deltas show up).
2. Commit:
   ```bash
   git add config/deploy-staging.yml .github/actions/setup-kamal-secrets/action.yml docs/runbooks/migrate-staging-keycloak-db.md
   git commit -m "chore(staging): cut over keycloak to givernance_keycloak DB (issue #283)"
   git push origin chore/staging-kc-db-cutover
   ```
3. Open the PR — its CI will rebuild `.kamal/secrets` with `KC_DB_PASSWORD=$KEYCLOAK_DB_PASS`. After merge, the next `deploy-staging` run sees `setup-kamal-secrets/action.yml` changed → triggers `kamal setup`, which is idempotent against the already-running keycloak accessory at the matching env. Body should include `close #283` and a one-line link to the journal section.

**File the dump-cleanup follow-up issue** so the rollback handle on `/root` doesn't linger forever:

```bash
gh issue create \
  --repo purposestack/givernance \
  --title "Cleanup: delete /root/kc-data-${TS}.sql + /root/kc-catchup-${TS}.* from staging VPS" \
  --label cleanup \
  --body "After ≥7 days of stable post-cutover operation (i.e. one CI-driven \`kamal accessory reboot keycloak\` against the merged config/deploy-staging.yml + setup-kamal-secrets has succeeded), delete the rollback dump and catch-up artifacts from staging VPS /root:

\`\`\`
ssh givernance-staging \"rm -f /root/kc-data-${TS}.sql /root/kc-catchup-${TS}.sql /root/kc-catchup-${TS}.sql.bak /root/kc-catchup-${TS}.log\"
\`\`\`

Do NOT delete earlier than the CI-reboot signal — wall-clock 7 days alone is insufficient if no real reboot has happened in that window. See \`docs/runbooks/migrate-staging-keycloak-db.md\` for context."
```

---

## Rollback decision tree

> **In every failure path, also run `bundle exec kamal lock release -c config/deploy-staging.yml`** so other workflows can run again. The Step 0 lock-acquire is paired with this release; leaving it locked blocks every routine deploy.

| If you fail at … | Live KC is still on | Rollback recipe |
|---|---|---|
| Step 1 (role/DB create) | old DB | `DROP DATABASE givernance_keycloak; DROP ROLE keycloak;` and you're back to the pre-state. Then `kamal lock release`. |
| Step 2 (ghost boot) | old DB | `docker rm -f givernance-keycloak-ghost`. Then `kamal lock release`. |
| Step 3 (ghost ↔ source diff) | old DB | Investigate the table-set drift before any further step — likely a hand-created table in `givernance_staging.public` that needs to be reckoned with manually. The ghost is harmless; leave it running while you investigate, OR `docker rm -f` and re-run after fixing the drift. |
| Step 4–6 (sync + validate) | old DB | `docker rm -f givernance-keycloak-ghost`, `DROP DATABASE givernance_keycloak`. The dump on `/root` can be deleted. `kamal lock release`. |
| Step 7 (cutover smoke fails) | new DB (broken) | Revert local edits in `config/deploy-staging.yml` + `setup-kamal-secrets/action.yml`, **rebuild `.kamal/secrets` again** with the OLD `KC_DB_PASSWORD=$POSTGRES_PASSWORD` line (the bag built in Step 7 has the new value), then `kamal accessory reboot keycloak`. KC tables in `givernance_staging` are still intact (Step 10 hasn't run). Debug and retry Step 7. |
| Step 8 (catch-up errors) | new DB | Acceptable session-table errors → log and move on. Identity-table errors → treat as Step-7 failure (rollback). Operator errors → fix the runbook command and re-run Step 8 (`ON CONFLICT DO NOTHING` makes re-runs safe). |
| Step 9 (ghost teardown) | new DB | Restart the ghost (`docker start givernance-keycloak-ghost`) only if you need it for diagnostics; otherwise the failure is informational. |
| Step 10 (drop) | new DB | **Hard rollback only.** Replay `/root/kc-data-${TS}.sql` into a fresh `givernance_staging` Keycloak schema: boot a temporary KC pointed at `givernance_staging` (Liquibase recreates the schema), then `cat /root/kc-data-${TS}.sql \| docker exec -i ... psql`. Then revert config to point KC at `givernance_staging`. Document in journal. |

**Dump retention**: keep `/root/kc-data-${TS}.sql` on the VPS until ≥ 7 days **AND** at least one CI-driven `kamal accessory reboot keycloak` has succeeded against the merged config (i.e., a real reboot from `setup-kamal-secrets`'s rebuilt bag — not just wall-clock time). The cleanup issue Step 11 files captures this gate.

---

## Journal (filled in during the run — 2026-05-10)

| Field | Value |
|---|---|
| Operator | Wanig Guillo |
| Run start (UTC) | 2026-05-10 07:45 (POSTGRES_PASSWORD rotation prep) |
| Run end (UTC) | 2026-05-10 ~09:00 (post-Step-10 verification) |
| `KEYCLOAK_DB_PASSWORD` set in GH staging env | yes (set 2026-05-09 during PR #334 prep) |
| State file path | `~/.migrate-staging-kc-20260510T082122Z/state.env` |
| Kamal lock acquired (Step 0) | **no — deferred** (operator's laptop had no Ruby toolchain; no kamal CLI locally; mitigation = team-channel coordination + Sunday no-traffic window). See "Deviations" below. |
| `SRC_REALM` / `SRC_USER` / `SRC_CHANGELOG` | 2 / 9 / 187 |
| `SRC_USERS_APP` / `SRC_TENANTS` / `SRC_DONATIONS` / `SRC_RLS_POLICIES` | 8 / 3 / 53,510 / 23 |
| `LIVE_KC_IMAGE_DIGEST` | `sha256:7f73f4c5c73dc6e6304fc54f0dce3b60894f32c040a72fa5738a61c2cc3b4133` |
| `GHOST_CHANGELOG` | 187 (matches `SRC_CHANGELOG` ✓) |
| `KC_TABLE_COUNT` / `KC_TABLE_SAMPLE` (first 5) | 90 / `admin_event_entity, associated_policy, authentication_execution, authentication_flow, authenticator_config` |
| `KC_SEQUENCES` (full list) | **(none — Keycloak 26 uses application-generated UUIDs throughout, zero DB sequences)** |
| Ghost ↔ source `diff` clean (Step 3) | yes — all 90 ghost KC tables exist in source; 29 extra source tables = Drizzle app tables (audit_logs, campaigns, donations, …) untouched by migration |
| `DUMP_PATH` / `DUMP_BYTES` / `DUMP_SETVAL_COUNT` / SHA-256 | `/root/kc-data-20260510T082122Z.sql` / 250,855 / 0 (no sequences) / `bfdf8f0bf6979ade315805b6e14db6cafe186022b252c834e04b7ec85cb640f8` |
| pg_dump wall-clock (Step 5) | ~6 s |
| Restore wall-clock (Step 5) | ~3 s |
| `GHOST_REALM` / `GHOST_USER` | 2 / 9 (match `SRC_REALM` / `SRC_USER` ✓) |
| Seeded admin row check (Step 6) | OK — `admin@givernance.org` present, `enabled=t` |
| Step 6 OIDC discovery on ghost | **skipped** — `wget`/`curl` not in the keycloak image; row-count + admin-row check substituted (DB-level signal is stronger anyway since OIDC discovery hits realm metadata cached at startup) |
| Step 7 cutover start (UTC) | ~08:55 (operator dispatched `staging-accessory-reboot.yml --ref chore/staging-kc-db-cutover`) |
| Step 7 cutover end (UTC) | ~08:56 (workflow run 25624246854 completed in 1m04s) |
| Step 7 measured downtime (s) | ~30s during the `kamal accessory reboot` phase of the workflow |
| Step 7 `kamal-proxy` 5xx count during swap | not measured (Sunday traffic ≈ 0; not load-bearing) |
| Step 7 end-to-end login | confirmed via smoke (`curl https://staging.givernance.org/login` → 200; OIDC discovery 200; api healthz 200). Manual incognito login skipped given Sunday no-activity. |
| `CATCHUP_RESULT` | 1,634 INSERTs, **all `0 0` (zero rows inserted, zero conflicts → cutover window had zero KC writes)**; 0 session-table errors; 0 identity-table errors; 0 operator errors |
| `POST_DROP_APP_COUNTS` / `POST_DROP_RLS_POLICIES` | users=8 tenants=3 donations=53,510 / rls=23 — **all match SRC values exactly** ✓ |
| KC remnants in `givernance_staging` after Step 10 | 0 (verified via `information_schema.tables WHERE table_name IN ('realm','user_entity','databasechangelog','client','credential')`) |
| Cleanup issue filed (Step 11) | _filed alongside the cutover PR — see PR description_ |
| Cutover PR | _opened from `chore/staging-kc-db-cutover` after this commit_ |

### Deviations from plan

- **Skipped Step 0 `kamal lock acquire`**: operator's laptop lacks a Ruby 3.3 + bundler toolchain. The runbook's safer-default approach (acquire the kamal lock, hand-build `.kamal/secrets`, run `kamal accessory reboot` locally) was replaced by triggering the existing `staging-accessory-reboot.yml` workflow against the cutover branch (`gh workflow run staging-accessory-reboot.yml --ref chore/staging-kc-db-cutover -f accessory=keycloak -f confirm=keycloak`). The workflow runs `setup-kamal-secrets` + `kamal accessory reboot` in CI with the staging GH-env secret bag — same end result as the laptop path, no Ruby install on the operator's machine, and CI's own `concurrency: deploy-staging` group provided the serialization the manual lock would have provided. This is a strict improvement over the runbook recipe and the runbook should be amended for future operators (follow-up).
- **`POSTGRES_PASSWORD` rotation hit issue [#335](https://github.com/purposestack/givernance/issues/335) on first attempt** — the `openssl rand -base64 24` recipe in the pre-flight produced a value containing `/`, which `pg-connection-string` parses as a path separator and throws `TypeError: Invalid URL` from. Re-rotated to `openssl rand -hex 24`, runbook should be updated to recommend hex by default. Tracked in #335.
- **No GH staging-env secrets existed for most "secrets"** before this run: `POSTGRES_PASSWORD`, `KEYCLOAK_ADMIN_PASSWORD`, `REDIS_PASSWORD`, `MINIO_*`, `SESSION_SECRET`, `IMPERSONATION_JWT_SECRET`, `KEYCLOAK_ADMIN_CLIENT_SECRET` were all running on the committed dev fallbacks in `.github/actions/setup-kamal-secrets/action.yml`. We rotated `POSTGRES_PASSWORD` and set the GH secret as part of unblocking this runbook; the rest stay on fallbacks (out of scope — see Follow-up items).

### Decisions made on the fly

- **Image-digest pinning of the ghost** picked from the running keycloak's `docker inspect` (rather than `:latest`) — eliminates the GHCR-auth dependency on the operator's docker daemon AND eliminates ghost-vs-live schema drift if `:latest` were repushed mid-run. This is in the runbook already.
- **Skipped manual incognito login** in Step 7 verification given the Sunday-zero-traffic context. DB-level checks (realm count, admin row, OIDC discovery 200) were sufficient.
- **Used Beekeeper Studio** (with SSH tunnel on the dedicated `~/.ssh/givernance_staging` key) to spot-check both DBs between Step 9 and Step 10 — confirmed that `givernance_staging` had the 90 KC tables plus 29 Drizzle app tables, and `givernance_keycloak` had only the 90 KC tables (all owned by the `keycloak` role). This is not in the runbook today; recommended as a soft pause-point for future operators.

## Post-mortem (filled in 2026-05-10)

- [x] `auth.staging.givernance.org` OIDC discovery returns 200 (smoke check in Step 7)
- [x] `givernance_keycloak.realm` count == `SRC_REALM` (2 == 2)
- [x] `givernance_keycloak.user_entity` count == `SRC_USER` (9 == 9; catch-up added 0 because cutover window had zero writes)
- [x] No KC tables remain in `givernance_staging` (`realm` / `user_entity` / `databasechangelog` / `client` / `credential` all return 0 from `information_schema.tables`)
- [x] `givernance_keycloak` is owned by the `keycloak` role (verified via `pg_database` query: owner=`keycloak`)
- [x] All `givernance_keycloak.public` tables owned by `keycloak` (Step 5.d ALTER OWNER fired for all 90 tables; sequences N/A — KC has none)
- [x] App-side row counts in `givernance_staging` (`users`=8, `tenants`=3, `donations`=53,510, `pg_policies`=23) **identical** to pre-Step-1 baselines
- [ ] Cutover PR merged + `deploy-staging` post-merge run green — *pending: PR opened immediately after this commit*
- [x] Cleanup follow-up issue filed for `/root/kc-data-20260510T082122Z.sql` deletion after ≥7 days of stable operation
- [ ] Heads-up posted in team channel that staging is now ADR-017 compliant — *pending the cutover PR merge*

### What went well

- **Blue-green pattern executed cleanly**. Auth.staging downtime measured at ~30s (the `kamal accessory reboot keycloak` phase). DB-level row counts matched source exactly. Catch-up sync was a no-op (1,634 INSERTs all `0 0`) — confirmed Sunday traffic was zero, so the cutover window had no writes to lose.
- **Image-digest pinning** (capturing `LIVE_KC_IMAGE_DIGEST` via `docker inspect` and using it as the ghost's image instead of `:latest`) eliminated both the GHCR-auth concern and the schema-drift concern in one move. Worth keeping in the runbook permanently.
- **Cross-check ghost ↔ source table set** (Step 3) caught a hypothetical drift class with no false positives — all 90 ghost tables existed in source, 29 source tables (Drizzle) didn't exist in ghost (correct: app schema). The diff gave us strong confidence before cutover.
- **State file persistence** to `~/.migrate-staging-kc-${TS}/` made the multi-step session robust against terminal flakes — `KC_TABLES`, `DUMP_FILTER`, baselines all recoverable across Bash sessions.

### What went wrong / surprised us

- **Most staging "secrets" were committed-as-plaintext dev fallbacks**, not GH-env secrets. `POSTGRES_PASSWORD` was running on `staging_postgres_123` (committed at `setup-kamal-secrets/action.yml:29`). Same likely true for `KEYCLOAK_ADMIN_PASSWORD`, `REDIS_PASSWORD`, `MINIO_*`, `SESSION_SECRET`, `IMPERSONATION_JWT_SECRET`, `KEYCLOAK_ADMIN_CLIENT_SECRET`. The composite action's "non-load-bearing fallback" framing was misleading — they had been load-bearing on staging since first boot. Discovered during the runbook because we needed to authenticate as `givernance` to ALTER ROLE for `keycloak`, expected GH env to have it, didn't.
- **`openssl rand -base64 24` produced a `/`-containing password** that broke `pg-connection-string`. Drizzle's `applying migrations…` exit-1 with no stderr was infuriating to debug. Took two failed deploys before tracing through `node -e "new Client(...)"` to surface `TypeError: Invalid URL`. Filed as #335 with a fix proposal (URL-encode the URI userinfo in `setup-kamal-secrets`).
- **Beekeeper Studio's bundled `ssh2` library doesn't read `~/.ssh/config` aliases** AND doesn't fall back to filesystem keys when "SSH Agent" auth is selected on a system where the agent has no identities loaded. Solved by switching to "Private Key" auth pointing at `~/.ssh/givernance_staging` directly. Worth documenting for future operators using the runbook's verification step.
- **`gh workflow run` defaults `mode=auto` for `deploy-staging.yml` to `kamal setup`** when `event_name=workflow_dispatch` (because there's no `before` SHA to diff against), and `kamal setup` does NOT redeploy app containers — so triggering a deploy "to refresh env after rotating `POSTGRES_PASSWORD`" was a no-op for the api/web/worker/relay processes. Took us a wasted ~5min before noticing. Solution: explicit `-f mode=deploy`.
- **Staging Redis is open to the internet AND has no `requirepass` set** — `bind * -::*` + `0.0.0.0:6379` host port + `default` user accepts anonymous. The committed `staging_redis_123` value in the secrets bag is ignored by Redis (no auth required). Discovered while setting up Beekeeper for Redis verification. Out of scope for this issue but a real exploitable hole on staging.
- **No `wget`/`curl` in the keycloak image** — Step 6's OIDC-discovery-from-inside-the-container check failed with "command not found". Fell back to DB-level row-count checks (which are stronger signals anyway). Runbook should remove this step or use a different approach (curl from a sidecar container on the kamal network).

### Follow-up items

- [ ] **Hygiene audit issue (broad)**: rotate every committed dev fallback in `setup-kamal-secrets/action.yml` that's still load-bearing on staging (likely 7 secrets). Set the matching GH staging-env secrets. Verify no service still resolves to a fallback string. Not blocking, but should land before SaaS launch.
- [ ] **Set Redis `requirepass` on staging**, switch the bind to the kamal network only (no `0.0.0.0`), narrow the host-port mapping to `127.0.0.1:6379` if the host port is needed at all.
- [ ] **Tighten Postgres bind on staging**: `0.0.0.0:5432` should be `127.0.0.1:5432` (only operators-via-SSH-tunnel) or kamal-network-only. Strong password is now in place; that's a defense-in-depth step.
- [x] [#335](https://github.com/purposestack/givernance/issues/335) filed — URL-encode passwords in `setup-kamal-secrets` URI construction.
- [ ] **Update the runbook itself** (separate small PR) based on what we learned: replace `openssl rand -base64 24` with `-hex 24`; replace Step 0's "kamal lock acquire from laptop" with the workflow-driven path (`gh workflow run staging-accessory-reboot.yml --ref <branch>`); remove the `wget`-based OIDC-from-inside-ghost check; add a Beekeeper-verification soft pause-point between Step 9 and Step 10.
- [ ] **Delete `/root/kc-data-20260510T082122Z.sql` and `/root/kc-catchup-20260510T082122Z.*`** after ≥7 days of stable post-cutover operation AND at least one CI-driven `kamal accessory reboot keycloak` against the merged config. Tracked in the cleanup issue filed alongside the cutover PR.

---

## References

- Issue [#283](https://github.com/purposestack/givernance/issues/283)
- [ADR-017 — One Logical Database per Tool](../adrs/adr-017-one-logical-database-per-tool-isolate-keycloak-from-the-application-db.md)
- [`infra/postgres/init/01-init-keycloak-db.sh`](../../infra/postgres/init/01-init-keycloak-db.sh) — the canonical fresh-init equivalent of Steps 1
- [`docs/infra/README.md` § Databases](../infra/README.md) — local-dev topology this aligns staging with
- PR [#280](https://github.com/purposestack/givernance/pull/280) — sets the migrate-staging precedent (PG 17 cutover) but uses a phased GH workflow instead, since PG major bumps recur. This op runs once.
