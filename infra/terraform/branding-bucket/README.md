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

## Usage

```sh
cd infra/terraform/branding-bucket
export SCW_ACCESS_KEY=… SCW_SECRET_KEY=… SCW_DEFAULT_PROJECT_ID=…
terraform init            # commit the generated .terraform.lock.hcl
terraform validate
terraform plan            # review — MANDATORY gate, see below
terraform apply
```

⚠ **No CI validates HCL** and provider attribute names differ across
provider versions (the repo has been bitten by exactly this class of
bug — see CLAUDE.md § "Kamal config keys must be valid for the PINNED
version"). `terraform validate` + `plan` locally before any apply is the
gate; commit `.terraform.lock.hcl` on first init so later plans use the
same provider build.

Operator walkthrough (verification curls, env-var cutover, GC-sweep
flag enablement): `docs/runbooks/branding-bucket-prod-bringup.md`.
