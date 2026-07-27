# Terraform — prod `branding` bucket (issue #291)

First IaC artefact in the repo. Provisions the **public-read** branding
bucket on Scaleway Object Storage for production, mirroring what
`infra/seaweedfs/init.sh` + `s3config.json` give dev/staging (ADR-023
bucket topology, ADR-034 prod-stays-Scaleway).

What it manages:

| Concern | Resource | Notes |
|---|---|---|
| Bucket + tags | `scaleway_object_bucket.branding` | name is region-global → `givernance-branding-prod`, app pointed at it via `S3_BRANDING_BUCKET` |
| CORS | `cors_rule` on the bucket | `GET`/`HEAD` only, origins pinned per env via `cors_allowed_origins` |
| Lifecycle | `lifecycle_rule` abort-incomplete-mpu 1d | **no expiry rule** — deletion is owned by the worker GC jobs, never S3 lifecycle |
| Public read | `scaleway_object_bucket_acl` `public-read` | bucket-level; uploads never set per-object ACLs |

What it does **not** manage (out of scope here): the CDN in front of the
bucket, DNS for `cdn.givernance.eu`, the other (private) buckets —
`receipts` / `campaigns` / `bank-statements` keep their `aws s3api`
provisioning until they get their own modules.

## State & prerequisites (ADR-038)

Remote state lives in the shared, private, versioned
`givernance-terraform-state` bucket on Scaleway (`backend "s3"` block in
`versions.tf`, key `branding-bucket/terraform.tfstate`, S3-native
lockfile locking). The state bucket is the one hand-provisioned
bootstrap resource — bring-up in
[`docs/runbooks/branding-bucket-prod-bringup.md`](../../../docs/runbooks/branding-bucket-prod-bringup.md)
§ 1a. Requires **Terraform ≥ 1.10** (`use_lockfile`).

## Usage

```sh
cd infra/terraform/branding-bucket
export SCW_ACCESS_KEY=… SCW_SECRET_KEY=… SCW_DEFAULT_PROJECT_ID=…
# The S3 state backend reads AWS-style env (standard for non-AWS S3):
export AWS_ACCESS_KEY_ID="$SCW_ACCESS_KEY" AWS_SECRET_ACCESS_KEY="$SCW_SECRET_KEY"
terraform init            # respects the COMMITTED .terraform.lock.hcl
terraform validate
terraform plan            # review — MANDATORY gate, see below
terraform apply
```

CI validates `fmt` + provider schema on every PR touching
`infra/terraform/**`
([`terraform-validate.yml`](../../../.github/workflows/terraform-validate.yml)
— ADR-038's answer to the CLAUDE.md § Kamal pinned-version incident
class), but CI holds no cloud credentials: `terraform plan` against
live state is still the only place the real diff is visible, and stays
a MANDATORY local gate before any apply. The committed
`.terraform.lock.hcl` carries multi-platform hashes (Linux CI, macOS
operators) — if `init` wants to change it, treat that as provider
drift to review, never `-upgrade` through it silently.

Operator walkthrough (verification curls, env-var cutover, GC-sweep
flag enablement): `docs/runbooks/branding-bucket-prod-bringup.md`.
