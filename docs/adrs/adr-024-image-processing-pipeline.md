## ADR-024: Image Processing Pipeline — `sharp` + Async BullMQ Worker + Content-Addressed Pre-Generated Variants

**Status**: Accepted (Epic #286, 2026-05-05)
**Related**: ADR-023 (bucket topology), ADR-013 (frontend type boundary), `docs/24-branding-assets.md`

### Context

The org-logo upload feature (Epic #286) needs **four derived variants** of every uploaded logo, sized for the surfaces that consume them:

| Variant key | Dimensions | Format | Consumer |
|---|---|---|---|
| `sidebar` | 128×128 (retina-2× of 64) | WebP | Left navigation sidebar above the tenant-switcher |
| `preview` | 240×240 | WebP | Onboarding step + Settings → Organisation hero card |
| `public-hero` | 800×800 (`object-fit: contain`) | WebP | Public donation page `/p/[id]` hero + Keycloak login screen |
| `pdf-letterhead` | 360×360 px @ 300 DPI | PNG | Postal-letter PDF cover panel — 30×30mm rendered |

A single 5MB PNG, processed through `sharp` for four variants, takes **200–800ms** of CPU time. Doing that synchronously in the upload handler means:

- The Fastify route blocks for the worst-case duration of the slowest variant — well over the 200ms p95 SLO that the rest of the API holds.
- Burst uploads (a self-serve onboarding flash crowd, or a multi-tenant migration sprint) can stall the entire API event loop because `sharp`'s libvips backend pegs a CPU core per request.
- A retry on a transient S3 5xx in the middle of variant 3 of 4 leaves a partially-processed asset and no clean recovery story.

The variant set is also expected to evolve. Phase 2 will add an `email-signature` variant for transactional/bulk emails (per Epic #279); Phase 3 will add `favicon`, `og-image`, dark-mode, and so on. Hard-coding the variant set as columns on the `org_branding_assets` table would force a migration every time the matrix changes.

### Decision

**Three-stage pipeline**, async-by-default, content-addressed at the key layer:

#### Stage 1 — API handler (synchronous, fast)

`POST /v1/branding/org-logo` (multipart):

1. Validate magic bytes via `file-type` (reject anything not in `{image/png, image/jpeg, image/webp, image/svg+xml}`).
2. Enforce size cap: 5MB raster, 1MB SVG.
3. Enforce dimension cap: 4096×4096 (probe via `sharp({ failOnError: false }).metadata()` before any pixel operation).
4. Strip EXIF (privacy — uploaded JPEG with GPS coords doesn't leak).
5. **SVG** path: sanitise via the strict allowlist (`svg, g, path, rect, circle, ellipse, line, polyline, polygon, defs, linearGradient, radialGradient, stop, title, desc`); reject `<script>`, `<foreignObject>`, external `<use href>`, every `on*` event handler.
6. Write `original.{ext}` to `s3://branding/{org_id}/logo/{logo_id}/`.
7. `INSERT INTO org_branding_assets … VALUES (…, status='pending', s3_key_variants='{}')`.
8. `INSERT INTO outbox_events … type='branding.process_asset'` in the same transaction.
9. Return `201 Created` with the asset row.

The handler is **bounded by file I/O**, never by image transformation. UI polls `GET /v1/branding/org-logo` for ~1s until `status='ready'`.

#### Stage 2 — Worker (`branding.process_asset` job)

The outbox relay enqueues the job. The worker:

1. Pulls `original.{ext}` from S3.
2. Runs `sharp` once per variant (sidebar / preview / public-hero / pdf-letterhead).
3. Writes each variant under the **same content-addressed prefix** `{org_id}/logo/{logo_id}/{variant}.{ext}`.
4. UPDATEs `org_branding_assets SET status='ready', s3_key_variants=jsonb_object_agg(...) WHERE id=$1`.
5. Enqueues a follow-up `keycloak.sync_org_logo` outbox event (Stage 3).

On failure: status flips to `'failed'`, the asset row keeps its `original` (so the operator can retry without re-uploading). BullMQ retry policy applies; after exhaustion, the row stays `'failed'` and the UI surfaces a "Reprocess" CTA.

#### Stage 3 — Keycloak sync (`keycloak.sync_org_logo` job)

Idempotent PATCH against the Keycloak Admin API: GET-then-PUT on `/organizations/{kc_org_id}` merging `attributes.logo_url = [public-hero variant URL]`. Documented at greater length in `docs/24-branding-assets.md` § 4 and in `docs/05-integration-migration.md` § 5.

#### Content-addressing & cache headers

- `{logo_id}` is a UUID minted at upload time. It is **never reused**: replacing the logo mints a new `org_branding_assets` row (and a new `logo_id`), updates `tenants.logo_asset_id` to point at the new row, and lets the old row drift to nightly orphan-GC.
- Every variant URL therefore has a stable byte-equivalent meaning: `Cache-Control: public, max-age=31536000, immutable` is safe.
- Postal letters already in the post box (carrying the OLD `public-hero` URL printed as a QR-flanking footer image) keep working: the old row stays in S3 until orphan-GC, which only fires after a configurable grace window.

#### Variants stored as JSONB, not columns

`org_branding_assets.s3_key_variants` is a JSONB map:

```json
{
  "sidebar": "{org_id}/logo/{logo_id}/sidebar.webp",
  "preview": "{org_id}/logo/{logo_id}/preview.webp",
  "public-hero": "{org_id}/logo/{logo_id}/public-hero.webp",
  "pdf-letterhead": "{org_id}/logo/{logo_id}/pdf-letterhead.png"
}
```

The variant key set is a **single TypeScript union type** in `@givernance/shared`:

```typescript
export type BrandingVariantKey =
  | "sidebar"
  | "preview"
  | "public-hero"
  | "pdf-letterhead";
```

Zod validates on read; we never query `WHERE variants->'sidebar' = …` (always lookup by `id` then read the JSONB). Adding a new variant is one line in the union and one branch in the worker pipeline — no migration.

### Rationale

- **Async preserves the API SLO.** The 200–800ms variant-gen window is moved off the hot path; the upload handler stays under 200ms p95.
- **Content-addressing enables `Cache-Control: immutable`.** This is what makes per-donor edge-cache hits free at the CDN layer for the public donation page.
- **JSONB variant map evolves without migrations.** The shared TypeScript union is the source of truth; the schema is intentionally permissive at the SQL layer.
- **`sharp` is the only realistic Node-side image library.** libvips-backed, ~5–10× faster than ImageMagick on the workloads we care about, mature WebP/AVIF/PNG/JPEG, automatic EXIF orientation. Nothing else gets close on the perf-vs-maturity Pareto front.
- **One pipeline owner (the worker) means one place to evolve.** Variant set, format choice, quality settings, and Keycloak sync all live in `packages/worker/src/processors/branding-process-asset.ts` and `…/keycloak-sync-org-logo.ts`. The frontend reads what's there and renders accordingly.

### Rejected alternatives

| Option | Pros | Cons | Verdict |
|---|---|---|---|
| **Synchronous in API handler** | One service to reason about | Blocks event loop on burst uploads; no retry story; partial-failure stranded state; can't add expensive variants (PDF letterhead at 300DPI) without breaking the SLO | **REJECTED** — breaks API SLO |
| **On-the-fly transformer (imgproxy / Cloudflare Images)** | Variants generated lazily, no pre-gen worker | Adds a sidecar service + per-tenant CDN config; cold-start latency on first hit; cost scales with donor traffic instead of with logo count; more moving parts than this Epic warrants | **DEFERRED to Phase 2** — re-evaluate when on-the-fly value > pre-gen cost |
| **ImageMagick instead of sharp** | Nostalgia | 5–10× slower per variant; CVE history is significantly worse; Alpine container needs more wrangling | **REJECTED** |
| **Variants as columns** (`s3_key_sidebar`, `s3_key_preview`, …) | SQL-typed access | One migration per variant added; the schema becomes a leading indicator of the variant set instead of the TypeScript union being the source of truth | **REJECTED** — wrong source of truth |
| **`variants_schema_version` integer column** | Explicit versioning | Premature complexity for a hypothetical migration; the bump-the-key strategy below covers the real case without a versioning column | **REJECTED** — YAGNI |

### Variant evolution strategy ("bump the key")

When a variant's spec changes (e.g. `sidebar` from 128×128 to 256×256 for a future high-DPI sidebar redesign):

1. Add a new key (`sidebar-v2`) to the TypeScript union.
2. Worker derives `sidebar-v2` on the next `branding.process_asset` job for any asset (and via a one-shot backfill job for the in-place `'ready'` rows).
3. Frontend consumers switch from `sidebar` → `sidebar-v2` in a single commit.
4. After the rollout, the old `sidebar` key can be dropped from the union AND from `s3_key_variants` (orphan-GC deletes the now-unused S3 keys).

There is **no `variants_schema_version` column**, no migration. The strategy is documented in `docs/24-branding-assets.md` § 8.

### Consequences

- **Variant set = one TypeScript union type owned by `@givernance/shared`.** Adding/removing a variant is a code change, not a schema change. Reviewers enforce this on PR review.
- **UI must handle the ~1s pending window.** The upload form polls `GET /v1/branding/org-logo` every 250–500ms until `status='ready'`, then re-renders with the variants. A subtle "Processing your logo…" spinner covers the window; the upload itself is acknowledged immediately.
- **Worker LRU cache for PDF embedding** keyed by `logo_asset_id`, max 50 entries (~10MB), 1h TTL. Postal exports run in batches of thousands of recipients; without the cache, each recipient PDF would re-fetch the same logo from S3.
- **`sharp` install on Alpine requires `vips-dev` / `libvips42`.** API and worker Dockerfiles must include the apt/apk lines; CI must verify the install at image-build time.

### Revisit criteria

Reopen this ADR when:

- End-to-end variant generation (queue ack → all variants written → row flipped to `'ready'`) **exceeds 1s** on a representative input. The bottleneck moves from CPU to either S3 latency or BullMQ scheduling, and the pipeline shape needs to change (sharp pool? dedicated worker? on-the-fly fallback?).
- **5+ tenants** routinely saturate the worker — at that point evaluate either a `sharp` worker pool inside the BullMQ processor or splitting branding off into a dedicated `image-worker` deployment.
- A new asset class needs **on-the-fly transformations** that the pre-gen variant set can't cover (e.g. arbitrary cropping for an OG-image generator).
