# 25 — Swiss QR-bill & camt.053 Reconciliation

> **Status**: Foundation merged (Epic #318)
> **Owner**: Payment Engineer agent
> **Related**: `23-postal-campaigns.md`, `20-payment-strategy.md`, `03-data-model.md`, `06-security-compliance.md`, `15-infra-adr.md`
> **Companion diagrams**: [`diagrams/swiss-qr-bill-flow.mmd`](../diagrams/swiss-qr-bill-flow.mmd), [`diagrams/camt053-reconciliation-flow.mmd`](../diagrams/camt053-reconciliation-flow.mmd)
> **Closes (foundation)**: #318 (foundation PR)

## 0. Why this exists — at a glance

> 🚨 **MVP-mandatory** — re-classified from "Future work" in `docs/23-postal-campaigns.md` §9.

The previous scope decision (issue #274) explicitly **deferred** the Swiss QR-bill ("Switzerland's native bank-encoding QR standard. Different layout, mandatory IBAN encoding, separate validation rules"). **Field insight from Greg (2026-05-07) flips this**: a Swiss NPO without QR-bill cannot collect postal donations at all — there is no fallback rail in Switzerland since the orange ESR / red ES bulletins were discontinued on **2022-09-30**. Givernance must ship this in MVP-1 or it cannot serve `.ch` tenants.

This domain adds **three coupled deliverables** to the existing postal-campaign rail (`docs/23`):

1. **Swiss QR-bill PDF generation** — every nominative-postal letter to a Swiss campaign carries a Swiss QR-bill (QR-facture / Schweizer QR-Rechnung) on a perforation-free **separate A4 sheet**, with a per-letter QRR (QR-Reference) or SCOR (Creditor Reference) reference. The donor pays via their e-banking app (mobile scan) or at a Post counter.
2. **Bank Accounts settings** — a new tab in Org Settings (`/settings/bank-accounts`) where org_admins register the IBAN / QR-IBAN, holder name, and bank details that back QR-bill issuance. A campaign with QR-bill mode enabled is bound to exactly one bank account.
3. **camt.053 import + reconciliation** — the operator uploads the bank's daily ISO 20022 statement (`camt.053`); the worker parses every credit entry, matches the QRR/SCOR back to the campaign + recipient, creates the `donation` row (auto-creating the constituent if unknown, reusing the existing find-or-create logic from the Stripe webhook), and surfaces unmatched credits in a manual queue.

Every printed slip is a contract: the QRR on the slip → the donor's payment in the bank → the camt.053 entry → the reconciled `donation` in Givernance. The whole loop must be GDPR-tight (donor IBAN + name on every slip), idempotent under re-imports, and forward-compatible with **EBICS automated pull** (deferred to V2).

> **Greg field insight** (transcript 2026-05-07): _"on va aussi ajouté une issue pour gèrer les campagnes postal gen pdf pour supporter les virement bancaire (...) virement bancaire suisse avec la norme ISO 20022 et extrait de compte camt ISO 20022 pour pouvoir faire un import de compte ensuite et gèrer les reference et créer les donations dans la plateforme (+ ajout/réconciliation de constituants). Coté settings d'orga, y'aura la possibilité de gèrer des coordonnées de comptes bancaires et de les lier a des campagnes pour facilité la génération des pdf."_

## 1. End-to-end user flow

```mermaid
sequenceDiagram
    autonumber
    actor Op as Operator (org_admin)
    participant Web as Next.js (web)
    participant API as Fastify (api)
    participant DB as Postgres
    participant Worker as BullMQ worker
    participant S3 as Object storage
    actor Donor
    participant Bank as Donor & NPO banks
    actor Acc as Accountant

    Note over Op,Web: A. Configure bank account (one-time)
    Op->>Web: Settings → Bank Accounts → New
    Web->>API: POST /v1/bank-accounts { iban, holder, bic?, qrIban? }
    API->>API: Validate IBAN + IID range (QR-IBAN: 30000-31999)
    API->>DB: INSERT bank_accounts (org-scoped, RLS)
    API->>DB: INSERT outbox_events ('bank_account.created')

    Note over Op,Web: B. Link a bank account to a campaign (optional)
    Op->>Web: Edit campaign → pick a bank account from dropdown
    Web->>API: PATCH /v1/campaigns/:id { bankAccountId }
    API->>API: Verify bank_account belongs to org (404 if cross-tenant)
    API->>DB: UPDATE campaigns SET bank_account_id, qr_reference_mode
    Note over API,DB: bankAccountId NULL = no QR-bill (standard letter)<br/>bankAccountId set = QR-bill PDF generated alongside

    Note over Op,Web: C. Generate the print archive
    Op->>Web: Click "Generate ZIP" (mode=personalized)
    Web->>API: POST /v1/campaigns/:id/postal-exports
    API->>DB: Validate readiness gates (incl. Swiss-specific)
    API->>DB: INSERT campaign_postal_exports
    API->>DB: INSERT outbox_events ('campaign.postal_export_requested')

    Note over Worker,S3: D. Async generation
    Worker->>DB: UPDATE status=processing
    loop Per recipient
      Worker->>Worker: Mint QRR (27 digits, mod-10) or SCOR (RF...)
      Worker->>DB: INSERT campaign_qr_codes (existing)<br/>+ INSERT swiss_qr_references (new)
      Worker->>Worker: Render appeal letter PDF (existing)<br/>+ render Swiss QR-bill PDF (new, separate sheet)
      Worker->>S3: Append BOTH PDFs to streaming archive<br/>(letter.pdf + qr-bill.pdf per recipient)
      Worker->>DB: UPDATE progress_count++
    end
    Worker->>S3: Finalise ZIP

    Note over Op,Donor: E. Print → distribute → donor pays
    Op->>Op: Download ZIP, send to print partner
    Op->>Donor: Postal letter + QR-bill delivered
    Donor->>Bank: Scan QR in e-banking app, confirm
    Bank->>Bank: Credit NPO bank account
    Bank-->>Op: Daily camt.053 in e-banking portal

    Note over Op,Acc: F. Manual upload + reconcile
    Op->>Web: Settings → Bank Accounts → Upload statement
    Web->>API: POST /v1/bank-accounts/:id/statements (multipart, .xml)
    API->>S3: Store raw camt.053 (private bucket, 10-yr retention)
    API->>DB: INSERT camt_statements (status=pending)
    API->>DB: INSERT outbox_events ('camt053.uploaded')
    API-->>Web: 202 + statementId

    Worker->>Worker: XSD-validate camt.053
    Worker->>Worker: Dedupe on (tenant, GrpHdr.MsgId)
    loop Per Ntry where CdtDbtInd=CRDT, Sts=BOOK
      Worker->>Worker: Extract structured ref (QRR or SCOR)
      Worker->>DB: Lookup swiss_qr_references.reference = $1
      alt Match found
        Worker->>DB: Find-or-create constituent (reuse stripe-webhook logic)
        Worker->>DB: INSERT donations (campaign, constituent, qr_code_id, swiss_qr_reference_id, source='camt053')
        Worker->>DB: INSERT outbox_events ('donation.created')
      else No match
        Worker->>DB: INSERT camt_unreconciled_entries (statementId, raw, parsed)
      end
    end
    Worker->>DB: UPDATE camt_statements SET status=processed

    Note over Op,Acc: G. Manual review (unreconciled)
    Acc->>Web: Settings → Bank Accounts → Unreconciled queue
    Acc->>Web: Either link to campaign+constituent manually, or write off
    Web->>API: POST /v1/camt-unreconciled/:id/resolve
```

## 1.bis Two QR codes per recipient — preserve scan tracking, add payment

**Critical design choice**: a Swiss QR-bill scan inside the donor's e-banking app **does NOT hit Givernance servers** — the QR encodes a payment instruction (SPC payload, IBAN, reference), not a URL. So if we used **only** the Swiss QR-bill, we would lose the **scan-to-donate funnel** the operator gets today on the French rail (`docs/23` §5: printed → scanned → donated → revenue).

The fix: **mint and print both QR codes per recipient**, on the same physical mailing:

| Surface | Carrier | Encodes | Tracking signal | Table |
|---|---|---|---|---|
| **Appeal letter (page 1)** — bottom of the existing A4 layout | Givernance opaque-token QR + printed URL `/p/:cid?qr=<token>` | URL → Givernance resolver | `scanned_at` stamped on first scan (existing mechanism, unchanged) | `campaign_qr_codes` |
| **QR-bill (page 2, separate A4)** | Swiss IG-compliant QR-bill (Receipt + Payment Part bottom strip) | SPC payload (IBAN, amount, QRR/SCOR) | none (donor's bank app is offline-to-Givernance) | `swiss_qr_references` |

The two rows are 1:1-paired in the worker: the same `(campaign_id, constituent_id, export_id)` mints exactly one `campaign_qr_codes` row AND one `swiss_qr_references` row per personalised letter. They live in different tables for the reasons in §2 (different alphabet, different security model, different retention) but they share their lifecycle and their export run.

**The operator's funnel becomes a 3-stage pipeline** with both engagement and payment signals:

```
letters printed   →   letters scanned   →   QR-bills paid
(constituents on        (Givernance QR              (camt.053
 mailing list)           scanned_at NOT NULL)        reconciled)
```

The "scanned but not yet paid" cohort is the highest-value remarketing segment — they showed engagement but didn't complete the bank-transfer step (which has more friction than a one-tap Stripe checkout). The campaign admin page surfaces this cohort directly (see §5.3 tracking widget).

> **Why not just use the Swiss QR-bill page on its own?** Because it would silently degrade the operator's existing reporting. The Swiss flow MUST be a strict superset of the French flow's tracking surface — never a regression.

## 1.ter Page format — Swiss QR-bill on a separate A4 sheet

The QR-bill is **always rendered on its own A4 portrait sheet**, sibling to the appeal letter in the ZIP. The Style Guide explicitly allows this layout (no perforation negotiation with the print partner; donor unfolds two sheets). The bottom 105mm strip is the canonical IG-mandated structure (Receipt + Payment Part); the top 192mm carries a minimal Givernance summary banner so the donor sees the campaign context before the slip.

```
┌───────────── A4 portrait (210×297mm) ─────────────┐
│  [ ORGANISATION NAME — bold ]                     │  y=20mm
│  Campaign: <campaign.name>                        │  y=30mm
│  Reference: <QRR or SCOR>  · Amount: <CHF / leave blank>
│                                                   │
│  Recipient: Jean Dupont, Rue de Lausanne 12       │  y=45mm (only if prefill_donor_identity)
│             1003 Lausanne                         │
│                                                   │
│  Pay this QR-bill from your e-banking app:        │  y=70mm
│  Scan the QR code on the receipt below.           │
│                                                   │
│                                                   │
│  - - - - - - - - perforation marker - - - - - - - │  y=192mm (top of QR-bill strip)
│                                                   │
│  ┌─────────────────────┬─────────────────────────┐│
│  │  RECEIPT            │  PAYMENT PART           ││
│  │  ─────────────      │  ──────────────────     ││
│  │  Account / Payable  │  ┌─────────────┐        ││
│  │  to:                │  │             │        ││  y=200mm
│  │  CH9300762011…      │  │  [ QR ]     │        ││
│  │  NPO Holder Name    │  │   46×46mm   │        ││
│  │  Holder address     │  │   ECC M     │        ││
│  │                     │  │   + Swiss   │        ││
│  │  Reference          │  │   cross 7mm │        ││
│  │  21 00000 00003 …   │  └─────────────┘        ││
│  │  13947 14300 09017  │                         ││
│  │                     │  Currency  Amount       ││
│  │  Payable by         │  CHF       — (blank)    ││
│  │  (blank by default) │                         ││
│  │                     │  Account / Payable to:  ││
│  │  Currency  Amount   │  CH93 0076 2011 …       ││
│  │  CHF       —        │  NPO Holder Name        ││
│  │                     │  Holder address         ││
│  │  Acceptance point   │                         ││
│  │  ─────────────      │  Reference: 21 00000…   ││
│  │                     │  Payable by: (blank)    ││
│  └─────────────────────┴─────────────────────────┘│  y=297mm (page bottom)
└───────────────────────────────────────────────────┘
```

The Receipt + Payment Part dimensions are **fixed by IG QR-bill v2.4** — `swissqrbill` v4 handles them (210×105mm strip, 62mm Receipt + 148mm Payment Part). Section labels (Account, Reference, Payable by, Acceptance point) are **mandatory in DE/FR/IT/EN**; the active label set is driven by the existing `tenants.default_locale` (FR/EN in MVP — DE deferred but cheap to add since `swissqrbill` ships all four locales out of the box, see §8).

**Pre-flight printable checklist** (the worker validates before each render):

| Field | Source | Cap |
|---|---|---|
| Holder name | `bank_accounts.holder_name` | ≤ 70 chars |
| Holder street | `bank_accounts.holder_address_line1` | ≤ 70 chars |
| Holder building no. | `bank_accounts.holder_address_line2` (nullable) | ≤ 16 chars |
| Holder postal code | `bank_accounts.holder_postal_code` | ≤ 16 chars |
| Holder city | `bank_accounts.holder_city` | ≤ 35 chars |
| Country | `bank_accounts.holder_country_code` (ISO-2) | exactly 2 |
| IBAN / QR-IBAN | `bank_accounts.iban` | 21 chars, mod-97 |
| Reference | minted per recipient | 27 (QRR) or RF.. (SCOR) |
| Currency | `bank_accounts.currency` | CHF or EUR (EUR ≠ QRR) |

If any cap is breached the export **fails before any PDF is rendered** — the readiness gate `swiss_qr_bill_address_too_long` lists the offending row(s) for the operator.

## 1.quater Reference type matrix (per bank account)

The choice of QR reference is **bound to the tenant's bank account**, not the campaign:

| `bank_account.iban_kind` | Reference type used | When |
|---|---|---|
| `qr_iban` (IID 30000-31999) | **QRR** — 27 numeric digits, mod-10 recursive check | Default for tenants whose bank issued a QR-IBAN (UBS, ZKB, PostFinance default) |
| `iban` (any other CH/LI IBAN) | **SCOR** — `RF` + 2 mod-97 check digits + ≤21 alphanum (ISO 11649) | For tenants whose bank only issues regular IBANs (some Raiffeisen, smaller cantonals) |

Per-letter — never per-campaign — **a fresh reference is minted** keyed `(constituentId, campaignId, exportId)`. Reuse across exports breaks idempotency on re-mailings and inflates duplicate-payment risk.

> **NON (no reference)** is **rejected at validation**: without a structured reference, camt.053 reconciliation collapses to fuzzy name matching, which we will not ship.

> **EUR + QRR is illegal** under IG QR-bill v2.4 (euroSIC discontinuation): currency-vs-reference consistency is enforced server-side. CHF is the default for Swiss NPOs.

The full rationale for these matrix decisions, including rejected alternatives (NON, per-campaign references, EUR+QRR), is in [ADR-027](./adrs/adr-027-swiss-qr-bill.md).

## 2. Domain model

```mermaid
erDiagram
    tenants ||--o{ bank_accounts : "owns"
    tenants ||--o{ camt_statements : "uploaded by tenant"
    bank_accounts ||--o{ camt_statements : "credited to"
    bank_accounts ||--o{ campaigns : "back QR-bill issuance"
    campaigns ||--o{ campaign_postal_exports : "produces"
    campaign_postal_exports ||--o{ campaign_qr_codes : "mints opaque token"
    campaign_postal_exports ||--o{ swiss_qr_references : "mints QR-bill ref"
    campaign_qr_codes ||--o| swiss_qr_references : "1:1 sibling per letter"
    swiss_qr_references ||--o| donations : "reconciled credit"
    camt_statements ||--o{ camt_credit_entries : "contains"
    camt_credit_entries ||--o| donations : "settles"
    camt_credit_entries ||--o| camt_unreconciled_entries : "if unmatched"
    constituents ||--o{ donations : "gave"
    campaigns ||--o{ donations : "raised"

    bank_accounts {
        uuid id PK
        uuid org_id FK
        string holder_name "≤70 chars (QR-bill addr cap)"
        string holder_address_line1
        string holder_address_line2 "nullable"
        string holder_postal_code
        string holder_city
        string holder_country_code "ISO-2; CH default"
        string iban "21 chars, mod-97 valid"
        enum iban_kind "iban | qr_iban (computed from IID)"
        string bic "8 or 11 chars, nullable"
        string bank_name "displayed in slip"
        enum currency "CHF | EUR"
        timestamp created_at
        timestamp deleted_at "soft delete; preserved for audit"
    }

    campaigns {
        uuid id PK
        uuid bank_account_id FK "nullable; presence = Swiss QR-bill mode on"
        enum qr_reference_mode "auto (derive from bank_account.iban_kind) | qrr | scor; ignored if bank_account_id NULL"
    }

    swiss_qr_references {
        uuid id PK
        uuid org_id FK
        uuid campaign_id FK
        uuid constituent_id FK "nullable for door_drop (V2)"
        uuid export_id FK "backlink for retry idempotency"
        uuid bank_account_id FK
        enum reference_type "qrr | scor"
        string reference "27 digits (QRR) or RF... (SCOR)"
        int amount_cents "0 = donor-fills"
        enum currency "CHF | EUR"
        timestamp created_at
    }

    camt_statements {
        uuid id PK
        uuid org_id FK
        uuid bank_account_id FK
        string s3_path "private bucket, 10-yr retention"
        string msg_id "GrpHdr.MsgId, dedupe key"
        date statement_from
        date statement_to
        int total_credits
        int matched_credits
        int unmatched_credits
        enum status "pending | processing | processed | failed"
        text error
        uuid uploaded_by FK
        timestamp created_at
        timestamp processed_at
    }

    camt_credit_entries {
        uuid id PK
        uuid org_id FK
        uuid statement_id FK
        string acct_svcr_ref "Ntry.AcctSvcrRef, idempotency"
        string end_to_end_id "secondary signal"
        int amount_cents
        enum currency
        date value_date
        date booking_date
        string structured_ref "QRR/SCOR extracted"
        string debtor_name
        string debtor_iban "donor IBAN"
        uuid donation_id FK "set when reconciled"
    }

    camt_unreconciled_entries {
        uuid id PK
        uuid org_id FK
        uuid credit_entry_id FK
        text reason "no_match | partial_match | invalid_ref | foreign_iban | orphan_reversal"
        enum status "pending | resolved | written_off"
        uuid resolved_by FK
        timestamp resolved_at
        text resolution_note
    }

    donations {
        uuid swiss_qr_reference_id FK "nullable, set by reconciliation"
        uuid camt_credit_entry_id FK "nullable"
        enum payment_source "stripe | camt053 | manual"
    }
```

### Why no `swiss_qr_bill_enabled` boolean?

The presence of `campaigns.bank_account_id` IS the on/off switch. Modelling it as a separate boolean would introduce an invalid state (`enabled=true && bank_account_id=NULL`) that has no operator meaning and forces defensive checks everywhere. A nullable FK is the canonical "optional pointer" in this codebase (mirrors `campaigns.parent_id`, `donations.constituent_id`, etc.) and lets the operator simply pick a bank account from the dropdown — or leave it blank — without a separate toggle. Settings can hold many bank accounts (`bank_accounts ||--o{ campaigns`); the campaign picks at most one.

### Why a `swiss_qr_references` table separate from `campaign_qr_codes`?

`campaign_qr_codes.code` is a 120-bit opaque token — its security model is "the token IS the URL". A Swiss QRR/SCOR is **not opaque**: it's a 27-digit number that the bank prints, the donor reads, and the camt.053 echoes back. Different alphabet, different validation, different uniqueness scope (per-bank-account vs. per-org), different retention story (financial record, 10-yr CH retention). Co-mingling them in one table would force every postal-export letter to mint two refs in the same row and confuse the reconciliation join. Sibling table, 1:1 link by `(export_id, constituent_id)`.

## 3. Architecture (3-tier extension of postal rail)

```mermaid
flowchart LR
    subgraph Browser["Operator browser"]
        UI[CampaignForm: Swiss toggle<br/>BankAccountsTab<br/>CamtUploadPanel<br/>UnreconciledQueue]
    end

    subgraph API["Fastify API"]
        BR[bank-accounts/routes.ts]
        BS[bank-accounts/service.ts<br/>+ iban-validator.ts]
        CR[camt/routes.ts]
        CS[camt/service.ts]
        PR[campaigns/postal-routes.ts]
        PES[postal-export-service.ts<br/>extended]
    end

    subgraph Outbox["Outbox"]
        OBE[(outbox_events)]
        Relay[outbox-relay]
    end

    subgraph BullMQ["Queues"]
        CQ[campaigns queue]
        CMQ[camt queue NEW]
    end

    subgraph Worker["Worker"]
        WP[postal-export.ts<br/>extended]
        QRP[swiss-qr-bill.ts NEW<br/>swissqrbill v4 + PDFKit]
        WC[camt-import.ts NEW<br/>iso20022.js + XSD validate]
        WR[camt-reconcile.ts NEW]
    end

    subgraph Storage
        S3C[campaigns bucket<br/>existing private]
        S3B[bank-statements bucket<br/>NEW private + 10-yr lifecycle]
    end

    subgraph DB["Postgres"]
        T[(bank_accounts<br/>swiss_qr_references<br/>camt_statements<br/>camt_credit_entries<br/>camt_unreconciled_entries)]
    end

    UI --> BR --> BS --> T
    UI --> CR --> CS --> S3B
    CS --> OBE --> Relay --> CMQ --> WC --> WR
    UI --> PR --> PES --> OBE --> Relay --> CQ --> WP --> QRP
    QRP --> S3C
    WC --> T
    WR --> T
```

### Key design decisions

| # | Decision | Why |
|---|----------|-----|
| 1 | **Separate-sheet QR-bill** (one PDF letter + one PDF QR-bill, both in the ZIP) | IG QR-bill Style Guide explicitly allows this layout. Avoids perforation-partnership negotiation; print partner staples or the donor unfolds two sheets. Letter typography stays unchanged. Full rationale in [ADR-027](./adrs/adr-027-swiss-qr-bill.md). |
| 2 | **Library: `swissqrbill` v4 (schoero, MIT)** | Composes natively on PDFKit (`SwissQRBill.attachTo(doc)`); built-in payload + IBAN/QRR/SCOR validation; TypeScript-first; monthly cadence; covers IG v2.3 + v2.4 ready. Supplement with `boessu/SwissQRBill` algorithms for `validateBeforeMint()` unit tests. |
| 3 | **Library: `iso20022.js` for camt.053** + **XSD validation pass** via `libxmljs2` against the SIX `camt.053.001.08.xsd` | Most-maintained Node option; SEPA-shaped but generic enough. **Open question**: confirm with a real PostFinance + UBS sample that QRR (`Prtry="QRR"`) extraction works; fall back to `fast-xml-parser` + hand-written mapper if the library only surfaces `Cd="SCOR"`. Decision in [ADR-028](./adrs/adr-028-camt053-ingestion.md). |
| 4 | **Per-letter QRR/SCOR**, never per-campaign | Per-letter is the only way to disambiguate two letters of the same campaign sent to the same constituent (re-mailings, address corrections). Idempotent via `swiss_qr_references.reference UNIQUE` per `(org_id, bank_account_id)`. |
| 5 | **camt.053 + camt.054 V1, EBICS V2** | Manual statement upload via UI ships in V1. EBICS automated pull is a separate epic. Most operators check their e-banking weekly anyway. |
| 6 | **Reconcile by reference only — never by amount** | The QR-bill spec lets the donor override the printed amount (counter payment, e-banking edit). Matching on amount would silently miss every partial-amount donation. Persist the gap as `partial_match` flag for the operator. |
| 7 | **Idempotency key: `(org_id, GrpHdr.MsgId, Ntry.AcctSvcrRef)`** | Statement re-uploads are dedup'd at file level (MsgId), entry-level dedup'd by AcctSvcrRef. Note: some banks reuse AcctSvcrRef across related entries (ISO 20022 maintenance note) — verify per-bank in QA, add `EndToEndId` as secondary. |
| 8 | **Reuse `find-or-create constituent` logic** from `packages/worker/src/processors/stripe-webhook.ts:179-242` | The Stripe path already auto-creates constituents on donation receipt. Refactor it into a shared service (`donations/constituent-resolver.ts`) called from both the Stripe webhook and the camt.053 reconciler. |
| 9 | **New private bucket `bank-statements`** under ADR-023 | Camt.053 contains donor IBAN + name (PII). Cannot land in `branding` (public). Creating a sibling private bucket (rather than reusing `receipts`) keeps lifecycle policy distinct: 10-yr CH retention vs. 7-yr standard for receipts. Documented in [ADR-023 amendment](./adrs/adr-023-object-storage-bucket-topology.md). |
| 10 | **Worker idempotency contract** mirrors postal-export | `swiss_qr_references.export_id` backlink + partial unique on `(export_id, constituent_id)` so a Kamal pod crash mid-export doesn't mint mismatched refs on retry. |
| 11 | **`swissqrbill` runs in worker only — never in API** | Same constraint as `pdfkit` (Node-only, ADR-013 forbids in `@givernance/shared`). Preview path in API regenerates a sample QR-bill with a never-registered fixture reference. Lockstep duplicate banner per [ADR-025](./adrs/adr-025-pdf-rendering-code-boundary.md). |
| 12 | **Bank account is org-scoped, not campaign-scoped** | A tenant typically has one or two operating accounts. Linking at the campaign level keeps the QR-bill issuance deterministic per export. Multi-account-per-campaign (split fundraising) is V2. |

## 4. Readiness gates (Swiss-specific extensions)

**Swiss-specific gates fire only when `campaigns.bank_account_id IS NOT NULL`.** A campaign with no linked bank account behaves like a regular non-Swiss campaign — the existing gates (`campaign_not_active`, `public_page_missing`, `public_page_draft`, `personalized_on_door_drop`, `no_recipients`) are the only checks. When a bank account is linked, the following additional gates run:

| Code | Cause | Operator fix |
|---|---|---|
| `swiss_qr_bill_invalid_iban` | Linked bank account IBAN fails mod-97 or country ∉ {CH, LI} | Fix the bank account in `Settings → Bank Accounts` |
| `swiss_qr_bill_currency_mismatch` | `qr_reference_mode = qrr` but `bank_account.currency = EUR` (illegal under IG v2.4) | Switch reference mode to SCOR, change the bank account currency, or unlink the bank account |
| `swiss_qr_bill_address_too_long` | Tenant or constituent address > 70 chars on any QR-bill field | Fix the offending record before bulk export |
| `swiss_qr_bill_door_drop_unsupported` | `bank_account_id` linked on a `door_drop` campaign (V1 limitation) | Use mode=personalized, or unlink the bank account; door-drop QR-bill (no recipient) is V2 |
| `swiss_qr_bill_bank_account_deleted` | Linked bank account was soft-deleted after the link was made | Pick a different bank account, or restore the deleted one |

The **Preview** button stays enabled with a never-registered fixture reference so the operator validates the layout before printing.

```mermaid
flowchart TD
    Start([Click Generate ZIP]) --> A{Existing<br/>postal gates pass?}
    A -->|fail| ZA[Existing readiness banner<br/>see docs/23 §4]
    A -->|pass| B{campaigns.bank_account_id<br/>set?}
    B -->|null| Z[Standard flow:<br/>letter + opaque-token QR only<br/>no QR-bill PDF]
    B -->|set| C{Mode = personalized?}
    C -->|door_drop| D[400 swiss_qr_bill_door_drop_unsupported<br/>+ banner: unlink or use personalized]
    C -->|personalized| BD{bank account<br/>still active?}
    BD -->|deleted| BE[400 swiss_qr_bill_bank_account_deleted]
    BD -->|active| G{IBAN valid CH/LI<br/>+ mod-97?}
    G -->|invalid| H[400 swiss_qr_bill_invalid_iban<br/>+ CTA → /settings/bank-accounts/:id]
    G -->|valid| I{currency vs<br/>reference mode?}
    I -->|EUR + QRR| J[400 swiss_qr_bill_currency_mismatch<br/>+ banner: switch to SCOR]
    I -->|consistent| K{All recipient<br/>addresses ≤70 chars?}
    K -->|over| L[400 swiss_qr_bill_address_too_long<br/>+ list of offending constituents]
    K -->|ok| M[Insert export job<br/>→ outbox → worker<br/>letter PDF + QR-bill PDF per recipient]
    Z --> M2[Insert export job<br/>letter PDF only]
    D -.->|Disabled button| Start
    BE -.->|Disabled button| Start
    H -.->|Disabled button| Start
    J -.->|Disabled button| Start
    L -.->|Disabled button| Start
```

### 4.bis Reference-type decision (per export, per recipient)

The reference type is decided **once per export** (from the bank account) but **a fresh value is minted per recipient**:

```mermaid
flowchart LR
    Start([Postal export<br/>requested]) --> A[Read campaigns.bank_account_id<br/>→ bank_accounts row]
    A --> B{bank_accounts.iban_kind?}
    B -->|qr_iban<br/>IID 30000-31999| C{currency?}
    B -->|iban| F[Use SCOR<br/>RF + mod-97 + ≤21 chars]
    C -->|CHF| D[Use QRR<br/>27 digits + mod-10]
    C -->|EUR| E[Reject:<br/>EUR+QRR illegal IG v2.4]
    D --> G[Loop over recipients]
    F --> G
    G --> H[For each:<br/>generate fresh reference<br/>+ store swiss_qr_references]
    H --> I[Render QR-bill PDF<br/>via swissqrbill v4]
    I --> J[Append to ZIP]
```

The mod-10 (QRR) and mod-97 (SCOR) check digits are computed by `swissqrbill`'s built-in helpers; cross-validated in unit tests against the `boessu/SwissQRBill` reference algorithms.

## 5. Reconciliation

### 5.1 Sequence — happy path + unmatched branch

```mermaid
sequenceDiagram
    autonumber
    actor Op as Operator
    participant Web as Next.js
    participant API as Fastify
    participant S3 as bank-statements bucket
    participant DB as Postgres
    participant Q as camt queue
    participant WI as camt-import.ts
    participant WR as camt-reconcile.ts
    participant CR as constituent-resolver

    Op->>Web: Upload camt.053 (.xml ≤ 50MB)
    Web->>API: POST /v1/bank-accounts/:id/statements
    API->>API: Validate Content-Type, size, .xml
    API->>S3: PUT {org_id}/camt053/{yyyy}/{mm}/{filename}
    API->>DB: INSERT camt_statements (status=pending)
    API->>DB: INSERT outbox_events ('camt053.uploaded')
    API-->>Web: 202 + statementId

    Note over WI,DB: Import pass
    DB->>Q: outbox relay enqueues
    Q->>WI: dequeue
    WI->>S3: GET XML
    WI->>WI: XSD-validate (libxmljs2 + camt.053.001.08.xsd)
    alt malformed
      WI->>DB: UPDATE status=failed, error
      WI-->>Op: (poll surfaces error in UI)
    else valid
      WI->>DB: SELECT camt_statements WHERE msg_id=$1<br/>(idempotency)
      alt re-import
        WI->>WI: short-circuit
      else first import
        WI->>WI: Verify Acct.Id.IBAN ∈ tenant bank_accounts
        loop Per Ntry CRDT/BOOK
          WI->>WI: idempotency = (msg_id, AcctSvcrRef)
          WI->>DB: INSERT camt_credit_entries
        end
        WI->>DB: enqueue camt-reconcile job per statement
      end
    end

    Note over WR,CR: Reconciliation pass
    Q->>WR: dequeue
    WR->>DB: SELECT camt_credit_entries WHERE statement_id=$1<br/>AND donation_id IS NULL
    loop Per credit entry
      WR->>WR: Extract structured ref + validate format
      alt QRR mod-10 or SCOR mod-97 invalid
        WR->>DB: INSERT camt_unreconciled_entries (reason=invalid_ref)
      else valid format
        WR->>DB: SELECT swiss_qr_references<br/>WHERE reference=$1 AND bank_account_id=$2
        alt match
          WR->>CR: resolve constituent (donor name+IBAN, fallback to ref.constituent_id)
          CR->>DB: find or auto-create constituent
          WR->>DB: INSERT donations (campaign, constituent, swiss_qr_reference_id, payment_source='camt053')
          WR->>DB: UPDATE camt_credit_entries SET donation_id=$1
          WR->>DB: INSERT outbox_events ('donation.created')
        else no match
          WR->>DB: INSERT camt_unreconciled_entries (reason=no_match)
        end
      end
    end
    WR->>DB: UPDATE camt_statements SET status=processed,<br/>matched_credits, unmatched_credits, processed_at
    WR->>DB: INSERT outbox_events ('camt053.processed')
```

### 5.2 Reversal & pending entry handling

```mermaid
flowchart TD
    Entry([Ntry from camt.053]) --> A{Sts?}
    A -->|PDNG| Skip[Skip — re-evaluate next upload<br/>same AcctSvcrRef will eventually re-appear with BOOK]
    A -->|BOOK| B{RvslInd?}
    B -->|true| C{Original donation<br/>exists?}
    B -->|false| Norm[Normal reconciliation path<br/>see §5.1]
    C -->|yes| D[INSERT donation reversal<br/>+ link to original via donations.parent_id<br/>+ emit donation.refunded]
    C -->|no| E[INSERT camt_unreconciled_entries<br/>reason=orphan_reversal]
```

### 5.3 Tracking widget — full 3-stage funnel (printed → scanned → paid)

The existing French postal flow exposes a 4-stage funnel on the campaign admin page (see `docs/23` §5 and `packages/api/src/modules/campaigns/qr-stats-service.ts`): printed → scanned → donated → revenue. **The Swiss flow MUST preserve every stage of this funnel** because we keep minting the Givernance opaque-token QR on the appeal letter (§1.bis); the QR-bill on the separate sheet adds the payment dimension on top.

```mermaid
flowchart LR
    A[Letters printed<br/>= constituents on mailing list] --> B[Letters scanned<br/>campaign_qr_codes.scanned_at NOT NULL]
    B --> C[Amount paid via camt.053<br/>SUM donations.amount_cents<br/>WHERE source = camt053]
    A --> D[QR-bills paid<br/>donations.swiss_qr_reference_id NOT NULL]
    D --> C
    A --> E[Scanned but not paid<br/>= remarketing cohort]
    B --> E
    A --> F[Pending<br/>printed - paid]
    D --> G[Partial-match<br/>donor adjusted amount]
    A --> H[Unreconciled credits<br/>operator review queue]
```

#### Metrics surfaced on the campaign admin page

A single combined card per campaign when `bank_account_id IS NOT NULL` — **the existing `qr-tracking-card.tsx` is extended in place**, not duplicated, so `getCampaignQrStats()` returns one merged shape:

| Metric | Definition | Source | Status |
|---|---|---|---|
| `totalLetters` | Count of `campaign_qr_codes` for the campaign | `campaign_qr_codes` | existing — unchanged |
| `scannedLetters` | Count where `scanned_at IS NOT NULL` | `campaign_qr_codes` | existing — unchanged |
| `qrAttributedDonations` | Stripe-rail donations from QR scan | `donations.qr_code_id` | existing — unchanged |
| `qrAttributedAmountCents` | Stripe-rail amount from QR scan | `donations` aggregate | existing — unchanged |
| `totalQrBills` | Count of `swiss_qr_references` (NEW row, ≡ `totalLetters` per design) | `swiss_qr_references` | NEW |
| `paidQrBills` | Count of `donations` where `swiss_qr_reference_id` is set | join | NEW |
| `paidQrBillAmountCents` | Sum of camt.053-attributed donations | `donations` aggregate | NEW |
| `pendingQrBills` | `totalQrBills − paidQrBills` | derived | NEW |
| `scannedNotPaidCount` | `campaign_qr_codes.scanned_at IS NOT NULL AND swiss_qr_references.id NOT IN (paid set)` — **engagement without payment, the high-value remarketing cohort** | join | NEW |
| `partialMatchCount` | `donations` linked via swiss_qr where `amount_cents ≠ swiss_qr_references.amount_cents` (only counted when printed amount was non-zero) | join | NEW |
| `unreconciledCount` | `camt_unreconciled_entries` for bank accounts linked to this campaign, status=pending | aggregate | NEW |
| `lastStatementImportedAt` | MAX `camt_statements.processed_at` for the campaign's bank account | aggregate | NEW |

**Visual layout** when both rails are active (mixed campaign: some donors scan + pay Stripe, others use the Swiss QR-bill + bank transfer):

```
┌─────────────────────────────────────────────────────┐
│ Postal campaign tracking                            │
│                                                     │
│   100  Letters printed                              │
│   ↓                                                 │
│   38   Letters scanned (38%)                        │
│   ├─→  17 paid via Stripe (CHF 1,250)               │
│   ├─→  42 paid via QR-bill (CHF 3,200)              │
│   └─→  21 scanned but not paid ← remarket           │
│                                                     │
│   3    Pending camt review (unreconciled)           │
│   Last bank statement import: 2026-05-06            │
└─────────────────────────────────────────────────────┘
```

For pure-Swiss campaigns (no Stripe rail, e.g. the NPO has no Stripe Connect), the Stripe lines collapse but the funnel structure stays identical — `printed → scanned → paid via QR-bill` with the "scanned but not paid" remarketing cohort intact.

#### Reconciliation health card on the bank-account page

A second surface lives at `/settings/bank-accounts/:id` (cross-campaign view): it shows the last 5 imported statements, their match rates, and a quick link to the unreconciled queue. This mirrors the spirit of the existing QR-tracking widget but at the bank-account scope, since one statement can clear donations across many campaigns at once.

### 5.4 Pseudocode (full algorithm)

```
Per uploaded statement:
  1. XSD-validate against camt.053.001.08.xsd → reject malformed
  2. Read GrpHdr.MsgId
     → if (org_id, msg_id) already in camt_statements: short-circuit (re-import)
  3. For each Stmt:
     - Read Acct.Id.IBAN → MUST match a tenant bank_account.iban
       (else: reject the whole file — GDPR safety, foreign IBAN)
     - For each Ntry where CdtDbtInd = CRDT and Sts = BOOK:
        a. idempotency_key = (msg_id, AcctSvcrRef)
           if seen in camt_credit_entries → skip
        b. Walk NtryDtls.TxDtls (1..n — banks may batch):
           - Extract RmtInf.Strd.CdtrRefInf.Ref + Tp.CdOrPrtry
           - Validate format (QRR mod-10 OR SCOR mod-97) → if invalid, mark unreconciled
        c. Lookup swiss_qr_references.reference = $1
           AND swiss_qr_references.bank_account_id = $2
           → resolve (campaignId, constituentId)
        d. Capture: amount, currency, value_date, booking_date, donor name+IBAN
        e. INSERT camt_credit_entries (always, matched or not)
        f. If matched:
           - find_or_create_constituent(orgId, donor name+IBAN, fallback to swiss_qr_references.constituent_id)
           - INSERT donations { campaign_id, constituent_id, swiss_qr_reference_id, payment_source='camt053', payment_ref=AcctSvcrRef }
           - emit outbox 'donation.created' (existing flow downstream: receipt PDF, etc.)
        g. If unmatched (no QR ref / invalid ref / amount diff > tolerance):
           - INSERT camt_unreconciled_entries (status=pending)
  4. UPDATE camt_statements SET status=processed, matched_credits, unmatched_credits
  5. Emit outbox 'camt053.processed'
```

**Reversal entries** (`Ntry.RvslInd = true`) reverse the prior donation rather than double-book. **Pending entries** (`Sts != BOOK`) are skipped and re-evaluated on next statement upload.

## 6. Permissions matrix

| Endpoint | Guard | Notes |
|---|---|---|
| `GET /v1/bank-accounts` | `requireOrgAdmin` | Settings tab visibility |
| `POST /v1/bank-accounts` | `requireOrgAdmin` | IBAN validated server-side |
| `PATCH /v1/bank-accounts/:id` | `requireOrgAdmin` | Soft-delete on remove (audit) |
| `DELETE /v1/bank-accounts/:id` | `requireOrgAdmin` | Soft delete; ON DELETE SET NULL on `campaigns.bank_account_id` cascades to graceful degrade (no hard refusal). Linked campaigns get a banner: "Bank account removed; QR-bill mode disabled" |
| `POST /v1/bank-accounts/:id/statements` | `requireOrgAdmin` | Multipart upload, `.xml` only, ≤ 50 MB |
| `GET /v1/camt-statements[/:id]` | `requireOrgAdmin` | List + detail |
| `GET /v1/camt-statements/:id/download` | `requireOrgAdmin` | Streamed signed URL, 10-yr retention |
| `GET /v1/camt-unreconciled` | `requireWrite` | Accountant role can resolve |
| `POST /v1/camt-unreconciled/:id/resolve` | `requireWrite` | Manual link or write-off |
| `PATCH /v1/campaigns/:id` (Swiss QR fields) | `requireOrgAdmin` | Adds `bankAccountId` (nullable) + `qrReferenceMode`. Linking sets the campaign in Swiss QR-bill mode; unlinking degrades it back to standard |
| `GET /v1/campaigns/:id/qr-stats` | `requireOrgAdmin` | Existing endpoint — returns the merged Stripe-rail + Swiss-rail metrics from §5.3. No new endpoint introduced |

The existing `POST /v1/campaigns/:id/postal-preview` and `POST /v1/campaigns/:id/postal-exports` reuse their existing `requireOrgAdmin` guard with extended readiness gates.

## 7. Privacy & GDPR

- **Donor PII on the slip**: a discarded QR-bill in a recycling bin leaks donor name + full address if `Ultimate Debtor` is pre-filled. **Default = blank Ultimate Debtor** (donor types own name in their app); per-campaign override `prefill_donor_identity = true` requires explicit operator confirmation. Mirrors the existing French opaque-token QR posture.
- **Camt.053 storage**: raw XML lands in the **new private `bank-statements` bucket** ([ADR-023 amendment](./adrs/adr-023-object-storage-bucket-topology.md)), keyed `{org_id}/camt053/{yyyy}/{mm}/{msg_id}.xml`. Signed URLs only; no CDN; encrypted at rest.
- **Retention**: Swiss CO Art. 958f mandates **10 years** for bank statements (electronic OK). Apply a 10-yr lifecycle on the `bank-statements` bucket. **Camt-derived donation rows are exempt from GDPR Art. 17 erasure** (legal-hold protected, same as Stripe-derived rows under existing policy in `docs/06`).
- **Erasure cascade**: on constituent erasure, `swiss_qr_references.constituent_id` is set NULL (preserves campaign-level rollup KPI). The associated `camt_credit_entries.debtor_name` and `.debtor_iban` are kept (financial record) but flagged via the existing `gdpr_erased` mechanism.
- **Foreign-IBAN safety**: a camt.053 referencing an IBAN not registered in the tenant's `bank_accounts` is **rejected outright** (file-level), preventing the operator from accidentally importing a third-party's statement.

## 8. Future work (explicitly out of scope for this epic)

| Item | Why deferred |
|---|---|
| **EBICS automated camt pull** | Per-bank contract negotiation, ≥1 month per bank. V1 = manual upload — operators check e-banking weekly anyway. |
| **camt.054 real-time credit notifications** | Requires per-tenant bank opt-in. Bonus surface; same parser path so straightforward to enable later. |
| **TWINT, PostFinance Pay** | Phase 3+ via Saferpay (`docs/20` §3.4). Distinct UX (point-of-sale-style) — not part of postal mailing. |
| **Multi-bank-account per campaign** | Some NPOs split fundraising across two accounts (operations / endowment). V1 = one account per campaign. |
| **Door-drop QR-bill** (no recipient) | Mass-printed door-drop with a campaign-level QRR works but offers no per-donor reconciliation; defer until field demand emerges. |
| **Embedded campaign image / letterhead on QR-bill page** | The QR-bill page is text + slip; the appeal letter remains the brand carrier. Image upload epic is separate. |
| **DE/IT locales** | `swissqrbill` ships all four locales; FR/EN ship in MVP, DE/IT cheap to add when a Romandie/Ticino tenant requests. |
| **Annual-giving statement integration** | Camt-derived donations flow into the same annual statement pipeline as Stripe; no special handling needed but covered by the receipts epic. |
| **MT940 legacy import** | Swiss banks deprecated MT940; not worth supporting. |
| **Donor self-service: switch from CHF QR-bill to SEPA bank transfer** | Cross-border donors paying EUR → SCOR works; deeper SEPA DD integration is the existing payment-strategy roadmap (`docs/20` §11). |

## 9. References

### Architecture / docs

- `docs/23-postal-campaigns.md` — existing postal-campaign rail this domain extends
- `docs/20-payment-strategy.md` — payment provider strategy (Stripe ≠ bank transfer)
- `docs/03-data-model.md` — core ERD (extended with the 5 new tables)
- `docs/04-business-capabilities.md` — Swiss QR-bill capability under the postal-campaign module
- `docs/06-security-compliance.md` — IBAN/donor-PII handling rules + camt.053 retention exception to Art. 17
- `docs/07-delivery-roadmap.md` — Phase 1 includes Swiss QR-bill MVP
- [ADR-013](./adrs/adr-013-frontend-type-boundary-no-drizzle-imports-in-web-package.md) — keeps `swissqrbill` (Node-only) out of `@givernance/shared`
- [ADR-017](./adrs/adr-017-one-logical-database-per-tool-isolate-keycloak-from-the-application-db.md) — reuse the `givernance` logical DB; no new DB
- [ADR-023](./adrs/adr-023-object-storage-bucket-topology.md) — new private `bank-statements` bucket added by amendment
- [ADR-025](./adrs/adr-025-pdf-rendering-code-boundary.md) — lockstep duplicate policy applies to QR-bill rendering
- [ADR-027](./adrs/adr-027-swiss-qr-bill.md) — Swiss QR-bill: provider + library selection, layout, reference-type matrix
- [ADR-028](./adrs/adr-028-camt053-ingestion.md) — camt.053 ingestion: parser, validation, idempotency, retention

### Standards

- [Swiss Implementation Guidelines QR-bill v2.4 — SIX, Feb 2026](https://www.six-group.com/dam/download/banking-services/standardization/qr-bill/ig-qr-bill-v2.4-en.pdf)
- [Swiss Implementation Guidelines QR-bill v2.3 — SIX](https://www.six-group.com/dam/download/banking-services/standardization/qr-bill/ig-qr-bill-v2.3-en.pdf) (in force until Nov 2027)
- [Style Guide QR-bill — SIX](https://www.six-group.com/dam/download/banking-services/standardization/qr-bill/style-guide-qr-bill-en.pdf)
- [Swiss Implementation Guidelines for Cash Management (camt) — SPS 2026 v2.3](https://www.six-group.com/dam/download/banking-services/standardization/sps/ig-cash-management-sps-2026-en.pdf)
- ISO 11649 — RF Creditor Reference (SCOR)
- Swiss Code of Obligations Art. 958f — 10-year retention of accounting records

### Libraries

- [`swissqrbill`](https://github.com/schoero/SwissQRBill) v4 (MIT) — recommended PDF generator
- [`boessu/SwissQRBill`](https://github.com/boessu/SwissQRBill) — validator algorithms (QRR mod-10, SCOR mod-97, IBAN)
- [`iso20022.js`](https://github.com/Svapnil/iso20022.js) — recommended camt.053 parser (Node, TS)
- [`libxmljs2`](https://www.npmjs.com/package/libxmljs2) — XSD validation pass

### Tracking

- Epic: #318 — Swiss QR-bill (re-classifies `docs/23` §9 deferred item)
- Related epics: #274 (postal campaigns MVP), #286 (branding), #62 (Mollie — on hold)
