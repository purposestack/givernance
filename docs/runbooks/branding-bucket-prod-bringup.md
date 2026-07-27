# Runbook — Branding bucket prod bring-up + orphan-GC enablement (issue #291)

> Operator-facing walkthrough for standing up the **public-read
> `branding` bucket in production** from the Terraform module at
> [`infra/terraform/branding-bucket/`](../../infra/terraform/branding-bucket/),
> cutting the app over to it, and enabling the nightly
> `branding.orphan_gc_sweep` worker job. Complements
> [`launch-prod.md`](launch-prod.md) (which owns the rest of the prod
> environment) and closes the "MUST be matched in prod via Scaleway
> bucket policy" hand-off comment from PR #287. Related: ADR-023
> (bucket topology), ADR-024 (image pipeline / content-addressed keys),
> ADR-034 (prod stays Scaleway), ADR-038 (Terraform/Kamal boundary +
> state backend), `docs/24-branding-assets.md` §7.

## 0. Why this exists

Dev/staging get the branding bucket from `infra/seaweedfs/init.sh` +
the `anonymous Read:branding` identity in `s3config.json`. Prod had no
artefact at all — just a review comment. This runbook + the Terraform
module are that artefact. The nightly orphan-GC sweep (ADR-023
§ Consequences) ships default-off behind the platform flag
`branding.orphan_gc_sweep`; enabling it is the last step here, after a
staging soak.

## 1. Provision the bucket (one-shot)

Two sub-steps, in order: § 1a bootstraps the Terraform **state** bucket
(once per Scaleway project, ever), § 1b applies the branding-bucket
module against it. Requires Terraform **≥ 1.10** (`required_version`;
CI validates in the 1.10.x floor minor).

### 1a. Bootstrap the Terraform state bucket (one-shot per project)

Remote state lives in the private, versioned `givernance-terraform-state`
bucket (ADR-038) — the **one hand-provisioned bootstrap resource**
(Terraform can't manage the bucket its own state lives in). It is shared
by every Terraform module; if the ownership check below confirms it
already exists **under this project's keys**, skip straight to § 1b.

```sh
export SCW_ACCESS_KEY=… SCW_SECRET_KEY=… SCW_DEFAULT_PROJECT_ID=…   # prod project
# The generic S3 tooling (and Terraform's S3 backend) read AWS-style env:
export AWS_ACCESS_KEY_ID="$SCW_ACCESS_KEY" AWS_SECRET_ACCESS_KEY="$SCW_SECRET_KEY"
export AWS_DEFAULT_REGION=fr-par   # aws-cli refuses to run without a region
ENDPOINT=https://s3.fr-par.scw.cloud

# Ownership-aware idempotency guard. Scaleway bucket names are
# REGION-GLOBAL and this name is published in versions.tf, so a bare
# `head-bucket` 200 could also mean a third party squatted the name.
# `get-bucket-versioning` only succeeds for the bucket owner:
#   succeeds        → ours, skip creation (idempotent re-run)
#   NoSuchBucket    → free, create below
#   AccessDenied    → name taken by someone else — STOP, treat as an
#                     incident (do NOT init Terraform against it) and
#                     pick a new name in versions.tf + this runbook.
aws s3api get-bucket-versioning --bucket givernance-terraform-state \
  --endpoint-url "$ENDPOINT" \
  || aws s3api create-bucket --bucket givernance-terraform-state \
       --endpoint-url "$ENDPOINT"

# Versioning ON — a clobbered/corrupted state file must be recoverable:
aws s3api put-bucket-versioning --bucket givernance-terraform-state \
  --versioning-configuration Status=Enabled \
  --endpoint-url "$ENDPOINT"

# Verify posture: private (anonymous GET → 403, unlike the branding
# bucket where 404 is the healthy answer) and versioned:
curl -sI "https://givernance-terraform-state.s3.fr-par.scw.cloud/x" | head -1   # → 403
aws s3api get-bucket-versioning --bucket givernance-terraform-state \
  --endpoint-url "$ENDPOINT" | grep Enabled
```

### 1b. Init, plan, apply the module

The `SCW_*` + `AWS_*` exports from § 1a must still be in the shell —
the scaleway provider reads `SCW_*`, the state backend reads `AWS_*`.

```sh
cd infra/terraform/branding-bucket
terraform init          # connects to the § 1a state bucket; respects the committed .terraform.lock.hcl
terraform validate
terraform plan          # review every line — CI can NOT see the backend block or the live diff; only YOU do
terraform apply
```

**First bring-up only — verify that state locking actually locks.**
`use_lockfile` relies on Scaleway honouring S3 conditional writes; a
gateway that *ignored* the conditional header (instead of rejecting it)
would silently degrade locking to a no-op. Prove it once, positively:
run `terraform plan` in one terminal and, while it runs, `terraform
plan` in a second terminal. The second MUST fail to acquire the lock
(`Error acquiring the state lock`). If both proceed, locking is not
effective — file an issue referencing ADR-038's revisit criteria before
any multi-operator use. Likewise, if a later `plan`/`apply` ever fails
on the *lock* step with a conditional-write/`412`-style error
(Scaleway-side behaviour change), file the same issue; do **not**
silently drop `use_lockfile` from `versions.tf`.

The provider is pinned by the **committed** `.terraform.lock.hcl`
(multi-platform hashes — Linux CI + macOS operators). If `init` wants
to change it, stop: that's a provider-drift signal to review, not to
`-upgrade` through. Two operators applying different provider builds
against the public-read prod bucket is the exact schema-drift incident
class the repo has already been bitten by (CLAUDE.md § Kamal
pinned-version rule) — the lockfile plus the § 1a state lock are what
prevent it.

Override CORS origins if the prod web origins differ from the defaults:

```sh
terraform apply -var='cors_allowed_origins=["https://givernance.org","https://app.givernance.org"]'
```

## 2. Verify the bucket posture

```sh
BUCKET=givernance-branding-prod
ENDPOINT="https://${BUCKET}.s3.fr-par.scw.cloud"

# a) Anonymous read works (after the app has uploaded at least one logo,
#    any key will do; before that, expect 404 — NOT 403):
curl -sI "${ENDPOINT}/does-not-exist" | head -1        # → 404, not 403

# b) Anonymous write is refused:
curl -sI -X PUT "${ENDPOINT}/probe.txt" -d x | head -1  # → 403

# c) CORS preflight answers for an allow-listed origin:
curl -sI -X OPTIONS "${ENDPOINT}/probe.png" \
  -H "Origin: https://app.givernance.org" \
  -H "Access-Control-Request-Method: GET" | grep -i access-control-allow-origin
```

## 3. Point the app at it

In the prod deploy config (see `launch-prod.md` for where prod env
lives — mirrors `config/deploy-staging.yml`):

```yaml
S3_BRANDING_BUCKET: givernance-branding-prod
KEYCLOAK_LOGO_PUBLIC_URL_BASE: https://givernance-branding-prod.s3.fr-par.scw.cloud
# …or the CDN hostname once the edge fronts the bucket:
# KEYCLOAK_LOGO_PUBLIC_URL_BASE: https://cdn.givernance.eu/branding
```

Deploy, upload a logo from a test tenant's Back Office, and check the
donor page + Keycloak login render it from the new origin.

## 4. Enable the nightly orphan-GC sweep

The sweep (`packages/worker/src/processors/branding-orphan-gc-sweep.ts`)
runs at **02:00 UTC** and reaps, after a 7-day grace: soft-deleted
assets whose per-asset GC failed, replaced/never-activated logo rows,
and `{org_id}/` prefixes whose tenant was hard-deleted. It is a no-op
until the platform flag `branding.orphan_gc_sweep` is enabled.

**Order matters: soak on staging first.** Enable the flag on staging,
wait one nightly tick, and inspect the sweep summary in Loki:

```logql
{app="givernance-worker"} |= "branding orphan-GC sweep complete"
```

The summary line carries `softDeletedReaped` / `replacedReaped` /
`unownedPrefixesReaped` / `objectsDeleted`. Counts should match your
expectation from the staging data (usually low single digits). Any
`"reap failed"` warnings name the asset/prefix that resisted.

Then enable on prod via the Back Office feature-flags page (or, if it
is unavailable, the psql path in
[`feature-flag-rollback.md`](feature-flag-rollback.md) with
`enabled = true`).

**Force an immediate tick** (instead of waiting for 02:00 UTC), from
the worker container:

```sh
node -e '
const { Queue } = require("bullmq");
const q = new Queue("branding", { connection: { url: process.env.REDIS_URL } });
q.add("branding.orphan_gc_sweep", {}, { jobId: "manual-orphan-gc-" + Date.now() })
  .then(() => { console.log("enqueued"); process.exit(0); });
'
```

## 5. Rollback

Flip `branding.orphan_gc_sweep` off (Back Office, or the emergency
psql + `redis-cli DEL flags:global` path in
[`feature-flag-rollback.md`](feature-flag-rollback.md)). The next tick
logs `flag is off — skipping sweep` and touches nothing. Already-reaped
objects are **not recoverable** — by definition they were 7+ days past
soft-delete/replacement, which is the accepted audit window
(`docs/24-branding-assets.md` §7).

## Common confusion

- **404 vs 403 on anonymous GET** — a public-read bucket answers 404
  for a missing key. A 403 means the ACL/policy step didn't apply.
- **"The sweep deleted nothing but I see orphans"** — check their age:
  anything younger than 7 days (row `deleted_at`/`updated_at`, or
  newest object mtime for tenant-less prefixes) is deliberately left
  for the next runs.
- **Bare `branding` bucket name** — dev/staging SeaweedFS uses the bare
  name; prod cannot (Scaleway names are region-global). The app never
  hardcodes it: `S3_BRANDING_BUCKET` is the contract.
