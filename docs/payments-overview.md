# Payments — How money flows, how we earn, why we don't take API keys

This is the **primer**. It explains the moving parts of Givernance's payment architecture — what each Stripe account is for, how a single donation produces money for both the NPO and Givernance, and why each tenant onboards via Stripe Connect rather than pasting an API key. It links to the formal strategy + ADR for depth.

> **Companion docs.** Strategy / ADR-010 / Mollie / SEPA-DD comparison: [20-payment-strategy.md](20-payment-strategy.md). Local Stripe setup walkthrough: [dev/stripe-local-setup.md](dev/stripe-local-setup.md). Pricing tiers: [08-pricing-packaging.md](08-pricing-packaging.md).

---

## TL;DR

- Givernance is a **Stripe Connect platform**. We hold **one** Stripe account (the "platform account").
- Each NPO has **its own** Stripe account. Onboarding "connects" their account to our platform — we never see their keys, and they never see ours.
- Donors pay cards on **the NPO's connected account**. Funds land in the NPO's Stripe balance, not ours.
- On every payment, Stripe automatically routes a **platform fee** (`application_fee_amount`) to Givernance's balance. That's our revenue. Today it's **1.5% + €0.30 per donation** ([packages/api/src/modules/public/service.ts:124-127](../packages/api/src/modules/public/service.ts#L124-L127)).
- Givernance never holds donor funds. No e-money licence required, PCI scope minimal (SAQ A).

---

## The mental model gap

You said: *"I was thinking each organisation had to provide their Stripe key to the tenant settings."* That's the natural assumption coming from B2B SaaS where tenants paste API keys into integration settings. **We deliberately don't do that.** Here's why and what we do instead.

### What "paste your API key" would look like (rejected)

```
Tenant A     →  pastes sk_live_A...  →  stored in tenants.stripe_secret_key
Tenant B     →  pastes sk_live_B...  →  stored in tenants.stripe_secret_key
Givernance API → uses tenant's key when creating PaymentIntents on tenant's behalf
```

Problems:
- **We'd be holding live secret keys** for every NPO. That's a high-value target — leak any one and an attacker can fully impersonate that NPO on Stripe (including issuing refunds, viewing customer data, exporting full transaction history).
- **Storing keys = secret management overhead** (rotation, audit, encryption-at-rest, breach disclosure if leaked).
- **No separation of duties.** Stripe sees us as the merchant. The NPO has no native Stripe dashboard, no native Stripe payout, no native Stripe support contact, no native dispute UI. Everything has to be re-built by Givernance.
- **No native fee mechanism.** We'd have to manually transfer money from each NPO's account to ours after every charge — which means we'd touch the funds, which triggers e-money licensing in the EU.
- **Compliance burden balloons.** The merchant of record (us) inherits PCI scope and AML obligations across the whole donor base.

### What we actually do — Stripe Connect (Express)

```
Givernance      →  one platform account (sk_test_… / sk_live_…)
Tenant A        →  has their OWN Stripe Express account, connected to our platform
                   → we know acct_A_xxx (just the ID, no keys)
Tenant B        →  has their OWN Stripe Express account, connected to our platform
                   → we know acct_B_xxx
```

When we make API calls on a tenant's behalf, we authenticate as the platform and pass the connected account ID:

```ts
// packages/api/src/modules/public/service.ts — donate intent creation
const requestOptions = { stripeAccount: tenant.stripeAccountId };
await stripe.paymentIntents.create(intentParams, requestOptions);
```

That's all we need. **We never store the NPO's secret key — we don't have one.** Stripe knows we're authorised to act on `acct_A_xxx` because the NPO clicked through Connect onboarding and granted that permission.

What the NPO gets in exchange:
- Their own Stripe Express dashboard at `https://connect.stripe.com/express/...` — they see every donation, payout, dispute, refund.
- Direct payouts from Stripe to their own bank account on Stripe's payout schedule (no intermediate Givernance hop).
- Native Stripe support, native Stripe refund button, native Stripe dispute UI, native Stripe receipts.
- A real Stripe account they could in principle leave Givernance with (data portability).

What Givernance gets:
- An API token-of-trust to act on the NPO's account, scoped to "create PaymentIntents and read account status."
- Automatic platform-fee collection on every charge, with no manual transfer.
- Zero secret-key storage burden.
- Reduced PCI scope (SAQ A — see [20-payment-strategy.md §6](20-payment-strategy.md#6-pci-dss-compliance)).
- No e-money licensing — funds never touch our balance except as platform fees.

### Why this is also better for the NPO

Beyond the technical wins above, **the NPO's relationship is with Stripe**, not with Givernance for payments. If Givernance disappeared tomorrow, the NPO would still have:
- Their Stripe account (with full transaction history).
- Direct access to their Stripe balance and payout schedule.
- The donor data Stripe holds for compliance.

That's a deliberately weak-coupling: Givernance provides the CRM + campaign UX + tax-receipt workflow, Stripe handles money. Each NPO knows where their money is at all times, and there's no Givernance-shaped failure mode that could trap their funds.

---

## How money flows on a single donation

This is the actual sequence for a donor giving €50 on a campaign page.

```
                         ┌──────────────────┐
                         │  Donor (browser) │
                         └────────┬─────────┘
                                  │  1. POST /v1/public/campaigns/:id/donate
                                  │     { amountCents: 5000, currency: "EUR", email, ... }
                                  ▼
┌───────────────────────────────────────────────────────────────┐
│  Givernance API                                               │
│                                                               │
│  • looks up tenant.stripe_account_id (e.g. acct_NPO_abc)      │
│  • computes platform fee = 1.5% + 30¢ = 105 cents             │
│  • stripe.paymentIntents.create(                              │
│       { amount: 5000, application_fee_amount: 105, … },       │
│       { stripeAccount: "acct_NPO_abc" }   ← direct charge     │
│    )                                                          │
│  • returns clientSecret + stripeAccountId to browser          │
└────────┬──────────────────────────────────────────────────────┘
         │
         │  2. browser loads Stripe.js bound to acct_NPO_abc
         │     and confirms the card via Payment Element
         ▼
┌──────────────────┐    3. card auth      ┌──────────────────┐
│  Donor (browser) │ ───────────────────► │      Stripe      │
└──────────────────┘                      └────────┬─────────┘
                                                   │
                                                   │  4. on success:
                                                   │     - €50 charged to donor's card
                                                   │     - €50 lands on acct_NPO_abc balance
                                                   │     - €1.05 routed from acct_NPO_abc
                                                   │       to Givernance platform balance
                                                   │     - Stripe processing fee (~€1.00 for
                                                   │       EU card) deducted from acct_NPO_abc
                                                   │
                                                   │  5. payment_intent.succeeded webhook
                                                   │     fired with event.account = acct_NPO_abc
                                                   ▼
┌───────────────────────────────────────────────────────────────┐
│  Givernance API + Worker                                      │
│                                                               │
│  • verify Stripe signature                                    │
│  • idempotent insert into webhook_events                      │
│  • enqueue BullMQ job (async)                                 │
│  • worker:                                                    │
│      - resolve tenant by acct_NPO_abc                         │
│      - upsert constituent (match by email)                    │
│      - insert donation row                                    │
│      - emit DonationCreated outbox event                      │
└───────────────────────────────────────────────────────────────┘

       Eventually (Stripe's payout schedule, typically 2-7 days):

acct_NPO_abc (Stripe balance)  ──────►  NPO's bank account
Givernance platform balance    ──────►  Givernance's bank account
```

Three things happen on a single Stripe charge, automatically and atomically:

1. **Donor's card → connected account** (gross amount).
2. **Connected account → platform account** (`application_fee_amount`). This is the slice that's our revenue. Stripe deducts it from the connected account's incoming balance and credits it to the platform's balance. **No manual transfer needed.**
3. **Stripe processing fee** is deducted from the connected account (default for direct charges). This is the cost the NPO pays Stripe — it's *not* Givernance revenue.

### Worked example — €50 donation in EUR

| Line item                                           | Amount  | Goes to        |
| --------------------------------------------------- | ------- | -------------- |
| Donor charged                                       | €50.00  | (out of donor) |
| Stripe processing fee (~1.5% + €0.25, EU card)      | -€1.00  | Stripe         |
| Givernance platform fee (1.5% + €0.30)              | -€1.05  | Givernance     |
| **Net to NPO Stripe balance**                       | **€47.95** | NPO       |

The numbers above show what the NPO actually receives; the donor is charged the full €50.

> **Stripe's processing fee can vary** by card type, country of issue, currency, and your Stripe agreement. The figure above is the typical EU card baseline — see https://stripe.com/pricing for the current schedule. Givernance does not control that fee.

> **The platform fee is configurable.** Today it's hardcoded at `1.5% + 30¢` in [packages/api/src/modules/public/service.ts:125](../packages/api/src/modules/public/service.ts#L125). When pricing tiers ship (per [docs/08-pricing-packaging.md](08-pricing-packaging.md)), this becomes a per-tenant value driven by their plan.

### Why we use direct charges (not destination charges)

Two Stripe Connect charge models exist:

- **Direct charges** — PaymentIntent created on the connected account. Funds land directly in the NPO's balance. Application fee splits to platform. *This is what we use.*
- **Destination charges** — PaymentIntent created on the platform. Funds initially land in the platform balance, then transferred to connected account. Platform sees full gross.

Direct charges are the right pick for Givernance because:
- Funds never touch our balance, even briefly. That keeps us out of e-money licensing scope (see [20-payment-strategy.md §4 ADR-010](20-payment-strategy.md#4-adr-010--payment-provider-selection)).
- Stripe's receipts/disputes flow stays NPO-branded — the donor sees the NPO's name, not Givernance's, on their card statement.
- Refunds process directly against the NPO's balance — no Givernance involvement.

The trade-off: each NPO's Stripe account name is what donors see on their statement. That's actually what we want — donors gave to *the NPO*, not to *Givernance*.

---

## What an NPO sees, end-to-end

1. **Onboarding** — org admin opens **Settings → Stripe Connect → Connect Stripe**. Redirects to Stripe's hosted Express form. Fills business info, bank details, identity verification. Lands back on Givernance with a "Connected" badge. (Test mode: takes ~60 seconds with placeholder data, no verification.)
2. **Receiving donations** — every public donation page now shows the Payment Element. Donors pay; charges appear in the NPO's Stripe Express dashboard within seconds.
3. **Payouts** — Stripe automatically pays out the NPO's balance to their bank account on Stripe's schedule (typically 2-7 days for new accounts, faster once established). The NPO sees the payout schedule in their Express dashboard.
4. **Refunds & disputes** — handled in the NPO's Stripe dashboard or via Givernance UI (the latter just calls Stripe APIs on the NPO's behalf). When a refund is issued, the platform fee is automatically returned to the NPO too — Stripe rolls it back.
5. **Tax receipts** — handled by Givernance (the NPO's CRM). The Stripe receipt email is separate.

---

## What Givernance sees

- **Platform balance**: shows the cumulative `application_fee_amount` collected across all NPOs.
- **Platform dashboard**: every connected account is listed at https://dashboard.stripe.com/test/connect/accounts/overview — we can see each NPO's KYC status, charges enabled, payout health.
- **Database**: `tenants.stripe_account_id` stores the NPO's `acct_…` ID. Every donation row in `donations` has `payment_method = "stripe"` and `payment_ref = pi_…`.
- **Auditable money trail**: each `donation` ↔ `webhook_event` ↔ Stripe `pi_…` is one-to-one and signed.

---

## Why this maps to the impact-based business model

You said: *"Our business model is based on impact — based on the payments done to donate. We take a fee."*

Stripe Connect maps to this model exactly:

- **Per-donation fee** (1.5% + 30¢) — collected automatically as `application_fee_amount`. **No invoicing, no manual reconciliation, no late payments.** When the NPO grows in donations, our revenue scales with it. When they don't raise money, we don't collect a fee.
- **No fixed seat licence required** — we *can* layer one on top later (per `08-pricing-packaging.md`), but the core engine ("we earn when NPOs raise") is already wired.
- **Visible & honest** — the NPO sees the application fee in their Stripe dashboard, line by line. Nothing is hidden in a separate billing system.
- **Aligned incentives** — if Givernance helps an NPO raise more, both sides win on the same dollar. There's no "we charge €X/month regardless."

The fee is **set per tenant** (currently a hardcoded constant, per-tenant later). Future plans (per [docs/08-pricing-packaging.md](08-pricing-packaging.md)) include:
- Tiered fee % based on tenant size or plan.
- Custom fee for partner NPOs / discount codes.
- Override to 0% for free-tier or trial tenants.

The implementation hook is [`calculatePlatformFee(amountCents)`](../packages/api/src/modules/public/service.ts#L125). Today it returns `Math.round(amountCents * 0.015 + 30)`. Replacing that with a per-tenant lookup (`getPlatformFee(tenantId, amountCents)`) is the path to plan-gated fees.

---

## Where the code lives

| Concern                          | File                                                                                                | Notes                                                                |
| -------------------------------- | --------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| Onboarding (start)               | [packages/api/src/modules/payments/service.ts](../packages/api/src/modules/payments/service.ts)     | `startStripeOnboarding` creates Express account + onboarding link    |
| Onboarding (status)              | same file                                                                                           | `getStripeConnectStatus` reads live capability flags                 |
| Settings UI                      | [packages/web/src/components/settings/stripe-connect-panel.tsx](../packages/web/src/components/settings/stripe-connect-panel.tsx) | Calls the two endpoints above                                        |
| PaymentIntent creation           | [packages/api/src/modules/public/service.ts](../packages/api/src/modules/public/service.ts)         | `createDonationIntent` — direct charge on connected account          |
| Platform fee formula             | same file, `calculatePlatformFee`                                                                   | `1.5% + 30¢` (hardcoded today)                                       |
| Donor Payment Element            | [packages/web/src/components/campaigns/public-donation-payment-step.tsx](../packages/web/src/components/campaigns/public-donation-payment-step.tsx) | `loadStripe(pk, { stripeAccount })`                                  |
| Webhook ingestion                | [packages/api/src/modules/payments/routes.ts](../packages/api/src/modules/payments/routes.ts)       | Signature verification → idempotent insert → enqueue                 |
| Donation row creation            | [packages/worker/src/processors/stripe-webhook.ts](../packages/worker/src/processors/stripe-webhook.ts) | Resolves tenant by `acct_…`, upserts constituent, inserts donation   |
| Schema                           | [packages/shared/src/schema/index.ts](../packages/shared/src/schema/index.ts) — `tenants.stripe_account_id`, `webhook_events` | One ID per tenant; idempotency via `(provider, provider_event_id)`    |

---

## The rejected alternative — "we collect, we pay out monthly"

The natural alternative architecture (the one most people imagine when they first hear the problem) is:

> "Donors pay Givernance directly. We track per-NPO totals in our DB. End of month, we send each NPO a single bulk payment to their bank account."

This is sometimes called the **payment-aggregator** or **platform-of-record** model. It is real, it's used in production by serious players (HelloAsso in France is the best-known nonprofit example), and we considered it. Here's why we picked Stripe Connect instead.

### What an aggregator model would look like

```
Donor (France)   →  €50 →  Givernance's Stripe account  →  €50 sits in our balance
Donor (Germany)  →  €30 →  Givernance's Stripe account  →  €30 sits in our balance
…
End of month:    Givernance →  bulk SEPA transfer →  each NPO's bank account
```

NPO experience:
- No Stripe sign-up. They give us a bank account number, that's it.
- Payouts arrive monthly (or on whatever cadence we set).
- Donor's card statement reads "Givernance" — they have to recognise our brand, not the NPO's.
- All disputes/refunds/chargebacks land on us; we pass the cost on to the NPO somehow.

### Why this is a bigger lift than it looks

The blockers are mostly regulatory, and they're load-bearing.

1. **EU payment-institution licensing (PSD2).** When you hold third-party funds with the intent to forward them — even briefly — you're operating as a payment intermediary. Under PSD2 in the EU, that requires either an **EMI** (Electronic Money Institution) or **PI** (Payment Institution) licence from a national regulator (ACPR in France, BaFin in Germany, FCA in the UK, etc.). Floor cost:
    - Minimum capital requirement: €350k (PI scope) up to €2M (EMI).
    - Application timeline: 6-18 months from filing.
    - Ongoing compliance: AML/KYC programme, fraud monitoring, segregated client-money accounts, regulatory reporting, internal audit, periodic regulator inspections.
    - Total runway: typically 12-24 months and €1-3M before first donation lands.
2. **AML/KYC obligation moves onto us.** With Connect, Stripe KYCs every NPO connected account before allowing charges — they have an EMI licence and that's their job. With aggregator, *we* are the financial institution, *we* KYC every NPO, *we* are liable if a fake "NPO" launders money through our platform. The investigation, sanction-screening, beneficial-ownership, periodic-refresh apparatus has to be built in-house.
3. **Chargebacks become our balance-sheet risk.** Donor calls their bank, says "I don't recognise this charge from Givernance." Bank claws back the €50 from our Stripe balance. With Connect, the same scenario claws back from the NPO's balance — Givernance is unaffected. With aggregator, the NPO's monthly payout is short by €50 and we have to either eat the difference, claw it back from the NPO's next payout, or run a collections process.
4. **Tax/receipts cross borders messily.** Donor in France giving to a Belgian NPO, in the aggregator model, is two transactions: (a) donor → Givernance France, (b) Givernance → NPO Belgium. That's potentially two VAT events, two tax-receipt jurisdictions, two reporting obligations. With direct charges, the NPO is the merchant of record — one transaction, one jurisdiction.
5. **Cash-flow visibility for the NPO.** Monthly payouts mean the NPO waits 0-30 days, sees totals only after we send them, and has no native dashboard. With Connect Express, the NPO sees every donation land in real time, sees the payout schedule, and can talk to Stripe support directly.
6. **Concentration of trust.** "If Givernance has cash-flow issues or banking trouble, your monthly payout is at risk" is a harder pitch to a finance director than "your money lives in your own Stripe account."

### When we'd revisit this decision

Connect isn't a hill to die on — it's the right call *for the current product, scale, and timeline*. We'd legitimately reopen the question if any of the following changed:

- We want to onboard NPOs that **cannot** sign up to Stripe (jurisdiction not supported, or NPO too small / informal to satisfy Stripe's KYC). Today, ~95% of EU/UK nonprofits qualify for a Stripe Express account. The exceptions are mostly rural, very-small associations, or ones operating in jurisdictions Stripe hasn't covered yet (parts of Eastern Europe, some niches).
- We have a strategic reason to be the merchant of record — e.g., we want to issue *Givernance-branded* receipts (currently the receipt comes from each NPO).
- The fee structure of an aggregator model (volume-discounted Stripe rates we'd negotiate as a single high-volume merchant, then re-distribute) becomes materially better for NPOs than them paying retail Stripe rates individually. This requires us doing many millions of euros / month in volume.
- Compliance / legal lifts the regulatory blocker (e.g., we acquire or partner with an existing PI/EMI licence-holder).

A hybrid is also possible: Connect as the default, with an **aggregator fallback** for the long tail of NPOs that can't onboard with Stripe. That's a real product direction — track it as a separate spike when the demand surfaces.

### Where this decision lives

This is one of the core decisions in **ADR-010** ([20-payment-strategy.md §4](20-payment-strategy.md#4-adr-010--payment-provider-selection)). Notably, the explicit rationale recorded there is:

> "Platform commission model: `application_fee_amount` on each charge enables Givernance to collect its platform fee without handling e-money flows — **no e-money licence required**"

So the strategy was deliberately chosen, with the licence-avoidance benefit as one of the load-bearing arguments. The other major payment-aggregator player in our space (HelloAsso, France) operates under a payment-institution licence specifically — which validates that the alternative model is viable but expensive to enter.

If we want to revisit this in light of new information (a partnership opportunity, a regulatory change, a long-tail-of-NPOs problem we want to solve), the path is a new ADR superseding ADR-010, not a quiet re-architecture.

---

## What's not in production yet

This document describes the architecture that is **implemented today**. Several extensions are tracked but not built:

- **Auto-promote to live mode** when `account.updated.charges_enabled = true` — [issue #62](https://github.com/purposestack/givernance/issues/62).
- **Mollie as co-primary** for FR/BE/NL (lower fee on iDEAL/Bancontact) — [issue #62](https://github.com/purposestack/givernance/issues/62), gated by `ff.payments.mollie`.
- **SEPA Direct Debit** for recurring donations — [issue #26](https://github.com/purposestack/givernance/issues/26).
- **Per-tenant fee** (driven by plan instead of a constant) — pending pricing finalisation in [docs/08-pricing-packaging.md](08-pricing-packaging.md).
- **Restricted Stripe keys with scoped permissions** for the live key — see [20-payment-strategy.md §6](20-payment-strategy.md#6-pci-dss-compliance).

---

## Common questions

**Q: When an NPO refunds a donation, do we keep the platform fee?**
No. By Stripe Connect default, refunding a charge also refunds the application fee. The €1.05 we collected is returned to the NPO's balance and the donor gets the full €50 back. We can override this (`refund_application_fee: false`) but currently don't.

**Q: What if Stripe is down?**
Donor sees a payment error. No PaymentIntent is created, no donation row is written. Givernance is operationally fine — the rest of the CRM keeps working. Stripe outages are rare and short.

**Q: What if our webhook signature secret rotates?**
Webhooks fail signature verification (400 response). Stripe retries automatically with exponential backoff for up to 3 days. As long as we deploy the new secret within that window, no donation rows are lost. The PaymentIntent itself succeeded regardless — funds are in the NPO's balance even before our webhook handler sees the event.

**Q: Can an NPO leave Givernance and keep their Stripe account?**
Yes. The Stripe Express account is theirs. Disconnecting from our platform means we lose the API permission to act on their behalf, but their account, balance, donation history, and payout schedule all continue. (We don't currently expose an in-app "disconnect" button — they'd revoke from Stripe's side.)

**Q: What about countries where Stripe doesn't operate?**
That's the Mollie / Mangopay / SIX comparison in [20-payment-strategy.md §3](20-payment-strategy.md#3-provider-comparison). Stripe covers most EU/EEA + UK + US + a few others; for jurisdictions Stripe doesn't support, we'd route through a different provider via the `PaymentGateway` factory.

**Q: Why 1.5% + 30¢ specifically?**
Placeholder rounded-to-be-readable. The actual final platform fee is unsettled — see [docs/08-pricing-packaging.md](08-pricing-packaging.md) for pricing-tier work. The 30¢ floor exists so micro-donations (€1, €2) don't disappear into the platform fee entirely; on a €50 donation it's a small slice, but on a €1 donation a flat 1.5% would be 1.5¢, which is below Stripe's processing minimum cost to us.
