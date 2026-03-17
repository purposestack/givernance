# 16 — Greg Field Insights

> Field intelligence from Greg, Salesforce expert with hands-on experience at multiple French and European NPOs.
> Based on 4 audio recordings, transcribed and analyzed March 2026.
> Last updated: 2026-03-17

---

## 1. Overview: Fundraising channel breakdown

European NPOs collect donations through three primary channels with roughly this distribution:

| Channel | % of donations | Constituents known? | Key mechanism |
|---------|---------------|--------------------|----|
| Postal nominative | ~40-50% | Yes | Personalised letter + individual QR code |
| Door-drop | ~10-20% | No (new prospects) | Generic letter to geographic zone |
| Digital (online) | ~20% | Created via form | Website donation page / widget |
| Other (events, in-person, etc.) | ~10-20% | Mixed | Various |

Postal campaigns (nominative + door-drop combined) represent approximately **60% of total donations** for typical European NPOs. This makes postal fundraising the single most important channel to support natively.

---

## 2. Canal 1 — Campagnes postales nominatives

### Operational flow

```
1. Create campaign in CRM
2. Select constituents (segment by giving history, geography, tags)
3. Generate personalised PDF letters
   - Merge fields: salutation, name, last gift amount/date
   - Individual QR code per constituent (encodes campaign_id + constituent_id)
   - Print-ready format (A4, postal window envelope compatible)
4. Export PDFs → send to print house or print in-house
5. Mail letters via postal service
6. Monitor incoming payments over ~3 months
   - QR code scanned at payment → auto-match to constituent + campaign
   - Donation record created, campaign stats updated
7. Generate tax receipts for donors who paid
```

### Key technical requirements
- **QR code generation**: Must encode unique identifier per constituent per campaign. Open-source libraries available (no need for proprietary solution).
- **PDF generation**: Template engine with merge fields, batch generation for thousands of constituents.
- **Payment matching**: When a payment arrives (bank transfer with QR reference), system auto-matches to the correct constituent and campaign.
- **3-month monitoring window**: Payments trickle in over weeks/months after mailing. Campaign dashboard must show real-time progress.

---

## 3. Canal 2 — Door-drops

### Operational flow

```
1. Create door-drop campaign
2. Define target geographic zone (postal codes / commune)
3. Generate generic PDF letter (no personalisation — constituents unknown)
   - QR code encodes campaign_id only (no constituent_id)
4. Contract with La Poste (or equivalent) to distribute to zone
5. Monitor incoming payments
   - First gift from unknown person → create new constituent record
   - QR code links payment to campaign
6. Track ROI: mailing cost vs. donations received
```

### Key metrics
- **ROI per campaign** is the critical metric (cost of printing + postage vs. donations received)
- **Cost per acquisition**: how much it costs to acquire one new donor via door-drop
- **Constant renewal needed**: door-drops must be run regularly to maintain donor pipeline. NPOs that stop door-dropping see donor attrition within 1-2 years.

---

## 4. Canal 3 — Dons en ligne (digital, ~20%)

### Operational flow

```
1. NPO connects their Stripe account via Stripe Connect OAuth
   - Givernance NEVER handles money → no PSP status required
   - NPO creates their own Stripe account, Givernance plugs into it
2. Create digital campaign → activate public donation page
3. Share URL or embed widget/iframe on NPO website
   - Widget inherits site styling (just a form plugged to Stripe + Givernance DB)
4. Donor fills form → Stripe processes payment → webhook to Givernance
5. Givernance creates donation record + constituent (if new) + receipt
6. Campaign dashboard updated in real-time
```

### Stripe Connect architecture
- **Model**: Stripe Connect Standard (NPO owns account, Givernance is platform)
- **No PSP status**: Givernance does not process or transit funds — the NPO's Stripe account does
- **Already proven**: Greg has previously implemented Stripe <> Salesforce integration using this exact pattern
- **Payment methods**: Cards, SEPA Direct Debit, iDEAL, Bancontact (Stripe handles all EU methods)

### Integration flow
```
NPO admin → Givernance settings → "Connect Stripe" button
  → OAuth redirect to Stripe
  → NPO creates/connects Stripe account
  → Givernance stores Stripe account ID
  → Donation forms use Stripe.js with NPO's connected account
  → Webhook: Stripe → Givernance → creates donation record + matches campaign
```

---

## 5. Salesforce gaps identified

Greg's field experience revealed these critical gaps in Salesforce NPSP for European fundraising:

| Gap | Impact | What Greg had to build custom |
|-----|--------|-------------------------------|
| No native QR code generation | Cannot run postal campaigns without custom dev | Built custom QR code generator |
| No PDF letter generation with merge fields | Manual mail merge via Word/external tools | Various workarounds ("solutions a l'arrache") or expensive add-ons |
| No campaign ROI tracking | Cannot evaluate door-drop effectiveness | Custom reports |
| No Stripe Connect integration | No native EU payment processing | Custom Stripe <> Salesforce integration |
| No public donation page builder | Need external tools (Donorbox, etc.) for online giving | External tools plugged in |
| No postal campaign workflow | No end-to-end flow from constituent selection to payment matching | Entirely custom-built |

**Key quote**: *"Salesforce n'a pas un truc cle en main comme ca QR Code. Nous, on avait du creer le generateur de QR Code pour generer les docs."*

These gaps represent **Givernance's primary differentiation opportunity**: native support for the workflows that represent 60%+ of European NPO fundraising.

---

## 6. Pricing model recommendation

### Greg's insight: commission-based vs. per-seat

**Problem with per-seat pricing** (Salesforce model):
- NPOs pay for user licenses even when users are inactive
- Small NPOs with 15-40 users find costs prohibitive (EUR 75+/seat)
- Misaligned incentives: NPO pays regardless of value received

**Recommended alternative: commission on processed donations**
- Charge a percentage on donations processed through the platform
- *"Facturation au ROI"* — billing aligned with the NPO's actual fundraising success
- NPO pays proportionally to value received
- More predictable for NPOs: cost scales with revenue

**Reference**: A company called **Filigrane** uses a similar model in the French NPO market.

**Implication for Givernance**: Consider a hybrid model — low base fee + commission on donations processed via Stripe Connect and QR code payments. This aligns Givernance's revenue with NPO success and removes the per-seat barrier.

---

## 7. Migration realities

### Case study: Filigrane migration

Greg described a real migration scenario:
- **Source**: A legacy database (SQL) with a spreadsheet-based data model
- **Problem**: Each new campaign added 4 columns to the same spreadsheet → **340 columns** total
- **Migration target**: Normalised into relational model — `personnes` (constituents), `foyers` (households), `donations`, `campagnes` (campaigns)
- **Lesson**: The denormalised spreadsheet-to-relational transformation is the real migration challenge

### Implications for Givernance migration toolkit
- Most NPOs migrating to Givernance will come from either Salesforce or spreadsheet/legacy DB systems
- The spreadsheet case is arguably harder than Salesforce (no schema, no API)
- Column-per-campaign pattern is extremely common in NPO spreadsheets
- Migration tool must handle: column explosion → normalised tables, deduplication, household inference
- Column mapping UI is critical — users need to visually map hundreds of columns to the relational model

---

## 8. Implications for Givernance

### Priority features (from Greg's insights)

1. **QR code + PDF letter generation** — Native, not an add-on. This is the #1 differentiator vs. Salesforce for European postal fundraising.
2. **Stripe Connect onboarding** — Simple OAuth flow. NPO never needs to understand payment processing.
3. **Campaign ROI dashboard** — Real-time cost vs. raised tracking. Essential for door-drop campaigns.
4. **Public donation page builder** — Activatable per campaign, embeddable, Stripe-powered.
5. **Payment matching engine** — QR code reference → auto-match to constituent + campaign.

### Competitive positioning

Givernance can claim: **"The only nonprofit CRM with native European postal campaign support — QR codes, PDF letters, payment matching, and campaign ROI — built in, not bolted on."**

This is not a feature Salesforce can easily add (it requires deep integration between campaign management, document generation, payment processing, and constituent matching). It is a structural advantage for a purpose-built European NPO platform.

---

## Source

4 audio recordings from Greg, transcribed and analyzed March 2026. Greg has hands-on experience implementing Salesforce NPSP at multiple French NPOs and has built custom solutions for QR code generation, postal campaigns, and Stripe integration.
