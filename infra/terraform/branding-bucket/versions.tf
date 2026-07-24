# Issue #291 — first IaC artefact in the repo.
#
# ⚠ Schema-validated config (CLAUDE.md § Kamal lesson applies here too):
# no CI job validates HCL, and provider attribute names differ across
# provider majors/minors. `terraform init && terraform validate && \
# terraform plan` locally is the MANDATORY gate before any apply, and
# the generated `.terraform.lock.hcl` must be committed on first init so
# every later plan runs against the same provider build.

terraform {
  required_version = ">= 1.6"

  required_providers {
    scaleway = {
      source = "scaleway/scaleway"
      # Any 2.x carries scaleway_object_bucket + _acl with the blocks
      # used here. Exact-pin via .terraform.lock.hcl at first init.
      version = "~> 2.0"
    }
  }

  # State backend intentionally not declared: the launch-prod operator
  # decides where prod state lives (Scaleway Object Storage `terraform`
  # bucket or Terraform Cloud). Passing `-backend-config` at init keeps
  # this module reusable across environments without editing it.
}

provider "scaleway" {
  # Credentials come from the standard SCW_* env vars
  # (SCW_ACCESS_KEY / SCW_SECRET_KEY / SCW_DEFAULT_PROJECT_ID) — never
  # from tfvars committed to the repo.
  region = var.region
}
