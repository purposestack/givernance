# 23 — Postal Campaigns & QR Reconciliation

> **Status**: Implemented — Epic #274
> **Owner**: Mailing Engineer
> **Related**: `02-reference-architecture.md`, `03-data-model.md`, `04-business-capabilities.md`, `06-security-compliance.md`, `15-infra-adr.md`, `17-log-management.md`
> **Closes**: #274

## 0. Why this exists — at a glance

European NPOs raise a sizeable share of their revenue through **printed direct-mail campaigns** ("appel postal", "publipostage"). The donor receives a personalised letter, scans the printed QR code on their smartphone, and is taken to a donation page where the gift is **automatically attributed back to the campaign + the recipient**.

Givernance ships this whole pipeline as a first-class feature so an operator can:

1. **Curate a recipient list** for a campaign (independent of donations — no more "donations à 0 €" workaround).
2. **Generate a printable archive** (`zip` of A4 PDFs, one per recipient) ready to hand to the print shop.
3. **Reconcile** donations made by QR-scan back to the campaign and the original recipient — every euro raised becomes a measurable scan-to-donate funnel.

The MVP supports two **mailing modes**:

| Mode | Distribution | Letter content | QR points to |
|---|---|---|---|
| **Personnalisé** (`personalized`) | One letter per recipient | "Cher·e {firstName} {lastName}" salutation | `/p/:campaignId?qr=<token>` — token bound to (campaign, constituent) |
| **Door-drop** (`door_drop`) | Mass-printed, hand-delivered by neighborhood | Generic body, no salutation | `/p/:campaignId?qr=<token>` — token bound to campaign only (no constituent) |

Both modes use the **same opaque-token mechanism** (~120 bits of entropy per token, server-resolved). The difference is whether the resolution carries a `constituentId` or only a `campaignId`.

## 1. End-to-end user flow

```mermaid
sequenceDiagram
    autonumber
    actor Op as Operator (org_admin)
    participant Web as Next.js (web)
    participant API as Fastify (api)
    participant DB as Postgres
    participant Worker as BullMQ worker
    participant S3 as Object storage<br/>(MinIO / Scaleway)
    actor Donor

    Note over Op,Web: 1. Build the recipient list
    Op->>Web: Open campaign detail page
    Op->>Web: Click "Add constituents" → search dialog
    Web->>API: POST /v1/campaigns/:id/constituents { ids[] }
    API->>DB: INSERT campaign_constituents (idempotent)
    API->>DB: INSERT outbox_events ('campaign.constituents_added')

    Note over Op,Web: 2. Validate the print layout
    Op->>Web: Click "Aperçu PDF"
    Web->>API: POST /v1/campaigns/:id/postal-preview { mode }
    API->>API: Render PDF with "Jean Dupont" fixture<br/>(no DB writes, never-registered QR)
    API-->>Web: application/pdf (inline)
    Web->>Donor: window.open(blob)

    Note over Op,Web: 3. Generate the print archive
    Op->>Web: Click "Generate ZIP"
    Web->>API: POST /v1/campaigns/:id/postal-exports { mode }
    API->>DB: Validate readiness gates<br/>(active campaign, published page)
    API->>DB: INSERT campaign_postal_exports (status=pending)
    API->>DB: INSERT outbox_events ('campaign.postal_export_requested')
    API-->>Web: 202 + exportId
    Web->>Web: Start polling GET /:exportId every 2s

    Note over Worker,S3: 4. Async generation pipeline
    DB->>Worker: outbox relay enqueues job
    Worker->>DB: UPDATE status=processing
    loop Per recipient
      Worker->>Worker: Mint opaque QR token (15B base64url)
      Worker->>DB: INSERT campaign_qr_codes
      Worker->>Worker: Render PDFKit letter + embed QR PNG
      Worker->>S3: Append to streaming archiver
      Worker->>DB: UPDATE progress_count++ (live polling)
    end
    Worker->>S3: Finalise ZIP (multipart upload)
    Worker->>DB: UPDATE status=completed, zip_s3_path

    Note over Op,Donor: 5. Print → distribute → scan → donate
    Op->>Op: Download ZIP, send to print shop
    Op->>Donor: Postal letter delivered
    Donor->>Web: Scan QR → /p/:campaignId?qr=<token>
    Web->>API: GET /v1/public/qr/:code (resolver)
    API->>DB: UPDATE scanned_at = NOW() (first contact only)
    API-->>Web: { campaignId, constituentId? }
    Donor->>Web: Fill donation form → submit
    Web->>API: POST /v1/public/.../donate { amount, ..., qrCode }
    API->>API: Resolve qrCode → metadata.qr_code_id<br/>+ qr_code_constituent_id
    API->>Donor: Stripe PaymentIntent (3DS)

    Note over API,DB: 6. Reconciliation (Stripe webhook)
    API->>API: Receive checkout.completed webhook
    API->>DB: INSERT donations (campaignId, constituentId,<br/>qrCodeId from metadata)
    API->>DB: Update QR attribution stats
```

## 2. Domain model

```mermaid
erDiagram
    tenants ||--o{ campaigns : "owns"
    campaigns ||--o| campaign_public_pages : "has 0..1<br/>(donor-facing)"
    campaigns ||--o{ campaign_constituents : "mailing list"
    campaigns ||--o{ campaign_postal_exports : "produced"
    campaigns ||--o{ campaign_qr_codes : "minted"
    campaigns ||--o{ campaign_documents : "rendered PDFs"
    constituents ||--o{ campaign_constituents : "is recipient on"
    constituents ||--o{ campaign_qr_codes : "scanned by"
    constituents ||--o{ donations : "gave"
    campaigns ||--o{ donations : "raised"
    campaign_qr_codes ||--o| donations : "attributes via metadata"
    users ||--o{ campaign_constituents : "added_by (FK)"
    users ||--o{ campaign_postal_exports : "requested_by (FK)"

    campaigns {
        uuid id PK
        uuid org_id FK
        string name
        enum type "nominative_postal | door_drop | digital"
        enum status "draft | active | closed"
    }
    campaign_public_pages {
        uuid campaign_id PK
        enum status "draft | published"
        string title
        text description
        int goal_amount_cents
    }
    campaign_constituents {
        uuid id PK
        uuid org_id FK
        uuid campaign_id FK
        uuid constituent_id FK
        uuid added_by FK "users.id (nullable)"
        timestamp added_at
    }
    campaign_postal_exports {
        uuid id PK
        uuid org_id FK
        uuid campaign_id FK
        enum mode "personalized | door_drop"
        enum status "pending | processing | completed | failed"
        int total_count
        int progress_count
        string zip_s3_path
        text error
        uuid requested_by FK "users.id (nullable)"
        timestamp completed_at
    }
    campaign_qr_codes {
        uuid id PK
        uuid org_id FK
        uuid campaign_id FK
        uuid constituent_id FK "nullable for door_drop"
        string code "120-bit opaque token"
        timestamp scanned_at "first scan stamp"
    }
    campaign_documents {
        uuid id PK
        uuid org_id FK
        uuid campaign_id FK
        uuid constituent_id FK "nullable"
        string s3_path
        enum status "pending | generated | failed"
    }
    donations {
        uuid id PK
        uuid campaign_id FK
        uuid constituent_id FK
        uuid qr_code_id FK "nullable, set by Stripe webhook"
        int amount_cents
    }
```

### Why a separate `campaign_constituents` table?

Before this change, the **only** way to associate a constituent with a campaign was to record a donation. NPO admins worked around this by creating placeholder "donations à 0 €" — polluting the donation table, the receipts pipeline, and every fundraising KPI.

The new table:

- **Lives independently** of the donation history (a recipient can be on the mailing list without ever giving)
- **Idempotent** via the unique `(org_id, campaign_id, constituent_id)` constraint + `ON CONFLICT DO NOTHING`
- **Carries the audit trail** (`added_by`, `added_at`) so the GDPR Art. 5(2) accountability principle holds: who put this person on which mailing
- **Refused on `door_drop` campaigns** by design — door-drop targets a geographic area, not a recipient list

## 3. Architecture (request → worker → archive)

```mermaid
flowchart LR
    subgraph Browser["Operator browser"]
        UI[CampaignMembersCard<br/>+ PostalExportPanel]
    end

    subgraph Web["Next.js (BFF / proxy)"]
        Page[/p/:id route]
    end

    subgraph API["Fastify API"]
        PR[postal-routes.ts]
        PES[postal-export-service.ts]
        QRS[qr-stats-service.ts]
        PUB[public/service.ts]
    end

    subgraph Outbox["Transactional outbox"]
        OBE[(outbox_events)]
        Relay[outbox-relay]
    end

    subgraph BullMQ["BullMQ queues"]
        CQ[campaigns queue]
    end

    subgraph Worker["Worker"]
        WP[postal-export.ts processor]
        PDF[postal-pdf.ts<br/>PDFKit + qrcode]
        ZIP[archiver]
    end

    subgraph Storage["Object storage<br/>(MinIO / Scaleway)"]
        S3[(campaigns bucket)]
    end

    subgraph DB["Postgres"]
        T[(tenants tables<br/>RLS by app_current_organization_id)]
    end

    UI -->|POST /postal-exports| PR
    PR --> PES
    PES -->|INSERT pending| T
    PES -->|INSERT outbox| OBE
    Relay -->|enqueue| CQ
    CQ -->|consume| WP
    WP --> PDF
    WP --> ZIP
    PDF -->|PDF stream| ZIP
    ZIP -->|multipart upload| S3
    WP -->|progress++ live| T

    UI -.poll 2s.-> PR
    PR -->|GET /postal-exports/:id| PES
    PES -.read state.-> T

    Donor -->|scan QR| Page
    Page -->|GET /public/qr/:code| PUB
    PUB -->|stamp scanned_at<br/>via systemDb BYPASSRLS| T
```

### Key design decisions

| # | Decision | Why |
|---|----------|-----|
| 1 | **Outbox pattern** for kicking off the worker | Same Postgres transaction guarantees the export row + the work order land atomically; the relay separates the in-process commit from the queue dispatch |
| 2 | **Streaming ZIP** through `archiver` → `PassThrough` → S3 multipart | A 10k-recipient campaign never materialises in memory or on disk — RAM stays bounded regardless of fan-out |
| 3 | **Live `progress_count` writes** per PDF | The 2-second polling on the frontend gives the operator a real progress bar instead of a "~5 minutes" estimate |
| 4 | **Sequential PDF generation** (vs. fan-out) | Simpler transaction boundary; suffices for MVP volumes (<1000 recipients). The legacy `campaign-documents` processor's semaphore pattern is the upgrade path if needed |
| 5 | **`systemDb` (BYPASSRLS) on `/v1/public/qr/:code`** | The endpoint is unauthenticated — no `app.current_organization_id` to set for RLS. The 120-bit opaque token IS the security boundary; rate-limiting (60/min) bounds brute force |
| 6 | **`/p/:id` as the canonical donor URL** (not `/c/:id`) | Matches the existing public donation page route. A permanent 308 redirect at `/c/[id]` keeps already-printed legacy letters working |
| 7 | **`PostalCampaignSection` wrapper** | Two sibling client components (`CampaignMembersCard`, `PostalExportPanel`) share live state (`memberCount`) without lifting it to the server-rendered parent |

## 4. Readiness gates (don't print useless letters)

A printed letter is irreversible — a typo can't be edited once it's in the post box. The export pipeline therefore enforces **two pre-conditions** before queueing any work, in **two layers** for defense-in-depth.

### API layer (`startPostalExport`)

The route returns a structured 400 with the **error code as `title`** so the client can branch on it:

| Code | Cause | Operator fix |
|---|---|---|
| `campaign_not_active` | `campaigns.status` is `draft` or `closed` | Open the status panel and switch to **Active** |
| `public_page_missing` | No `campaign_public_pages` row exists | Configure the page at `/campaigns/:id/public-page` |
| `public_page_draft` | Public page exists but is in `draft` state | Switch the page status to **Published** |
| `personalized_on_door_drop` | `mode=personalized` requested on a `door_drop` campaign | Use `mode=door_drop` or switch the campaign type |
| `no_recipients` | `mode=personalized` with zero linked constituents | Attach recipients first |

### UI layer (`PostalExportPanel`)

When either readiness gate fails, the panel renders a `<ReadinessBanners />` card with the matching copy and a CTA link straight to the missing config. The **Generate ZIP** button is disabled with a `title=` tooltip explaining the blocker.

The **Preview** button stays **enabled** even when readiness fails — it produces a fake-data sample with a never-registered QR token. This is the chicken-and-egg fix: the operator needs to validate the print layout before publishing the donor-facing page.

```mermaid
flowchart TD
    Start([Click Generate ZIP]) --> A{Campaign<br/>status?}
    A -->|draft / closed| B[Banner: Activate first]
    A -->|active| C{Public page?}
    C -->|missing| D[Banner: Configure first<br/>+ CTA → /public-page]
    C -->|draft| E[Banner: Publish first<br/>+ CTA → /public-page]
    C -->|published| F{Mode?}
    F -->|personalized<br/>+ door_drop campaign| G[400 personalized_on_door_drop]
    F -->|personalized<br/>+ no recipients| H[400 no_recipients]
    F -->|valid| I[Insert export job<br/>→ outbox → worker]
    B -.->|Disabled button + tooltip| Start
    D -.->|Disabled button + tooltip| Start
    E -.->|Disabled button + tooltip| Start
```

## 5. QR reconciliation flow

Every printed letter carries a unique opaque token (`base64url(15 random bytes)` = 20 characters, ~120 bits of entropy). The token reveals nothing about the recipient or the tenant — it's a server-side lookup key only.

### Token resolution

```mermaid
sequenceDiagram
    actor Donor
    participant Page as /p/:id
    participant API as /v1/public/qr/:code
    participant DB

    Donor->>Page: Scan QR → opens browser
    Page->>API: GET /v1/public/qr/<token>
    API->>DB: SELECT FROM campaign_qr_codes<br/>WHERE code = $1<br/>(systemDb, BYPASSRLS)
    alt Token unknown
        API-->>Page: 404 Not Found
        Page-->>Donor: Render donation page<br/>(no attribution)
    else First scan
        API->>DB: UPDATE scanned_at = NOW()<br/>(idempotent: only if NULL)
        API-->>Page: { campaignId, constituentId? }
        Page-->>Donor: Render with attribution context
    else Repeat scan
        Note over API,DB: scanned_at already set,<br/>no re-write
        API-->>Page: { campaignId, constituentId? }
    end
```

`scanned_at` is the **first-contact** timestamp — it's never overwritten by repeat scans, so the operator's KPI ("how many distinct codes were scanned") stays accurate.

### Donation attribution

When the donor submits the form, the public page forwards `qrCode` to the donate-intent endpoint, which:

1. Validates the token format (10–32 chars, base64url alphabet)
2. Resolves it server-side against `campaign_qr_codes`
3. Stamps `qr_code_id` and `qr_code_constituent_id` into the **Stripe PaymentIntent metadata**
4. Returns the client secret for Stripe.js to confirm the payment

The Stripe webhook (`processStripeWebhook`) reads the metadata when the payment lands and:

- Inserts the `donations` row with `campaign_id` AND `qr_code_id` populated
- If `qr_code_constituent_id` is present, links the donation to the original mail recipient (even if the donor entered a different email — the QR token is the trustworthy attribution)

The QR-tracking widget on the campaign admin page (`qr-stats-service.ts`) aggregates:

| Metric | Definition |
|---|---|
| `totalCodes` | Count of `campaign_qr_codes` rows for the campaign |
| `scannedCodes` | Count where `scanned_at IS NOT NULL` |
| `qrAttributedDonations` | Count of `donations` where `qr_code_id` is set |
| `qrAttributedAmountCents` | Sum of cleared/refunded amounts via QR scan |

This gives the operator a real **scan-to-donate funnel**: codes printed → codes scanned → donations completed → revenue attributed.

## 6. Bulk email follow-up

Postal campaigns are paired with a **digital follow-up** mechanism so the operator can re-engage the same recipients via email after the printed mailing.

| Surface | Behaviour |
|---|---|
| Constituents list filter bar | New filters: `lastDonationFrom/To`, `totalAmountMinCents/Max`, `campaignId` (matches both `campaign_constituents` linkage AND donation history — union semantics) |
| Multi-select toolbar | Bulk-email dialog accepts a free-form subject + body, hits `POST /v1/constituents/bulk-email` |
| Worker job | Sequential send via `defaultEmailSender` (Mailpit local / Resend prod), per-recipient errors logged but never abort the batch |
| Reachability counter | `requested` (total ids) vs. `reachable` (constituents with a non-empty email) — surfaces the "selected 12, only 9 will get the email" warning before sending |

Distinct from the legacy segment-based `SendBulkEmailJob` (which targets a saved filter), this job carries the **literal id list** captured at request time so the audit trail stays unambiguous.

## 7. Permissions matrix

| Endpoint | Guard | Notes |
|---|---|---|
| `GET /v1/campaigns/:id/constituents` | `requireOrgAdmin` | Same gate as the rest of the postal feature |
| `POST /v1/campaigns/:id/constituents` | `requireOrgAdmin` | |
| `DELETE /v1/campaigns/:id/constituents/:cId` | `requireOrgAdmin` | |
| `POST /v1/campaigns/:id/postal-exports` | `requireOrgAdmin` | High-cost (worker time + S3 storage), audit-worthy |
| `GET /v1/campaigns/:id/postal-exports[/:id]` | `requireOrgAdmin` | |
| `GET /v1/campaigns/:id/postal-exports/:id/download` | `requireOrgAdmin` | ZIP streamed through API (no presigned URL) |
| `POST /v1/campaigns/:id/postal-preview` | `requireOrgAdmin` | Rate-limited 20/min (synchronous PDFKit render) |
| `GET /v1/campaigns/:id/qr-stats` | `requireAuth` | Read-only, available to all tenant members |
| `GET /v1/public/qr/:code` | **Unauthenticated** | Rate-limited 60/min. The opaque token is the security boundary |
| `POST /v1/public/campaigns/:id/donate` | **Unauthenticated** | Token in body forwarded to Stripe metadata |
| `POST /v1/constituents/bulk-email` | `requireWrite` | Write-tier — blocked for `viewer` |

## 8. Privacy & GDPR

- **Opaque tokens** — printed QR codes carry no PII. A scrap of paper found in the wild reveals nothing about the recipient or the tenant
- **`added_by` / `requested_by` audit trail** — every link and every export is traceable to the operator who initiated it (Art. 5(2) accountability)
- **Soft-delete propagation** — when a constituent is soft-deleted (`constituents.deleted_at IS NOT NULL`), they are filtered out of all postal-export listing endpoints. Their existing `campaign_constituents` rows are kept (audit), but they receive no further mailing
- **Ressource leak proofing** — the `/public/qr/:code` route returns the same 404 for unknown tokens AND for tokens belonging to soft-deleted constituents, so a scraper can't distinguish the two
- **Right to erasure (Art. 17)** — the GDPR-erasure worker (`processGdprErasure`) cascades to `campaign_qr_codes.constituent_id` (set to NULL via FK) and `campaign_constituents` (delete), preserving the campaign-level rollup metrics while removing the personal binding

## 9. Future work (not in MVP)

These were considered and **deliberately deferred** — they would have either tripled the implementation surface or required regional regulatory review:

- **QR-Facture Suisse** — Switzerland's native bank-encoding QR standard. Different layout, mandatory IBAN encoding, separate validation rules (issue #274 explicitly out of scope).
- **Image upload per campaign** — letterhead branding, embedded photos. The MVP letter is text + QR only; the print shop adds the org's letterhead during printing.
- **Country-of-impact tagging** — a per-campaign attribute deferred to a later epic.
- **Multi-language letter templates** — current letters are English-only; FR/DE will need a translation pipeline that respects the same QR-attribution flow.
- **Per-recipient editorial overrides** — every nominative letter today shares the same body ("Dear supporter…"). A future epic could let the operator override the body per segment (donor tier, last gift date, etc.).
- **Direct print-shop integration** — current MVP hands the operator a ZIP to upload manually to their printer's portal. A managed print partnership (with API hand-off) is on the long-term roadmap.

## 10. References

- ADR-017 (`docs/15-infra-adr.md`) — One logical DB per tool; informs the `systemDb` vs. `db` split used by the QR resolver
- ADR-022 — Platform admins disjoint from tenant users; postal exports are tenant-scoped only
- `docs/03-data-model.md` — Core ERD (campaigns, constituents, donations) the postal tables extend
- `docs/06-security-compliance.md` — RLS posture, audit columns convention
- `docs/12-user-journeys.md` — Personas behind the operator-facing screens (esp. "Stéphane — fundraising lead")
- Migration `0037_campaign_constituents_exports.sql` — Schema delta for this epic
- Mockups: `docs/design/index.html` → "Postal mailing" section
