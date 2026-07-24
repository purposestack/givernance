# Issue #291 — branding bucket (ADR-023 public-read visibility class).

variable "region" {
  description = "Scaleway region for the bucket. EU-only per ADR-001 (GDPR data residency)."
  type        = string
  default     = "fr-par"
}

variable "bucket_name" {
  description = <<-EOT
    Bucket name. Scaleway Object Storage names are region-global, so the
    bare `branding` used by SeaweedFS in dev/staging is unlikely to be
    free — prod uses a prefixed name and points the app at it via the
    `S3_BRANDING_BUCKET` env var (defaults to `branding` in code).
  EOT
  type        = string
  default     = "givernance-branding-prod"
}

variable "cors_allowed_origins" {
  description = <<-EOT
    Origins allowed to read branding objects cross-origin. Branding
    assets are consumed as plain `<img src>` GETs today (no preflight),
    but any future `fetch()`/canvas use from the donor page or the app
    needs the web origins allow-listed here. Keep this pinned
    per-environment — never `*` with credentials.
  EOT
  type        = list(string)
  default = [
    "https://givernance.org",
    "https://app.givernance.org",
  ]
}

variable "tags" {
  # `scaleway_object_bucket.tags` is a key/value MAP in the scaleway
  # provider (unlike instance resources, where tags are a list).
  description = "Bucket tags (key/value map)."
  type        = map(string)
  default = {
    project    = "givernance"
    domain     = "branding"
    adr        = "adr-023"
    visibility = "public-read"
  }
}
