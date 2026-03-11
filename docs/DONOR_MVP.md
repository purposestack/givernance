# Donor Management MVP — Implementation Guide

> Quick reference for Phase 1 implementation. For full context: docs/01-product-scope.md §7 + docs/07-delivery-roadmap.md Phase 1.

## What we're building

The core loop of nonprofit fundraising:

```
Constituent record → Donation recorded → Receipt generated → Campaign updated → Lifecycle stage recalculated
```

## Data model (core Phase 1 tables)

From packages/shared/src/schema/:

| Table | Purpose | Sprint |
|-------|---------|--------|
| `constituents` | Person/household/org record | 1 |
| `constituent_relationships` | Bidirectional typed relationships | 1 |
| `donations` | Every financial gift | 2 |
| `pledges` | Recurring gift schedule | 2 |
| `pledge_installments` | Individual installment records | 2 |
| `funds` | Restricted/unrestricted fund designations | 2 |
| `receipts` | Generated PDF receipts (S3 reference) | 2 |
| `campaigns` | Fundraising campaigns | 3 |
| `donor_lifecycle` | LYBUNT/SYBUNT flags (materialized) | 3 |
| `gdpr_consents` | Consent records per constituent | 5 |
| `gdpr_sar_requests` | Subject access requests | 5 |

## Sequence rule

> **Do not start Sprint 2 before Sprint 1 API endpoints have integration tests passing.**
> Do not start Sprint 4 (UI) before Sprint 2 API is complete.

## API endpoints (Phase 1 — full list)

### Constituents (Sprint 1)
- `GET /v1/constituents` — list with cursor pagination + search
- `POST /v1/constituents` — create individual
- `GET /v1/constituents/:id` — detail with activity timeline
- `PUT /v1/constituents/:id` — update
- `DELETE /v1/constituents/:id` — soft delete (GDPR)
- `POST /v1/constituents/:id/merge` — merge duplicate

### Donations (Sprint 2)
- `GET /v1/donations` — list with filters (date, campaign, fund, constituent)
- `POST /v1/donations` — record gift (triggers receipt job)
- `GET /v1/donations/:id` — detail
- `GET /v1/donations/:id/receipt` — download receipt URL (presigned)
- `POST /v1/pledges` — create recurring pledge
- `GET /v1/pledges/:id/installments` — installment schedule

### Campaigns (Sprint 3)
- `GET /v1/campaigns` — list
- `POST /v1/campaigns` — create
- `GET /v1/campaigns/:id/stats` — totals by source, period

### Reports (Sprint 3)
- `GET /v1/reports/lybunt` — LYBUNT donor list
- `GET /v1/reports/sybunt` — SYBUNT donor list
- `GET /v1/reports/gift-aid` — gift aid export (CSV)
