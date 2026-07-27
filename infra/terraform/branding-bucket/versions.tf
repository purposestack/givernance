# Issue #291 — first IaC artefact in the repo. Issue #564 / ADR-038 —
# state backend + Terraform/Kamal boundary.
#
# ⚠ Schema-validated config (CLAUDE.md § Kamal lesson applies here too):
# provider attribute names differ across provider majors/minors. CI runs
# `terraform fmt -check` + `init -backend=false` + `validate` on every
# PR touching infra/terraform/** (.github/workflows/terraform-validate.yml).
# KNOWN CI BLIND SPOT: `init -backend=false` skips the `backend "s3"`
# block entirely — a typo'd or too-new backend key passes CI green and
# only fails at the operator's real `terraform init`. Provider/resource
# schemas are CI-covered; the backend block is validated at operator init
# only. `terraform plan` against live state therefore remains a MANDATORY
# local gate before any apply, and the committed `.terraform.lock.hcl`
# pins the provider build for CI and operators alike.

terraform {
  # ">= 1.10" (not 1.6) because `use_lockfile` below — S3-native state
  # locking via conditional writes — landed in Terraform 1.10. CI
  # validates at exactly 1.10.5 so this floor stays honest.
  required_version = ">= 1.10"

  required_providers {
    scaleway = {
      source = "scaleway/scaleway"
      # Any 2.x carries scaleway_object_bucket + _acl with the blocks
      # used here. Exact-pin via .terraform.lock.hcl at first init.
      version = "~> 2.0"
    }
  }

  # Remote state on Scaleway Object Storage (ADR-038). The state bucket
  # is the ONE hand-provisioned bootstrap resource (chicken-and-egg:
  # Terraform can't manage the bucket its own state lives in) — see
  # docs/runbooks/branding-bucket-prod-bringup.md § 1a for the one-shot
  # `aws s3api` bootstrap (versioning ON, private).
  #
  # The generic S3 backend speaks AWS-style env credentials, so the
  # operator aliases the Scaleway keys before `terraform init`:
  #   export AWS_ACCESS_KEY_ID="$SCW_ACCESS_KEY"
  #   export AWS_SECRET_ACCESS_KEY="$SCW_SECRET_KEY"
  backend "s3" {
    bucket = "givernance-terraform-state"
    # One key per module — the next module (ADR-038 § absorption order)
    # gets its own `<module>/terraform.tfstate` in the same bucket.
    key       = "branding-bucket/terraform.tfstate"
    region    = "fr-par"
    endpoints = { s3 = "https://s3.fr-par.scw.cloud" }

    # Scaleway is S3-compatible, not AWS: skip the AWS-only validations
    # (STS account lookup, EC2 metadata probe, AWS region allow-list,
    # and the flexible-checksum headers Scaleway's gateway rejects).
    skip_credentials_validation = true
    skip_region_validation      = true
    skip_requesting_account_id  = true
    skip_metadata_api_check     = true
    skip_s3_checksum            = true

    # S3-native locking (conditional writes, Terraform >= 1.10) — two
    # operators applying concurrently against a live donor-facing
    # public-read bucket was gap 1 of issue #564. If Scaleway ever
    # rejects the conditional write (loud `412`/lock error at plan
    # time, never silent), see the runbook § 1a fallback note.
    use_lockfile = true
  }
}

provider "scaleway" {
  # Credentials come from the standard SCW_* env vars
  # (SCW_ACCESS_KEY / SCW_SECRET_KEY / SCW_DEFAULT_PROJECT_ID) — never
  # from tfvars committed to the repo.
  region = var.region
}
