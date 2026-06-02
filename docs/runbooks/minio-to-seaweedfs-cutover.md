# Runbook — MinIO → SeaweedFS staging cutover (issue #462 / ADR-034)

> Format: **plan + live journal + post-mortem**. Fill the journal as you execute; write the post-mortem after.
> Related: [ADR-034](../adrs/adr-034-seaweedfs-over-minio-for-self-hosted-object-storage.md), [ADR-023](../adrs/adr-023-object-storage-bucket-topology.md), [staging-access notes](../../README.md), [`config/deploy-staging.yml`](../../config/deploy-staging.yml), [`infra/seaweedfs/`](../../infra/seaweedfs/).

## 0. Why this exists — at a glance

MinIO entered maintenance-mode (no security patches) in Dec 2025. This runbook is the **one-shot** procedure to replace the staging MinIO accessory with SeaweedFS **without losing the objects already in the `data/minio` host bind-mount**, and without disrupting the BullMQ queue. Local dev needs no migration (ephemeral, re-seedable); **production is untouched** (Scaleway). The desired end state: a `givernance-seaweedfs` accessory serving the same five buckets at `http://givernance-seaweedfs:8333`, the `branding` read path live on `assets.staging.givernance.org`, MinIO decommissioned.

The single irreversible-ish step is the `S3_ENDPOINT` cutover; everything before it is reversible by leaving MinIO running.

## 1. Pre-flight — run the live container spike (gate)

ADR-034's #1 risk is SSE-S3. This was validated against `chrislusf/seaweedfs:4.31` during issue #462 (17/17 checks: `PutObject` with `ServerSideEncryption: AES256`, multipart via `@aws-sdk/lib-storage`, presigned GET, anonymous `branding` read = 200, anonymous `receipts`/`bulk-imports` = 403, `PutBucketLifecycleConfiguration` 90d/365d + abort-mpu, versioning). **Re-run the spike if you bump the pinned SeaweedFS version** before cutover:

```sh
docker run -d --name swfs-check -p 8333:8333 \
  -v "$PWD/infra/seaweedfs/s3config.json:/etc/seaweedfs/s3config.json:ro" \
  -e WEED_S3_SSE_KEY=check \
  chrislusf/seaweedfs:<new-tag> \
  server -dir=/data -s3 -s3.port=8333 -s3.config=/etc/seaweedfs/s3config.json -ip.bind=0.0.0.0
# then: a PutObject with ServerSideEncryption=AES256 must return AES256, not NotImplemented.
docker rm -f swfs-check
```

## 2. Pre-flight — secrets

The staging GitHub Environment (`staging`) needs two **new** secrets (the old `MINIO_ROOT_PASSWORD` / `MINIO_KMS_SECRET_KEY` become unused — leave or delete):

```sh
gh secret set SEAWEEDFS_S3_SECRET_KEY --env staging --body "$(openssl rand -hex 24)"
gh secret set SEAWEEDFS_SSE_KEY       --env staging --body "$(openssl rand -hex 32)"
```

- `SEAWEEDFS_S3_SECRET_KEY` — the S3 secret-access-key. The kamal-secrets action uses it BOTH as the app `S3_SECRET_ACCESS_KEY` and as the `admin` identity secret in the rendered `config/seaweedfs/s3config.staging.json`. `hex` is URL-safe by construction (issue #335).
- `SEAWEEDFS_SSE_KEY` — the SSE-S3 KEK passphrase (`WEED_S3_SSE_KEY`). **Once set, do not rotate** unless you re-encrypt — rotating orphans previously-encrypted objects. (Staging data is non-load-bearing, so a rotation is recoverable; do not casually rotate in prod-self-host.)

> The `app` services read `S3_ACCESS_KEY_ID: admin` from `env.clear` in `config/deploy-staging.yml` (unchanged from the MinIO setup). Confirm with `gh secret list --env staging`.

## 3. Stand SeaweedFS up alongside MinIO (no cutover yet)

The accessory swap is driven through the workflow, not local kamal (per the established staging-accessory-cutover practice). Because `config/deploy-staging.yml` changed (minio accessory → seaweedfs accessory), the per-push deploy auto-selects `kamal setup` and the per-accessory subtree-diff reboots the new `seaweedfs` accessory.

```sh
# from the PR branch:
gh workflow run staging-accessory-reboot.yml --ref <branch> -f accessory=seaweedfs -f confirm=seaweedfs
```

This boots `givernance-seaweedfs` with `data/seaweedfs:/data` (a NEW, empty bind-mount — MinIO's `data/minio` is untouched) and renders + mounts `config/seaweedfs/s3config.staging.json`. The "Ensure SeaweedFS buckets exist" step in `deploy-staging.yml` creates the buckets + lifecycle.

**Verify the accessory is healthy** before migrating data:

```sh
ssh givernance-staging "docker exec givernance-seaweedfs curl -sf http://localhost:8333/status && echo OK"
```

## 4. Migrate objects MinIO → SeaweedFS

Both accessories are on the `kamal` Docker network. Sync each bucket with `rclone` (or `aws s3 sync`) from a throwaway container on that network. Example with `rclone` (config via env):

```sh
ssh givernance-staging
# MinIO creds = the OLD MINIO_ROOT_PASSWORD; SeaweedFS creds = SEAWEEDFS_S3_SECRET_KEY.
docker run --rm --network kamal \
  -e RCLONE_CONFIG_SRC_TYPE=s3 -e RCLONE_CONFIG_SRC_PROVIDER=Minio \
  -e RCLONE_CONFIG_SRC_ENDPOINT=http://givernance-minio:9000 \
  -e RCLONE_CONFIG_SRC_ACCESS_KEY_ID=admin -e RCLONE_CONFIG_SRC_SECRET_ACCESS_KEY="$OLD_MINIO_PASS" \
  -e RCLONE_CONFIG_DST_TYPE=s3 -e RCLONE_CONFIG_DST_PROVIDER=Other \
  -e RCLONE_CONFIG_DST_ENDPOINT=http://givernance-seaweedfs:8333 \
  -e RCLONE_CONFIG_DST_ACCESS_KEY_ID=admin -e RCLONE_CONFIG_DST_SECRET_ACCESS_KEY="$SEAWEED_SECRET" \
  rclone/rclone:latest sync SRC:receipts DST:receipts --checksum -v
# repeat for: campaigns, branding, bulk-imports, reports
```

**Verify per bucket**: object counts match, and spot-check one checksum.

```sh
# counts (run for each bucket, both endpoints):
docker run --rm --network kamal -e AWS_ACCESS_KEY_ID=admin -e AWS_SECRET_ACCESS_KEY="$SEAWEED_SECRET" \
  amazon/aws-cli --endpoint-url http://givernance-seaweedfs:8333 s3api list-objects-v2 --bucket receipts --query 'length(Contents)'
```

> **SSE note**: objects synced into SeaweedFS are re-encrypted under the SeaweedFS KEK on write (the worker's `AES256` header path); they do not carry MinIO's KMS envelope. Reads after cutover go through the SeaweedFS KEK. No client-side key handling.

## 5. Cut `S3_ENDPOINT` over

`config/deploy-staging.yml` already points the app env at `http://givernance-seaweedfs:8333` (it changed in the same PR). So the cutover happens **when the app containers roll** on the deploy that ships this PR. To be deliberate:

1. Confirm step 4 verification passed for all five buckets.
2. Let the `Deploy to Staging` run for the merge complete (it rolls web/api/worker/relay onto the new `S3_ENDPOINT`).
3. **Pause the BullMQ relay first if you want zero in-flight receipt jobs hitting a half-migrated bucket** — `ssh givernance-staging "docker stop givernance-relay"`, do the endpoint cutover, then `docker start givernance-relay`. (The relay uses `SELECT … FOR UPDATE SKIP LOCKED`, so a brief pause only delays fan-out; nothing is lost.)

## 6. Smoke-test on staging

- Receipt: create a test donation → confirm a receipt PDF downloads from `https://staging.givernance.org/...` (streamed through the API, issue #214).
- Branding: upload an org logo → confirm it renders on the donation page + Keycloak login, fetched from `https://assets.staging.givernance.org/branding/...` (200).
- Bulk-import: upload a CSV → confirm the worker parses it and the API streams it back.
- Finance report: trigger a super-admin monthly report → confirm the PDF streams back.
- Negative: `curl https://assets.staging.givernance.org/receipts/<any-key>` → **403** (private bucket denies anonymous).

## 7. Decommission MinIO

Only after a clean smoke-test and ≥1 day of stable receipts:

```sh
# remove the accessory definition is already done in config (the minio block is gone);
# tear down the running container + free the bind-mount:
ssh givernance-staging "docker rm -f givernance-minio"
# keep data/minio for a rollback window, then once confident:
ssh givernance-staging "sudo rm -rf data/minio"
```

The old `MINIO_ROOT_PASSWORD` / `MINIO_KMS_SECRET_KEY` GH secrets can be deleted.

## 8. Rollback

Before the step-5 cutover: trivial — leave MinIO running, app still points at it (revert the PR / the `S3_ENDPOINT` line). After cutover but within the data-retention window: re-point `S3_ENDPOINT` back to `http://givernance-minio:9000`, restart MinIO if removed (`kamal accessory boot minio` against a reverted config), and re-sync any objects written to SeaweedFS during the window back to MinIO. This is why step 7 keeps `data/minio` for a rollback window.

---

## Live journal

_(fill during execution — timestamps, command outputs, surprises)_

- [ ] Spike re-run (only if version bumped) — result:
- [ ] Secrets set (`SEAWEEDFS_S3_SECRET_KEY`, `SEAWEEDFS_SSE_KEY`) — confirmed via `gh secret list --env staging`:
- [ ] `seaweedfs` accessory booted + `/status` healthy:
- [ ] Buckets + lifecycle provisioned (deploy step output):
- [ ] Object sync per bucket (counts old/new): receipts __/__ · campaigns __/__ · branding __/__ · bulk-imports __/__ · reports __/__
- [ ] `S3_ENDPOINT` cutover (relay paused? y/n):
- [ ] Smoke-test results (receipt / branding / bulk-import / report / negative-403):
- [ ] MinIO decommissioned:

## Post-mortem

_(after completion — what went wrong, what to change in ADR-034 or this runbook, follow-ups filed)_
