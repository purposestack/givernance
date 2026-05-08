## ADR-026: Postgres 17 Cutover and Scaleway-Anchored Versioning Policy

**Status**: Accepted (issue tracking PR `chore/postgres-17-cutover`)
**Related**: ADR-009 (Scaleway as primary SaaS provider), ADR-017 (one logical DB per tool — CVE coverage), ADR-003 (Drizzle ORM)

### Context

Two questions arrived together:

1. **Dependabot opened PR #263 to bump `postgres:16-alpine` → `postgres:18-alpine`** in `docker-compose.yml`. Touching only the local-dev compose file would have created environment skew (CI, Kamal staging, future Scaleway-managed prod all on PG 16) and broken every developer's `pgdata` volume on `git pull` — PG 18 refuses to read a PG 16 datadir.

2. **What about the next time this happens?** Postgres is one of several dependencies whose major version is constrained by Scaleway Managed-Service adoption — Redis is the other today, and any future managed primitive (Kafka, ClickHouse, Mongo if we ever add it) will be too. Dependabot has no native concept of "wait for the deployment provider to support this major before opening the PR." Without policy, every Scaleway-anchored dependency drifts into the same dev↔prod skew the cutover just removed.

Verification of Scaleway's current ceiling at the time of this ADR (May 2026):

- **PostgreSQL**: PG 16 and PG 17 supported. PG 18 (GA September 2025) not yet adopted. Source: [Scaleway PostgreSQL version updates](https://www.scaleway.com/en/docs/managed-databases-for-postgresql-and-mysql/reference-content/pg-version-updates/).
- **Redis**: 7.x supported. Redis 8 (GA May 2025) not yet adopted.

PG 18 release-note audit against our schema surface (`pg_trgm`, `gen_random_uuid()`, RLS via `current_setting('app.current_org_id', true)::UUID` and `SET LOCAL`, no partitioning, no `COPY FROM`, no inheritance) found zero blockers — but compatibility is not the deciding factor. Environment parity with future SaaS prod is.

### Decision

Two coupled decisions:

1. **Cut over from Postgres 16 to Postgres 17, not 18** — across all four pinned locations: `docker-compose.yml` (local dev), `.github/workflows/ci.yml` (CI services), `config/deploy-staging.yml` (Kamal staging accessory), and the documentation surface (CLAUDE.md, README, agent files, ADRs). PG 17 is Scaleway's current ceiling, so dev / CI / staging / future SaaS prod stay aligned with zero skew at SaaS launch.

2. **Anchor the major version of every Scaleway-managed-service dependency to a manifest-driven CI gate** — not to per-dependency `ignore` rules in Dependabot config. The manifest [`infra/compliance-versions.yml`](../../infra/compliance-versions.yml) declares `max_major` plus rationale and revisit criteria per dependency, and [`scripts/check-compliance-versions.sh`](../../scripts/check-compliance-versions.sh) (CI job `compliance-versions-gate`) fails the build on any pinned image that exceeds the ceiling.

Today the manifest covers `postgres` (max_major: 17, provider: Scaleway Managed PostgreSQL EU) and `redis` (max_major: 7, provider: Scaleway Managed Redis EU). Adding a future Scaleway-managed primitive is one new manifest entry and zero new CI plumbing.

### Two-stage rollout (why staging lags this PR by one merge)

The PR that lands this ADR bumps **dev** (`docker-compose.yml`) and **CI**
(`.github/workflows/ci.yml`) to `postgres:17-alpine`, but deliberately
leaves `config/deploy-staging.yml` pinned to `postgres:16`. Reason: the
staging deploy workflow auto-fires `kamal setup` whenever
`config/deploy-staging.yml` changes, and `setup` would try to boot a
PG 17 container against the existing PG 16 datadir on the VPS — which
fails with `FATAL: database files are incompatible with server` and
leaves staging in a broken state until someone runs the migration.

So the rollout has two stages:

1. **This PR.** Bumps dev + CI, lands the manifest + CI gate, ships the
   migration script + workflow, updates docs and ADRs. Staging is still
   running PG 16 after this merges; the compliance gate accepts that
   (`16 ≤ ceiling 17`).
2. **Migration workflow run.** Operator dispatches
   `migrate-staging-postgres.yml` against the live VPS. It dumps,
   rotates the PG 16 datadir aside, boots PG 17, and restores. On
   success it opens a small follow-up PR that bumps
   `config/deploy-staging.yml` from `postgres:16` to `postgres:17` so
   the file matches reality. Reviewer merges. The next deploy run
   fires `kamal setup`, which is idempotent against an already-running
   accessory at the matching image — so the merge is a no-op for the
   accessory and a routine app-container redeploy.

If stage 2 is skipped or stalls, dev / CI are at PG 17 while staging is
still at PG 16 — the same skew the cutover was meant to remove. The
follow-up PR is therefore not optional; the migration workflow's job
summary surfaces the PR URL on success so it doesn't get lost.

### Rehearsal-then-live workflow (default safety net)

The `migrate-staging-postgres` workflow takes a `mode` input with two
choices, defaulting to **rehearsal** so the safe choice is the default:

| Mode | What runs | Staging impact |
|---|---|---|
| `rehearsal` *(default)* | `pre` on the live VPS (dump only) → ephemeral `postgres:<target>-alpine` container in the runner → bootstrap-role filter → restore → assertion that source-side RLS / extension / Keycloak-changelog counts captured in `pre` round-trip cleanly | None on staging beyond the dump itself. Staging keeps running. |
| `live` | Full `pre → cut → verify` on the VPS, then the `open-pr` job opens the follow-up config bump PR. | ~1–3 minute window where staging Postgres is unavailable during the `cut` phase. |

The intended flow is:

1. **First dispatch: `mode=rehearsal`.** Validates the dump → filter → restore mechanics on the actual staging data, in the same runner that will do the real run, without touching the live VPS Postgres beyond reading it. If anything is wrong with the script, the bootstrap-role filter, the encoding handling, or the source data shape, this run surfaces it. Cheap to repeat.
2. **Once rehearsal is green**, dispatch the same workflow with `mode=live` and the same `target_version`. The `migrate` job runs the full cut, the `open-pr` job opens the config-alignment PR.

If the migration script or workflow ever changes, the next first-time use should re-rehearse before going live. Treat rehearsal mode as the integration test for the script itself.

### Pre-flight belt-and-suspenders (recommended on first run)

The migration script and workflow are well-tested in isolation but the
end-to-end flow against the live VPS is exercised for the first time on
the PG 16 → PG 17 cutover. The blast radius is contained (rotated
datadir means rollback is one `mv`), but a 5-minute manual snapshot
before dispatch gives a second, independent rollback path that doesn't
depend on the workflow's own dump:

```bash
ssh givernance-staging
TS=$(date -u +%Y%m%dT%H%M%SZ)

# 1. Filesystem snapshot of the postgres bind directory
BIND=$(docker inspect givernance-postgres \
  --format '{{ range .Mounts }}{{ if eq .Destination "/var/lib/postgresql/data" }}{{ .Source }}{{ end }}{{ end }}')
tar czf "/root/preflight-pg-bind-${TS}.tar.gz" -C "$(dirname "$BIND")" "$(basename "$BIND")"

# 2. Independent pg_dumpall (separate file from what the workflow produces)
docker exec givernance-postgres pg_dumpall -U givernance \
  > "/root/preflight-pg-dumpall-${TS}.sql"

ls -lh /root/preflight-pg-*-${TS}.*
```

Keep both files for ~7 days alongside the workflow's rotated datadir.
Delete after stable operation is confirmed. Worth doing on the PG 16 → PG
17 run; less critical on the eventual PG 17 → PG 18 run since the script
will have a successful production-like exercise behind it.

### This cutover is also the rehearsal for the next one

Givernance staging today is self-hosted Postgres-in-container (Kamal
accessory), not Scaleway Managed PostgreSQL. SaaS prod (future) will be
on Scaleway Managed and will use Scaleway's console-driven major-version
upgrade flow, not this script. So `migrate-staging-postgres.sh` and
`migrate-staging-postgres.yml` are **staging-only tooling**.

That means the PG 17 cutover documented here serves a second purpose
beyond the immediate version bump: it is operator rehearsal for the
eventual PG 17 → PG 18 cutover, which will happen once Scaleway adopts
PG 18 (and will reuse the same script + workflow + manifest pattern).
The PG 16 → PG 17 run is the one where every operational detail gets
exercised — bind path detection, bootstrap-role filter, kamal accessory
boot against a rotated dir, dump-pull encoding, smoke endpoints under
real DNS+TLS — for the first time end-to-end. Treat it accordingly:
schedule a low-traffic window, run the pre-flight snapshot above, and
plan to be available for the follow-up PR review.

### Migration mechanics — how PG 16 → PG 17 was rolled out

`pg_upgrade` (in-place binary catalog upgrade) was rejected in favour of `pg_dumpall` / `psql` (logical dump/restore) for staging. Reasons:

- The staging Postgres datadir is small (Phase-0 demo data) and `db:seed` exists as a fallback; the dump/restore window is ~15 minutes.
- `pg_upgrade` requires both the source and target binaries on the host plus matching data-checksum settings (PG 18 `initdb` flips checksums on by default, but this also affects the PG 16→17 hop on hosts that initialised without `--data-checksums`). Logical dump/restore sidesteps both constraints.
- Logical restore re-creates indexes from scratch, so the [PG 17 release-note guidance about reindexing `pg_trgm` after `pg_upgrade`](https://www.postgresql.org/docs/17/release-17.html) is moot.

The migration is gated by a workflow (`.github/workflows/migrate-staging-postgres.yml`) and a script (`scripts/migrate-staging-postgres.sh`) that:

1. Take a `pg_dumpall` snapshot from the running PG 16 container, upload it as a workflow artifact **before** any destructive step.
2. Stop and remove the running container.
3. **Rotate** (never delete) the host-side PG 16 datadir aside (`mv data data-pg16-<timestamp>`) so rollback is one `mv` away for at least 7 days.
4. Boot the PG 17 accessory; the existing init script (`infra/postgres/init/01-init-keycloak-db.sh`) re-creates the Keycloak DB on the empty volume.
5. Restore the dump into PG 17.
6. Smoke-test (`pg_isready`, row counts on `users` / `tenants`, healthcheck on `api.staging.givernance.org`, Keycloak realm OIDC discovery).

Local dev is trivial: `docker compose down -v && docker compose up -d && pnpm --filter @givernance/api run db:migrate && pnpm --filter @givernance/api run db:seed:local`. CI is a one-line image bump.

### Why a manifest + CI gate, not Dependabot `ignore` rules or Renovate

Three options were considered:

1. **Per-dependency `ignore` rules in `.github/dependabot.yml`** (the simplest path): scoped to one tool, scattered across each ecosystem block, no slot for rationale beyond YAML comments, and silent on manual edits / rebases that bump past the ceiling outside Dependabot.
2. **Migrate to Renovate** for native `allowedVersions` semantics: cleanest upstream filtering, but a real migration cost (port grouping rules, re-document ADR-017's CVE-coverage story, install GitHub App). Two compliance-anchored deps don't justify it today.
3. **Manifest + CI gate** *(chosen)*: one source of truth with rationale and revisit criteria; gate fires on any bump source — Dependabot, manual edit, or rebase — and surfaces the offending file:line as a `::error` annotation in the PR Files-changed view. Dependabot is unchanged, so CVE-coverage (ADR-017) is preserved verbatim.

If the noise from Dependabot PRs that the gate rejects ever becomes a real cost (today: ~one PR every 6–12 months per anchored dep), Option 2 is the natural follow-up. Renovate's `allowedVersions` in a `packageRules` entry is a one-for-one substitute for the manifest, and migration would be additive — keep the manifest as documentation, replace the gate with Renovate's upstream filter.

### Why PG 17 not PG 18 (re-statement of the consistency argument)

| Target | Dev / CI / Staging today | Future SaaS prod (Scaleway) | Skew window |
|---|---|---|---|
| **PG 17** *(chosen)* | PG 17 | PG 17 (Scaleway ceiling today) | Zero today, zero at SaaS launch |
| PG 18 | PG 18 | PG 17 at SaaS launch → PG 18 once Scaleway adopts | 6–12 months, two migrations |
| PG 16 (status quo) | PG 16 | PG 17 | Already skewed; running below Scaleway's ceiling |

PG 18 buys nothing concrete (no PG-18-specific feature we use) and costs a guaranteed second migration when SaaS launches against PG 17.

### Consequences

- All four PG pins land on the same major (`postgres:17` / `postgres:17-alpine`) until the manifest is bumped.
- Dependabot will keep opening PRs for PG 18 / Redis 8 majors. They will fail the `compliance-versions-gate` job. Reviewers close them with a one-line "ceiling pinned via `infra/compliance-versions.yml`."
- When Scaleway publishes PG 18 (or Redis 8) GA support: bump the manifest entry first, then merge any queued Dependabot PRs that the gate previously rejected. Repeat the migration mechanics above for the staging cutover.
- ADR-017's "Renovate rejected" sentence is updated to note that Renovate's `allowedVersions` semantics now ride on top of Dependabot via this gate — we get the policy without the migration.
- `infra/postgres/init/01-init-keycloak-db.sh`'s comment about `public` schema permissions is corrected: PG 15 already removed the default CREATE-on-public grant from PUBLIC, so the explicit REVOKE is now defensive (audit-visible posture, downgrade-safe) rather than load-bearing.

### Known caveats and follow-ups

- **Bootstrap-role self-conflict filter.** `pg_dumpall --clean --if-exists`
  emits `DROP ROLE IF EXISTS <user>; CREATE ROLE <user>; ALTER ROLE <user>
  …` for every role *including the bootstrap superuser the restore is
  connecting as*. Postgres refuses to drop the current user, so the
  restore would halt under `ON_ERROR_STOP=1`. The migration script strips
  those three lines for `${PG_USER}` before applying the dump (see
  `filter_bootstrap_role_in_dump` in `scripts/migrate-staging-postgres.sh`).
  The role itself is recreated by the postgres image entrypoint on first
  boot of the empty volume, so no functional loss.

- **Encoding constraint.** The migration script asserts that the source
  cluster's `server_encoding` is `UTF8`. PG's `CREATE DATABASE` in the
  dump carries the source's `lc_collate` / `lc_ctype` literally, and a
  non-UTF-8 source would need locale-provider parity on the new cluster
  that the script doesn't probe for. If we ever support a non-UTF-8
  source (we don't today), revisit `pre`/`cut` to capture and assert the
  full locale tuple.

- **Staging deviates from ADR-017 today.** As of writing,
  `config/deploy-staging.yml` points Keycloak at the same database as
  the application (`KC_DB_URL: jdbc:postgresql://givernance-postgres:5432/givernance_staging`),
  rather than the dedicated `givernance_keycloak` database that
  ADR-017 calls for and that local dev uses. This is pre-existing and
  out of scope for the cutover. The migration script handles both
  topologies: it probes `givernance_keycloak` first, falls back to
  `givernance_staging` for Keycloak's `databasechangelog` / `realm`
  tables, and persists the resolution as `KC_LOCATION_DB` in
  `state.env`. Filing a follow-up to bring staging into ADR-017
  compliance is a separate scope.

- **No automation enforces the two-stage rollout sequencing.** If the
  cutover PR merges and the operator never dispatches the migrate
  workflow, dev/CI will run on PG 17 while staging stays on PG 16
  indefinitely. The compliance gate accepts that mid-state
  (`16 ≤ ceiling 17`), so CI is silent. Today this is operator
  discipline only — a scheduled workflow that SSHes to the VPS, reads
  `docker inspect givernance-postgres --format '{{.Config.Image}}'`,
  and opens an issue if the running major lags the dev/CI pin would
  close the gap. Tracked as a follow-up.

- **Compliance gate scope is the manifest's `pinned_in:` list.** A
  future Dockerfile that adds `FROM postgres:18` outside any file
  declared in `infra/compliance-versions.yml` would slip past the gate.
  No `FROM postgres:` directive exists in the repo today; this is a
  forward-looking concern. Either extend the gate to walk all
  `Dockerfile*` files or treat the `pinned_in:` list as a default-deny
  pattern. Follow-up.

### Revisit criteria

- **Bump the PG ceiling** when Scaleway publishes PG 18 GA support on [their version-updates page](https://www.scaleway.com/en/docs/managed-databases-for-postgresql-and-mysql/reference-content/pg-version-updates/).
- **Bump the Redis ceiling** when Scaleway publishes Redis 9 GA support in their Managed Redis docs. (Redis 8 has been adopted — see "Redis 8 cutover" below.)
- **Migrate to Renovate** if the volume of manifest-rejected Dependabot PRs becomes routinely disruptive (heuristic: more than one rejected PR per dependency per quarter).
- **Re-evaluate the dump/restore vs `pg_upgrade` choice** when staging holds non-trivial data (post-SaaS launch with prod-like volume), or when Scaleway introduces a major that requires `--data-checksums=on` to upgrade in place.

### Redis 8 cutover (second application of the same policy)

In **February 2026**, Scaleway Managed Database for Redis adopted **Redis 8.4** and deprecated 7.2.11, satisfying the `revisit_criteria` for Redis above. Dependabot's Redis 8 PR (#264) had previously been closed against the Redis-7 ceiling. Once Scaleway moved, the manifest's `redis.max_major` was bumped from 7 to 8 and the four Redis-anchored pins moved together:

| File | Before | After |
|---|---|---|
| `docker-compose.yml` | `redis:7-alpine` | `redis:8-alpine` |
| `config/deploy-staging.yml` | `redis:7` | `redis:8` |
| `.github/workflows/ci.yml` | `redis:7-alpine` | `redis:8-alpine` |
| `infra/compliance-versions.yml` | `redis.max_major: 7` | `redis.max_major: 8` (and `pinned_in:` extended to include `.github/workflows/ci.yml`, which had been missing) |

**Why no migration script / no two-stage rollout** — unlike the PG 16 → PG 17 cutover, Redis on Givernance only ever holds **transient state** (BullMQ job queues, session cache, rate-limit counters, feature-flag cache). No durable application data is in Redis. Rather than build a `migrate-staging-redis.yml` analogue, the cutover wipes the Redis datadir on both local dev and the Kamal staging accessory.

**The wipe is explicit, not a side-effect of restarting the container.** The staging accessory uses a host bind mount (`config/deploy-staging.yml`: `directories: data/redis:/data`) which survives `docker stop && docker rm`. Redis 8 is forward-compatible with Redis 7's RDB format, so a naive accessory reboot would silently re-load every key from the existing on-disk dump — sessions and queue state would persist, and the documented "forced re-login" / "in-flight jobs lost" side-effects would not actually occur. The real wipe requires `rm -rf data/redis/*` on the host **before** booting the new image. Local dev is the same shape: `docker compose down -v` (the `-v` is non-negotiable; without it the named volume `redisdata` survives).

**Operator procedure (staging cutover)** — must be run in this order to avoid silent event loss:

1. **Pause the relay deployment** so it stops draining the outbox into the (about-to-disappear) BullMQ queue. The relay marks rows `completed` immediately after `eventsQueue.add()` (`packages/relay/src/index.ts:90-97`), so any row that's been enqueued but not yet processed by a worker is invisible in the database — it lives only in Redis. A wipe without this pause loses those events silently.
2. **Drain the events queue to zero.** Either wait for active workers to finish (`bullmq` UI / `redis-cli LLEN bull:events:wait`) or scale workers up briefly. Keep the relay paused throughout.
3. **Stop the redis accessory:** `kamal accessory stop redis -d staging`.
4. **Wipe the host datadir:** `ssh givernance-staging 'rm -rf /var/lib/kamal/givernance/data/redis/*'` (or the equivalent path printed by `docker inspect`).
5. **Boot redis:8:** dispatch `staging-accessory-reboot.yml` with `accessory=redis`. The deploy-staging workflow's per-accessory subtree-diff loop currently only watches `minio` and `keycloak` (`.github/workflows/deploy-staging.yml:127`), so a `config/deploy-staging.yml` redis-image bump does **not** trigger a redis reboot on the next app deploy. The accessory-reboot workflow is the explicit knob. (Generalising the diff loop is a follow-up — issue forthcoming.)
6. **Resume the relay deployment** and confirm new outbox events flow through.

**Communicated side-effects** to the small staging audience before the deploy:

- ~1–2 minutes of Redis unavailability during steps 3–5 (API responds with degraded cache; rate-limit counters reset; sessions invalidated → forced re-login on next request).
- Cold cache for ~minutes after step 5; first requests take the full DB hit.
- Any in-flight BullMQ jobs the worker hadn't picked up before step 1 are lost. At the time of the cutover, staging held no business-critical jobs in flight; receipt-generation jobs that drop are re-issuable from their parent donations.

This shortcut is **not available once SaaS prod is live** — that future major bump (Redis 8 → 9 or beyond) will need either Scaleway's console-driven managed upgrade (preferred) or a session-preserving cutover plan. The "no migration" decision recorded here applies to pre-prod state only.

**Confirms the manifest pattern.** Redis 8 is the second time the policy fires (PG 16 → 17 was the first). The mechanics held up: Dependabot's bump PR was closed by the gate, the `revisit_criteria` was the actionable trigger ("Scaleway publishes Redis 8 GA support"), and the cutover was four file edits + a manifest bump. No additional ADR was written because no decision changed — only the ceiling. If a future bump introduces a new pattern (e.g., a managed-Redis upgrade flow once SaaS prod is live), that PR gets its own ADR; routine ceiling bumps are a subsection here.
