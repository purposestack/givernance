## ADR-034: SeaweedFS over MinIO for self-hosted / local-dev / staging object storage

**Status**: Accepted (Issue #462, 2026-06-02)
**Related**: ADR-009 (Scaleway Object Storage for SaaS prod — **unchanged** by this ADR), ADR-017 (one logical DB per tool — governs the SeaweedFS filer metadata store), ADR-023 (object-storage bucket topology — the contract this migration preserves), ADR-024 (image pipeline), ADR-028 (camt.053 ingestion — the `bank-statements` bucket's versioning + WORM needs, documented here but not yet provisioned)

### Context

MinIO was our S3-compatible object store for the three deployment tiers where we run our own storage — **local dev** (Docker Compose), the **self-hosted distribution** we ship to NPOs, and **staging** (Kamal accessory on a single VM). Production (SaaS) uses Scaleway Object Storage EU and is **not** affected.

Over 2025 MinIO effectively abandoned its open-source edition:

- **May 2025** — the admin Console / management UI was stripped from the Community Edition (PR #3509), leaving a read-only object browser; external IdP logins (LDAP/OIDC) moved to the paid AIStor product.
- **Oct 2025** — MinIO stopped publishing Community Edition Docker images and pre-built binaries.
- **Dec 3 2025** — the open-source repo officially entered **maintenance mode**: no new features, no PR/issue review, **security fixes only "as appropriate"**, no more Docker images / RPM / DEB. Anyone needing updates is told to buy AIStor.

For a GDPR-native product we ship to NPOs who **self-host**, depending on an abandoned container with no guaranteed security patches is a non-starter. We need an actively-maintained, **permissively-licensed** (not AGPL — that is the licensing trap we are escaping with this move), single-node-friendly, S3-compatible replacement that preserves the ADR-023 bucket contract bit-for-bit so **no application code changes**.

### Decision

**Migrate the three self-hosted tiers (local dev, self-hosted distribution, staging) from MinIO to [SeaweedFS](https://github.com/seaweedfs/seaweedfs) (Apache 2.0).** Production stays on Scaleway Object Storage (ADR-009) — that path is untouched.

The application talks pure S3 via `@aws-sdk/client-s3` v3 with `forcePathStyle: true` (`packages/api/src/lib/s3.ts`, `packages/worker/src/lib/s3.ts`). There are no `minio` SDK imports. The migration is therefore **infra + config + provisioning + docs only**; the S3 client code is untouched and the `ServerSideEncryption: "AES256"` header path stays identical to the Scaleway prod path.

Pinned version: **`chrislusf/seaweedfs:4.31`** (latest stable as of 2026-06-02). Single-node run is `weed server -s3`, which brings up master (9333), volume (8080), filer (8888) and the **S3 gateway on 8333** (MinIO listened on 9000).

### Alternatives matrix

| Candidate | License | Versioning | Lifecycle expiry | SSE-S3 | Object Lock (WORM) | Single-node fit | Maturity | Verdict |
|-----------|---------|-----------|------------------|--------|--------------------|-----------------|----------|---------|
| **SeaweedFS** | **Apache 2.0** | ✅ | ✅ (S3 lifecycle) | ✅ (KEK-derived global key) | ✅ | ✅ great | ~33k★, very active (4.31 on 2026-06-02) | ✅ **CHOSEN** |
| Garage | **AGPL v3** ⚠ | ❌ | ❌ | SSE-C only | ❌ | geo-distributed focus | active | ❌ AGPL = the same trap; missing versioning/lifecycle/SSE-S3 (breaks ADR-023 reports/bulk-imports expiry + bank-statements versioning) |
| RustFS | Apache 2.0 | partial | partial | ✅ | partial | ✅ | **alpha — "do NOT use in production"** | ❌ not prod-ready |
| Ceph RGW | LGPL | ✅ | ✅ | ✅ | ✅ | ❌ heavy, multi-daemon | mature | ❌ operational weight wrong for a 2-person NPO self-host |
| Stay on MinIO | AGPL + abandoned | ✅ | ✅ | ✅ (needs KMS) | ✅ | ✅ | **maintenance-mode, no security patches** | ❌ the problem |

### Rationale

SeaweedFS is the only candidate that is simultaneously (a) **permissively licensed** (Apache 2.0, not AGPL), (b) **actively maintained** (frequent releases, the 4.x line shipped 4.31 the day this ADR was written), (c) **feature-complete for ADR-023** — per-bucket lifecycle expiry (90-day `bulk-imports`, 365-day `reports`), SSE-S3 with the `AES256` header the worker already sends, public-read ACL for `branding`, multipart upload for the `@aws-sdk/lib-storage` streaming path, plus versioning + object-lock for the future `bank-statements` bucket (ADR-028) — and (d) **runs comfortably as a single node**, which is exactly our local-dev + single-VM-Kamal-staging + small-NPO-self-host shape.

Garage's geo-distributed CRDT design is the opposite of our deployment model, and it lacks versioning/lifecycle/SSE-S3 outright — each of which is load-bearing in ADR-023. RustFS is alpha and self-describes as not-for-production. Ceph RGW is operationally far too heavy for a two-person NPO to self-host.

#### SSE-S3 mechanism (the #1 migration risk, de-risked)

The worker sets `ServerSideEncryption: "AES256"` on **every** receipt/campaign/report PutObject. On MinIO this required `MINIO_KMS_SECRET_KEY` or every upload 403'd with `NotImplemented: Server side encryption specified but KMS is not configured`.

SeaweedFS implements SSE-S3 with a **server-side Key-Encryption-Key (KEK)** configured on the S3 gateway (via `WEED_S3_SSE_KEY` / `WEED_S3_SSE_KEK` env, or `security.toml [s3.sse]`). The DEK-per-object is wrapped by the KEK (envelope encryption). We set `WEED_S3_SSE_KEY` to a passphrase (HKDF-derived KEK) — a committed throwaway value for dev, a per-environment secret for staging — so the `AES256` request header succeeds and the code path stays identical to Scaleway prod. **The KEK must be stable across restarts** wherever data persists (staging), or previously-encrypted objects become unreadable — same operational property MinIO's `MINIO_KMS_SECRET_KEY` had.

#### Provisioning differs (`mc` is gone)

SeaweedFS has no `mc` equivalent. Bucket creation + per-bucket lifecycle are applied via the **S3 API** (`CreateBucket`, `PutBucketLifecycleConfiguration`) from the init step. Public-read for `branding` is **not** a runtime ACL call — it is a static `anonymous` identity scoped to `Read:branding` in the S3 config JSON (`-s3.config`), applied at gateway start. Every other bucket has no anonymous identity, so it denies anonymous reads — preserving the ADR-023 "branding public, everything else private" invariant deterministically (no init-container race, no copy-pasted-`mc anonymous set` foot-gun). This refines ADR-023's provisioning note; the topology itself is unchanged.

#### Filer metadata store stays embedded (ADR-017)

SeaweedFS's filer can persist metadata to Postgres. We deliberately keep the **embedded leveldb store** (the default) so there is **no new Postgres dependency** and no risk of co-locating filer metadata with the `givernance` or `givernance_keycloak` logical DBs — which would violate ADR-017. If a Postgres-backed filer is ever justified (HA), it gets its **own** logical DB + role per ADR-017.

### Rejected alternatives

- **Garage** — AGPL v3 is the very licensing trap this migration escapes, and it lacks bucket versioning, lifecycle expiry, and SSE-S3, each of which ADR-023 depends on. Its CRDT geo-distribution is the opposite of our single-node shape.
- **RustFS** — Apache 2.0 and S3-compatible, but alpha-stage and explicitly "do NOT use in production". Revisit if it reaches GA.
- **Ceph RGW** — feature-complete and mature, but multi-daemon operational weight is wrong for a two-person NPO self-host.
- **Stay on MinIO** — the abandoned, maintenance-mode, AGPL status is exactly the problem.
- **Point the filer at the `givernance` Postgres DB** — rejected per ADR-017; embedded leveldb avoids the question entirely.

### Consequences

- **No application code change.** `S3_*` env contract, bucket names, key prefixes, and the `AES256` header all stay identical. DB rows that captured the bucket name at write time (`bulk_import_files.s3_bucket`, `camt_statements.s3_bucket`) keep working — bucket names are unchanged, so no DB migration.
- **Port change `9000` → `8333`.** `S3_ENDPOINT`, the Compose service/healthcheck, and the Kamal `assets.staging.givernance.org` proxy `app_port` move to 8333. `next/image` `images.remotePatterns` gains the SeaweedFS dev host/port.
- **New env `WEED_S3_SSE_KEY`** replaces `MINIO_KMS_SECRET_KEY` (and `MINIO_ROOT_USER/PASSWORD` are replaced by the S3-config identity credentials, surfaced to the app as the existing `S3_ACCESS_KEY_ID` / `S3_SECRET_ACCESS_KEY`). The staging kamal-secrets composite action drops the 32-byte-base64 KMS validation (SeaweedFS derives the KEK via HKDF, no length constraint).
- **Healthcheck endpoint** moves from `/minio/health/live` to the SeaweedFS S3 gateway health path.
- **CI unaffected.** Integration tests mock `../../lib/s3.js`; CI spins up only Postgres + Redis. No S3 container in CI — this ADR does not add one.
- **Staging needs a one-shot object migration** (`rclone`/`aws s3 sync` MinIO → SeaweedFS, verify counts + checksums, cut `S3_ENDPOINT` over, decommission MinIO). Local dev is ephemeral / re-seedable — no data migration. See `docs/runbooks/minio-to-seaweedfs-cutover.md`.

### Revisit criteria

Reopen this ADR when:

- SeaweedFS changes its licensing or maintenance posture (the exact failure mode that retired MinIO).
- A self-hosted NPO outgrows single-node and needs HA — at which point the filer metadata store (ADR-017 logical DB) and a multi-volume topology come into scope.
- The `bank-statements` bucket (ADR-028) is implemented and its versioning + MFA-delete / object-lock needs must be validated against the pinned SeaweedFS version before go-live.
- A managed non-Scaleway EU provider becomes compelling for the self-hosted tier (unlikely — self-hosters want no external dependency).
