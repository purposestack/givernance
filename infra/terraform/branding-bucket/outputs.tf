output "bucket_name" {
  description = "Value for the app's S3_BRANDING_BUCKET env var."
  value       = scaleway_object_bucket.branding.name
}

output "bucket_endpoint" {
  description = "Bucket HTTPS endpoint (virtual-hosted style)."
  value       = scaleway_object_bucket.branding.endpoint
}

output "public_url_base" {
  description = <<-EOT
    Suggested KEYCLOAK_LOGO_PUBLIC_URL_BASE value (direct bucket URL).
    Swap for the CDN hostname (e.g. https://cdn.givernance.eu/branding)
    once the edge is fronting the bucket.
  EOT
  value       = scaleway_object_bucket.branding.endpoint
}
