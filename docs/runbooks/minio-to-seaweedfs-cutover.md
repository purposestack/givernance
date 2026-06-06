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

> ⚠ **EXPECTED FAILURE — the proxy registration will error, and that's fine.** Both the `minio` and `seaweedfs` accessories declare a `proxy:` block claiming the **same public host** (`assets.staging.givernance.org`). kamal-proxy allows exactly **one service per host**, so while MinIO still owns that route the SeaweedFS accessory boot fails its final `kamal-proxy deploy` step with:
> ```
> Error: host settings conflict with another service
> ```
> The **container itself boots fine** (`docker run` exits 0) and is reachable at `givernance-seaweedfs:8333` on the `kamal` network — only the *public* route registration fails. The public route is not needed for steps 4–5 (data migration uses the internal network). The route is claimed explicitly in **step 5b** (host handoff), after MinIO's route is removed. **Do not** try to make the boot's proxy step succeed here — you can't, until MinIO releases the host.
>
> Consequence for the **per-push auto-deploy**: merging the cutover PR triggers a `Deploy to Staging` that (a) rolls the app onto the new (empty) `S3_ENDPOINT` and (b) **goes RED on the accessory-reboot step** for exactly this reason. That red run is expected. Drive steps 4 → 5b → 6 → 7 by hand, then re-run the deploy to land green (MinIO is gone by then, so no conflict). This is the 2026-06-06 incident — see post-mortem.

**Verify the accessory is healthy** before migrating data (use the *internal* status, the public host still routes to MinIO at this point):

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

> ⚠ **MinIO KMS may refuse to list its own objects (2026-06-06 staging).** The `receipts` bucket sync failed at `ListObjectsV2` with `kms:InvalidCiphertextException: failed to decrypt ciphertext` — MinIO's KMS could no longer decrypt the SSE-KMS object metadata it wrote, so the objects were **unreadable at the source** and could not be migrated. On staging this is acceptable: receipt PDFs are regenerable (re-create the donation) and the app had already begun writing fresh receipts to SeaweedFS. **If this happens against a store with load-bearing receipts (prod self-host), STOP** — do not decommission MinIO; the objects are only recoverable with the original `MINIO_KMS_SECRET_KEY`. Sync the buckets that *do* list cleanly (`campaigns`, `branding`) and triage `receipts` separately before cutover.

### 4b. Provision buckets + lifecycle on SeaweedFS

rclone auto-creates a destination bucket on first write, but (a) empty source buckets are never created and (b) lifecycle rules are never applied. Run the repo's `init.sh` against the live gateway (idempotent — safe to re-run):

```sh
ssh givernance-staging 'SW=$(docker exec givernance-seaweedfs sh -c "tr -d \" \n\" < /etc/seaweedfs/s3config.json" | grep -o "\"secretKey\":\"[^\"]*\"" | head -1 | sed "s/\"secretKey\":\"//;s/\"//")
docker run --rm -i --network kamal \
  -e S3_ENDPOINT=http://givernance-seaweedfs:8333 -e S3_ACCESS_KEY_ID=admin \
  -e S3_SECRET_ACCESS_KEY="$SW" -e S3_REGION=fr-par \
  --entrypoint sh amazon/aws-cli:latest -s' < infra/seaweedfs/init.sh
```

This creates all five buckets (so the empty `bulk-imports` exists) and applies the 90d/365d/abort-mpu lifecycle. Branding public-read is **not** set here — it is the static `anonymous Read:branding` identity in the mounted `s3config.json` (ADR-023).

## 5. Cut `S3_ENDPOINT` over

`config/deploy-staging.yml` already points the app env at `http://givernance-seaweedfs:8333` (it changed in the same PR). So the cutover happens **when the app containers roll** on the deploy that ships this PR. To be deliberate:

1. Confirm step 4 verification passed for all five buckets.
2. Let the `Deploy to Staging` run for the merge complete (it rolls web/api/worker/relay onto the new `S3_ENDPOINT`).
3. **Pause the BullMQ relay first if you want zero in-flight receipt jobs hitting a half-migrated bucket** — `ssh givernance-staging "docker stop givernance-relay"`, do the endpoint cutover, then `docker start givernance-relay`. (The relay uses `SELECT … FOR UPDATE SKIP LOCKED`, so a brief pause only delays fan-out; nothing is lost.)

### 5b. Host handoff — give `assets.staging.givernance.org` to SeaweedFS

This is the step the original runbook was missing (it caused the 2026-06-06 red deploy). MinIO still owns the public host in kamal-proxy; release it and register SeaweedFS. The container is already running and healthy (step 3), so this is a pure route swap — **no container recreate, the migrated objects are untouched**:

```sh
ssh givernance-staging 'set -e
SWID=$(docker ps -q --filter name=givernance-seaweedfs)
# 1. release the host
docker exec kamal-proxy kamal-proxy remove givernance-minio
# 2. claim it for seaweedfs — flags MUST match the accessory proxy block in config/deploy-staging.yml
docker exec kamal-proxy kamal-proxy deploy givernance-seaweedfs \
  --target="${SWID}:8333" --host="assets.staging.givernance.org" \
  --tls --deploy-timeout="30s" --drain-timeout="30s" --health-check-path="/status" \
  --buffer-requests --buffer-responses \
  --log-request-header="Cache-Control" --log-request-header="Last-Modified" --log-request-header="User-Agent"
docker exec kamal-proxy kamal-proxy list'
```

> The `--target` / `--tls` / `--health-check-path` / buffer / log-header flags are the rendered form of the `proxy:` block on the `seaweedfs` accessory in [`config/deploy-staging.yml`](../../config/deploy-staging.yml). If you changed that block, copy the new flags from a failed `Reboot accessories` log line rather than trusting this snippet. After this, **re-run the (red) deploy** — with MinIO's route gone the accessory-reboot step registers cleanly and the run goes green.

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

**2026-06-06 — staging cutover executed (run [27067405970](https://github.com/purposestack/givernance/actions/runs/27067405970))**

- [x] Spike re-run — N/A (pinned `chrislusf/seaweedfs:4.31` unchanged)
- [x] Secrets set — pre-existing in `staging` env
- [x] `seaweedfs` accessory booted + `/status` healthy — container `5385f5a6726d` Up, internal `/status` = OK. **Public proxy registration FAILED at boot** with `host settings conflict with another service` (MinIO still owned `assets.staging`) — expected, see post-mortem.
- [x] Buckets + lifecycle provisioned — ran `infra/seaweedfs/init.sh` by hand (the deploy's "Ensure SeaweedFS buckets exist" step never ran — the deploy died on the earlier accessory-reboot step). All 5 buckets + 90d/365d/abort-mpu lifecycle applied.
- [x] Object sync per bucket (old/new): receipts **N-A / 3** (MinIO KMS decrypt error — source unreadable; 3 are fresh app writes) · campaigns **12 / 12** · branding **19 / 19** · bulk-imports **0 / 0** (bucket was missing on SeaweedFS until init.sh) · reports **n-a / 0** (never existed on MinIO)
- [x] `S3_ENDPOINT` cutover — happened automatically when the merge-deploy rolled the app onto `givernance-seaweedfs:8333` (relay not explicitly paused; fresh receipts wrote cleanly)
- [x] Host handoff (step 5b) — `kamal-proxy remove givernance-minio` → `kamal-proxy deploy givernance-seaweedfs --host=assets.staging…`. Verified: proxy `list` shows seaweedfs owns the host.
- [x] Smoke-test — anonymous `branding/…/original.jpg` = **200**, anonymous `receipts/…` = **403**, `assets.staging…/status` = **200**.
- [x] MinIO decommissioned — `docker rm -f givernance-minio`; `~/givernance-minio/data/minio` (6.6M) **preserved** for the rollback window.
- [x] Deploy re-run triggered to land green (MinIO route gone → no conflict).

## Post-mortem

**2026-06-06 — cutover via merge-deploy went red; recovered by hand.**

**What went wrong.** Merging the cutover PR triggered the per-push `Deploy to Staging`, which collapsed the runbook's deliberately-manual one-shot into one automated run. Two failures resulted:
1. **App rolled onto an empty store before migration.** `S3_ENDPOINT` flipped to `givernance-seaweedfs:8333` as the app containers rolled, but the rclone migration (step 4) had not run — so the new store was empty when traffic arrived.
2. **The deploy went RED on the accessory-reboot step.** Both the `minio` and `seaweedfs` accessories declare a `proxy:` block on the same public host `assets.staging.givernance.org`. kamal-proxy allows one service per host, so SeaweedFS's boot-time `kamal-proxy deploy` failed: `Error: host settings conflict with another service`. The container booted fine; only the public route failed. Because the deploy died here, the downstream "Ensure SeaweedFS buckets exist" step never ran, leaving `bulk-imports` (an empty bucket rclone never creates) absent and no lifecycle rules anywhere.

**Latent issue surfaced.** MinIO's KMS could no longer decrypt its own `receipts` SSE-KMS metadata (`kms:InvalidCiphertextException`) — those objects were unmigratable. Tolerable on staging (regenerable); a hard STOP signal for any prod self-host cutover.

**Recovery (no data loss for `campaigns`/`branding`).** rclone-synced the listable buckets, ran `init.sh` to create the missing bucket + lifecycle, swapped the kamal-proxy route MinIO→SeaweedFS surgically (no container recreate), smoke-tested (200/403/200), removed the MinIO container keeping `data/minio`, re-ran the deploy to land green.

**Changes made to this runbook.**
- Step 3 now documents the **expected** proxy-conflict failure and that the per-push auto-deploy goes red by design during a same-host accessory swap.
- New **step 4b** (run `init.sh` for buckets + lifecycle) and **step 5b** (explicit host handoff) — the handoff was entirely missing before.
- Step 4 now warns about the MinIO-KMS-unreadable-objects failure mode and when it's a STOP.

**Follow-ups for the PROD cutover (`deploy-prod.yml`).** The same-host accessory swap **cannot** be done by a single automated push-deploy — the proxy host can only belong to one accessory at a time. Plan the prod cutover as an explicit operator sequence (migrate → init → route handoff → smoke → decommission), or teach the workflow's "Reboot accessories" step to release a conflicting same-host route before booting the replacement. Do **not** rely on the auto-deploy to do the handoff atomically.
