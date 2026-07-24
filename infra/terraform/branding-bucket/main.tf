# Issue #291 — prod `branding` bucket as code (ADR-023, ADR-024).
#
# Visibility class: PUBLIC-READ at the bucket level, no per-object ACLs
# (ADR-023 — one bucket per visibility class; per-tenant isolation lives
# in the `{org_id}/…` key prefix, and keys are content-addressed
# `{org_id}/logo/{logo_id}/{variant}.{ext}` so a stale CDN edge can
# never leak a logo across versions).
#
# Mirrors what `infra/seaweedfs/init.sh` + `s3config.json` provision for
# dev/staging: bucket + abort-incomplete-multipart lifecycle + anonymous
# read. NO expiry lifecycle — object deletion is owned by the worker
# (per-asset `branding.gc_asset` + nightly `branding.orphan_gc_sweep`),
# never by S3 lifecycle, so a mis-set rule can't eat live logos.

resource "scaleway_object_bucket" "branding" {
  name   = var.bucket_name
  region = var.region
  tags   = var.tags

  cors_rule {
    allowed_origins = var.cors_allowed_origins
    allowed_methods = ["GET", "HEAD"]
    allowed_headers = ["*"]
    max_age_seconds = 3600
  }

  lifecycle_rule {
    id      = "abort-incomplete-mpu"
    enabled = true
    # A crashed worker upload must not leave paid-for hidden parts
    # around (same rule init.sh applies on SeaweedFS).
    abort_incomplete_multipart_upload_days = 1
  }
}

# Bucket-level public-read — the whole point of this visibility class.
# Donor-facing surfaces (Keycloak login template, /p/[id] hero) read
# object URLs anonymously behind `Cache-Control: public, max-age=
# 31536000, immutable`. Uploads NEVER set per-object ACLs (see
# packages/shared/src/lib/s3-branding.ts) so this bucket-level setting
# is the single source of truth.
resource "scaleway_object_bucket_acl" "branding_public_read" {
  bucket = scaleway_object_bucket.branding.id
  acl    = "public-read"
  region = var.region
}
