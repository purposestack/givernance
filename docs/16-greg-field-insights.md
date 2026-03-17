# 16 — Greg Field Insights

> Field insights from Greg, expert Salesforce + European NPO sector. Based on hands-on experience implementing CRM and fundraising systems at multiple French NPOs.

## 1. Fundraising Channels — How Donations Actually Flow

### Canal 1 — Nominative Postal Campaigns (~60% of donations)

This is the dominant fundraising channel for European NPOs. The workflow is:

1. **Create campaign** in CRM
2. **Select constituents** to target (existing donors, lapsed donors, etc.)
3. **Generate documents**: personalized PDF letters with unique QR code per constituent+campaign
4. **Send by post** (printed and mailed)
5. **Monitor incoming payments** for ~3 months after send

The QR code encodes both the campaign ID and the constituent ID. When a donation arrives (typically via bank transfer or check with the QR reference), the system can automatically match the payment to the specific constituent and campaign — no manual reconciliation needed.

**Critical Salesforce gap**: Salesforce NPSP has no native QR code generation or postal campaign workflow. Greg had to build a custom QR code generator and PDF letter generator. This is a major differentiator opportunity for Givernance.

### Canal 2 — Door-Drops (subset of postal, part of the 60%)

- Generic letter sent via La Poste to an entire geographic zone
- No constituent data at send time — QR code linked to campaign only
- When someone donates via a door-drop QR code, they become a **new constituent** in the system
- Key metric: **campaign ROI** (cost of postal send vs. donations received)
- NPOs must constantly renew door-drops to maintain acquisition pipeline

### Canal 3 — Online Donations (~20% of donations)

- Embeddable donation form/widget on NPO's website
- Public page per campaign — activatable and shareable
- Form should inherit the host site's styling when embedded
- PSP integration via **Stripe Connect**: the NPO creates their own Stripe account, Givernance connects via OAuth
- **Givernance does NOT transit funds** → no PSP license/status required
- Greg has already successfully connected Stripe directly to Salesforce — proven pattern

### Remaining ~20%

Not covered in these insights — likely includes events, major gifts, grants, and other channels.

## 2. Salesforce Pain Points (Opportunities for Givernance)

| Pain Point | Detail | Givernance Opportunity |
|-----------|--------|----------------------|
| No native QR code generation | Had to build custom solution | Built-in QR+PDF generation per campaign |
| No postal campaign workflow | Manual process, no tracking | End-to-end postal campaign wizard |
| Expensive per-user licensing | NPOs pay for inactive users | Commission-based or hybrid pricing model |
| Complex customization | Solutions were either "hackish" or too expensive | Purpose-built for NPO fundraising workflows |
| No campaign ROI tracking | Manual spreadsheet calculations | Native ROI dashboard per campaign |

## 3. Pricing Model Insight

Greg recommends a **commission-based model** (percentage of donations processed through the platform) rather than per-user subscription:

- **Why**: NPOs have variable staff activity. Salesforce charges per user even when staff don't log in for months. A commission model aligns Givernance's revenue with the value it creates for the NPO.
- **Reference**: A company called **Filigrane** uses a similar approach in the NPO data space.
- **Suggested approach**: Small commission (0.5–1%) on donations processed via Givernance (Stripe Connect online donations + QR-matched postal donations).

## 4. Migration Reality

### Case Study: Filigrane Migration

- Source: SQL database with courrier/mailing data
- Problem: **340 columns** on a single spreadsheet — 4 new columns added per campaign over years
- Target model: normalized into **4 entities**: personnes (constituents), foyers (households), donations, campagnes (campaigns)
- This is the real migration challenge NPOs face — not clean Salesforce exports, but decades of accumulated spreadsheet/database debt

### Implications for Givernance Migration Toolkit

- Must handle denormalized spreadsheets, not just Salesforce objects
- Column mapping UI is critical — users need to visually map 340 columns to the relational model
- Household deduplication and linking is a key migration step
- Campaign history reconstruction from flat data is non-trivial

## 5. Integration Architecture Notes

### Stripe Connect Flow
```
NPO admin → Givernance settings → "Connect Stripe" button
  → OAuth redirect to Stripe
  → NPO creates/connects Stripe account
  → Givernance stores Stripe account ID
  → Donation forms use Stripe.js with NPO's connected account
  → Webhook: Stripe → Givernance → creates donation record + matches campaign
```

### QR Code Payment Flow
```
Campaign created → Constituents selected → QR codes generated (campaign_id + constituent_id)
  → PDFs generated with personalized letter + QR
  → Printed and mailed
  → Donor scans QR → payment initiated (bank transfer reference contains QR data)
  → Payment received → auto-matched to constituent + campaign
  → Campaign dashboard updated in real-time
```

## Source

4 audio recordings from Greg, transcribed and analyzed March 2026. Greg has hands-on experience implementing Salesforce NPSP at multiple French NPOs and has built custom solutions for QR code generation, postal campaigns, and Stripe integration.
