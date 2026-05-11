## ADR-023: Object Storage Bucket Topology — One Bucket per Visibility Class, Per-Tenant Key Prefix

**Status**: Accepted (Epic #286, 2026-05-05) · **Amended 2026-05-07** to add the `bank-statements` private bucket — see ADR-028.
**Related**: ADR-013 (frontend type boundary, no Node-only deps in shared), ADR-017 (one logical DB per tool — applied analogously to buckets), ADR-028 (camt.053 ingestion — `bank-statements` bucket), `docs/24-branding-assets.md`, `docs/25-swiss-qr-bill.md`, `docs/06-security-compliance.md`

### Context

Until Epic #286, the application held two object-storage buckets and both were **private**:

| Bucket | Visibility | Access pattern |
|---|---|---|
| `receipts` | Private | Signed URLs only — donor receipt PDFs |
| `campaigns` | Private | Signed URLs only — postal-export ZIPs (Epic #274) |

Logos, by contrast, are **donor-public** by definition. They render on:

- The Keycloak login screen (`infra/keycloak/themes/givernance/login/template.ftl` reads `organization.attributes['logo_url']` and `<img src=…>`s it).
- The public donation page `/p/[id]` hero — anonymous donor traffic, no JWT.
- The postal-letter PDF cover panel (Epic #274 + #286 lockstep).

The simplest path would be "drop logos into the existing `campaigns` bucket and slap a public-read ACL on those keys." That path is the foot-gun GDPR audits flag: a future operator misreads the convention, drops a constituent CSV next to a logo, and now a donor-list export is one curl away from anonymous discovery. Object-level ACLs in a primarily private bucket are a dual-mode configuration — and dual-mode buckets are how breaches happen.

Beyond the safety dimension, mixing donor-public assets with private signed-URL content forecloses CDN edge caching for the public-read assets (signed URLs aren't cacheable past their expiry; the CDN layer can't tell which keys are which without per-key heuristics).

### Decision

Each visibility class gets its **own bucket**, with **per-tenant key prefixes** as the in-bucket isolation mechanism.

The current topology after Epic #286 and the Epic #318 amendment:

| Bucket | Visibility | ACL model | Owners | Lifecycle |
|---|---|---|---|---|
| `receipts` | **Private** | Bucket-private, signed URLs only | Worker writes, API serves via presign | 7-year retention (EU fiscal) |
| `campaigns` | **Private** | Bucket-private, signed URLs only | Worker streams ZIPs, API serves via presign | `AbortIncompleteMultipartUpload` 1d |
| `branding` | **Public-read** | Bucket-level public-read; **no per-object ACL** | Worker writes processed variants, anonymous reads via direct URL | Nightly orphan-GC sweep + tenant-offboarding prefix-delete |
| `bank-statements` | **Private** | Bucket-private, signed URLs only | API stores raw camt.053 uploads, worker reads for reconciliation | **10-year retention** (Swiss CO Art. 958f) — see ADR-028 |

Inside `branding`, every key is prefixed by `org_id`:

```
{org_id}/logo/{logo_id}/original.{png|jpg|webp|svg}
{org_id}/logo/{logo_id}/sidebar.webp
{org_id}/logo/{logo_id}/preview.webp
{org_id}/logo/{logo_id}/public-hero.webp
{org_id}/logo/{logo_id}/pdf-letterhead.png
```

Tenant offboarding is a single command:

```bash
aws s3api delete-objects --bucket branding \
  --delete "$(aws s3api list-objects-v2 --bucket branding --prefix '{org_id}/' \
    --query '{Objects: Contents[].{Key: Key}}')"
```

Inside `bank-statements`, every key is also prefixed by `org_id`:

```
{org_id}/camt053/{yyyy}/{mm}/{filename}.xml            ← accepted uploads
{org_id}/camt053/rejected/{yyyy}/{mm}/{uuid}.xml       ← foreign-IBAN / XSD-fail
```

**Operational properties (`bank-statements`):**

- **Versioning + MFA-delete**: enabled. Bank statements are financial records under legal hold for 10 years; accidental or malicious deletion must require a separately-held credential (the Scaleway equivalent for SSE-S3 + bucket versioning + MFA-delete is `s3api put-bucket-versioning --mfa-delete=Enabled` on the bucket).
- **Server-side encryption**: SSE-S3 (Scaleway-managed keys) at rest. SSE-C is rejected — would saddle every reader (worker, signed-URL service, occasional forensic operator) with key-management plumbing for marginal benefit when the threat model already trusts Scaleway IAM.
- **Public-access block**: explicit `BlockPublicAcls: true`, `IgnorePublicAcls: true`, `BlockPublicPolicy: true`, `RestrictPublicBuckets: true`. Defense-in-depth even though no public ACL is ever set — a misconfigured policy mistake cannot accidentally expose statements.
- **Lifecycle interaction with erasure**: the 10-yr lifecycle is statute-mandated and **NOT short-circuited by GDPR Art. 17 erasure of the linked constituent**. CO Art. 958f overrides Art. 17 for legal-hold records; donor-facing surfaces filter erased rows via `constituents.deleted_at` but the raw bank file persists.

### Why `bank-statements` cannot reuse `receipts` (Epic #318 amendment)

Both buckets share the **same visibility class** (private, signed URLs only, no per-object ACL). The intuition is therefore "same visibility class → same bucket". The intuition is wrong here, because the **lifecycle policy differs**:

| Bucket | Retention | Source of the rule |
|---|---|---|
| `receipts` | **7 years** | EU fiscal (member-state averages — France `Code de commerce` L123-22, similar elsewhere) |
| `bank-statements` | **10 years** | Swiss Code of Obligations Art. 958f (10 years from end of business year, electronic archival permitted) |

S3 lifecycle policies apply at the **bucket level** — there is no per-prefix retention without spinning up object-level tagging plus tag-based lifecycle rules, which is the exact dual-mode complexity this ADR rejects in its rationale section. Co-locating Swiss bank statements in `receipts` would force one of three bad shapes:

1. Apply a 10-year retention to `receipts` — over-retains every donor receipt PDF for 3 extra years (proportionality issue under GDPR Art. 5(1)(e)).
2. Apply a 7-year retention to both — under-retains Swiss bank statements (statutory non-compliance).
3. Per-key tag-based lifecycle — re-introduces dual-mode complexity at the per-object layer.

Distinct **lifecycle policy** is therefore a sufficient condition to fork a new bucket, even when the visibility class matches. This refines the ADR's "one bucket per visibility class" framing: the operational invariant is **"one bucket per (visibility class × lifecycle policy)"** — visibility is the load-bearing dimension, lifecycle is a forking dimension.

### Rationale

- **Blast-radius separation.** A typo in a public bucket's CORS rule cannot leak private content because there is no private content in the same bucket. Defense-in-depth at the topology layer instead of at the per-object ACL layer.
- **GDPR cascade simplicity.** Right-to-erasure (Art. 17) and tenant-offboarding both reduce to a single `--prefix {org_id}/` delete per bucket. No object-level enumeration, no "did we miss the one with the legacy key?" risk.
- **CDN-cacheability without leaks.** `branding` keys can carry `Cache-Control: public, max-age=31536000, immutable` and sit behind Scaleway edge PoPs (or a Cloudflare front-CDN for self-hosted) without ever risking that a private receipt-PDF leaks through the same cache layer.
- **Audit clarity.** "List every object reachable by anonymous internet" = `aws s3api list-objects-v2 --bucket branding`. One bucket, one query, one list. Operations and DPO review love this.
- **Mirrors ADR-017 at the storage layer.** ADR-017 says "one logical DB per tool because tools have incompatible privilege models." The object-storage analogue is "one bucket per visibility class because visibility classes have incompatible ACL models." The principle is the same; the substrate is different.

### Rejected alternatives

| Option | Pros | Cons | Verdict |
|---|---|---|---|
| One mega-bucket with object-level ACLs (e.g. `assets` with public + private keys mixed) | One bucket to provision; shared lifecycle policy | A typo in one ACL leaks private content; GDPR audit nightmare ("prove no constituent CSV is publicly reachable" requires per-key sweep); CDN cannot blanket-cache | **REJECTED** — foot-gun |
| One bucket per asset type (`logos`, `receipts`, `campaign-zips`, `favicons`, …) | Maximum granularity | Bucket sprawl for marginal benefit at our scale; ops overhead per bucket (lifecycle, CORS, IAM) | **REJECTED for now** — revisit when we have 5+ asset types |
| Co-locate logos in `campaigns` with `Public: true` per object | Reuses an existing bucket | Same as the mega-bucket trap; the `campaigns` bucket's threat model assumes everything in it is private; mixing public objects defeats every reasoning shortcut | **REJECTED** — violates the bucket's stated invariant |
| Keep logo as a Keycloak Organization attribute pointing at an external URL (no S3 at all) | No bucket needed | We need 4 derived variants per logo (sidebar / preview / public-hero / pdf-letterhead) to avoid serving 5MB originals to mobile donors; no realistic place to store those except S3; "external URL" punts the storage problem to the operator's blog or Imgur | **REJECTED** — doesn't solve the variant pipeline |

### Consequences

- **Every new asset class first picks a visibility class** (public / private / archive). Reviewers reject co-mingling on PR review. The CLAUDE.md hard rule "🛑 One Bucket per Visibility Class (ADR-023)" mirrors the ADR-017 rule for logical DBs.
- **`branding` bucket lifecycle requires nightly orphan-GC.** Soft-deleted `org_branding_assets` rows must have their S3 keys swept on a schedule (the worker job is owned by Phase 1).
- **`next/image` `images.remotePatterns`** must include the Scaleway Object Storage hostname AND the dev MinIO hostname; both ship in the Phase 1 implementation.
- **Donor-facing pages disable Next image optimizer.** The variant served IS already at the right size; proxying through `/_next/image` for an anonymous donor wastes proxy bandwidth and breaks `immutable` caching at the edge.

### Revisit criteria

Reopen this ADR when:

- A new asset class doesn't fit any existing visibility class (e.g. **org-internal-only** documents readable by tenant members but not by donors — would need a third bucket with signed-URL serving but no donor exposure).
- The number of buckets grows past ~5; at that point, either consolidate (back toward fewer-larger buckets) or formalise a per-bucket lifecycle catalogue.
- A multi-region deployment forces per-region replication; the bucket-per-class topology may need to fork into bucket-per-class-per-region.
