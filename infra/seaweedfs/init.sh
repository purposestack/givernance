#!/usr/bin/env sh
# SeaweedFS bucket provisioning (ADR-034 — replaces the MinIO `mc` init).
#
# Runs S3-API calls (CreateBucket + PutBucketLifecycleConfiguration) against the
# SeaweedFS S3 gateway, mirroring exactly how the prod Scaleway buckets are
# provisioned (`aws s3api …`). Idempotent: re-running on an existing gateway is
# a no-op (create-bucket on an existing bucket is tolerated, lifecycle is a PUT).
#
# Public-read for `branding` is NOT set here — it is a static `anonymous`
# identity in infra/seaweedfs/s3config.json applied at gateway start (ADR-023 /
# ADR-034). This script only creates buckets + applies lifecycle expiry.
#
# Env (with dev defaults matching .env.example):
#   S3_ENDPOINT, S3_ACCESS_KEY_ID, S3_SECRET_ACCESS_KEY, S3_REGION
#   S3_RECEIPTS_BUCKET, S3_CAMPAIGNS_BUCKET, S3_BRANDING_BUCKET,
#   S3_BULK_IMPORT_BUCKET, S3_REPORTS_BUCKET
set -eu

ENDPOINT="${S3_ENDPOINT:-http://seaweedfs:8333}"
export AWS_ACCESS_KEY_ID="${S3_ACCESS_KEY_ID:-givernance}"
export AWS_SECRET_ACCESS_KEY="${S3_SECRET_ACCESS_KEY:-givernance_dev}"
export AWS_DEFAULT_REGION="${S3_REGION:-fr-par}"

RECEIPTS="${S3_RECEIPTS_BUCKET:-receipts}"
CAMPAIGNS="${S3_CAMPAIGNS_BUCKET:-campaigns}"
BRANDING="${S3_BRANDING_BUCKET:-branding}"
BULK="${S3_BULK_IMPORT_BUCKET:-bulk-imports}"
REPORTS="${S3_REPORTS_BUCKET:-reports}"

aws() { command aws --endpoint-url "$ENDPOINT" "$@"; }

# Wait for the S3 gateway to accept requests (ListBuckets is unauthenticated-
# friendly enough to use as a readiness probe; retry up to ~60s).
echo "seaweedfs-init: waiting for S3 gateway at $ENDPOINT …"
i=0
until aws s3api list-buckets >/dev/null 2>&1; do
  i=$((i + 1))
  if [ "$i" -ge 30 ]; then
    echo "seaweedfs-init: S3 gateway not ready after 60s" >&2
    exit 1
  fi
  sleep 2
done

create_bucket() {
  # create-bucket returns BucketAlreadyOwnedByYou on re-run — tolerate it.
  aws s3api create-bucket --bucket "$1" >/dev/null 2>&1 || true
  echo "seaweedfs-init: bucket ready → $1"
}

for b in "$RECEIPTS" "$CAMPAIGNS" "$BRANDING" "$BULK" "$REPORTS"; do
  create_bucket "$b"
done

# Lifecycle. Every bucket GCs orphan multipart parts after 1 day — the
# @aws-sdk/lib-storage multipart Upload leaks parts if the source stream is
# destroyed mid-upload (worker crash / transient S3 error). Reports get a
# 365-day expiry (rolling 12-month board-pack window); bulk-imports get a
# 90-day expiry (matches the row_data retention in bulk_import_results; the
# files are PII-laden so the window is the minimal proportionate one).
# MUST be mirrored on the prod Scaleway buckets (docs/23, docs/28, docs/33).
put_lifecycle() {
  bucket="$1"
  rules="$2"
  aws s3api put-bucket-lifecycle-configuration \
    --bucket "$bucket" \
    --lifecycle-configuration "{\"Rules\":[$rules]}" >/dev/null
  echo "seaweedfs-init: lifecycle applied → $bucket"
}

ABORT='"AbortIncompleteMultipartUpload":{"DaysAfterInitiation":1}'

put_lifecycle "$RECEIPTS"  "{\"ID\":\"abort-mpu\",\"Status\":\"Enabled\",\"Filter\":{\"Prefix\":\"\"},$ABORT}"
put_lifecycle "$CAMPAIGNS" "{\"ID\":\"abort-mpu\",\"Status\":\"Enabled\",\"Filter\":{\"Prefix\":\"\"},$ABORT}"
put_lifecycle "$BRANDING"  "{\"ID\":\"abort-mpu\",\"Status\":\"Enabled\",\"Filter\":{\"Prefix\":\"\"},$ABORT}"
put_lifecycle "$BULK"      "{\"ID\":\"expire-90\",\"Status\":\"Enabled\",\"Filter\":{\"Prefix\":\"\"},\"Expiration\":{\"Days\":90},$ABORT}"
put_lifecycle "$REPORTS"   "{\"ID\":\"expire-365\",\"Status\":\"Enabled\",\"Filter\":{\"Prefix\":\"\"},\"Expiration\":{\"Days\":365},$ABORT}"

echo "seaweedfs-init: done — buckets [$RECEIPTS $CAMPAIGNS $BRANDING $BULK $REPORTS] provisioned (branding public-read via s3config.json anonymous identity)"
