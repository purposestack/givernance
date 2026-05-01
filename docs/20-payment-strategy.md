# 20 — Payment Systems Strategy

> **Status**: Spike / Analysis — Phase 1 implementation target
> **Owner**: Payment Engineer agent (`.claude/agents/payment-engineer.md`)
> **Related**: `02-reference-architecture.md`, `03-data-model.md`, `04-business-capabilities.md`, `06-security-compliance.md`, `08-pricing-packaging.md`, `15-infra-adr.md`
> **Closes**: #10
>
> **Looking for the primer?** See [`payments-overview.md`](payments-overview.md) for a focused walkthrough of how fees are collected, how money reaches the NPO, and why each tenant onboards via Stripe Connect rather than pasting an API key. This document is the formal strategy and ADR; the primer is the conceptual companion.

## 1. Goals

The payment strategy must answer:

1. **Which provider(s)** should Givernance integrate for Phase 1?
2. **What architecture** — direct integration, abstraction layer, or Connect platform model?
3. **How** do we handle recurring donations, refunds, and reconciliation? (SEPA Direct Debit deferred to Phase 2 — see §2 and §11)
4. **How** do we stay PCI DSS compliant without the burden of SAQ D?
5. **How** do we remain GDPR-compliant with EU data residency?

## 2. Requirements

### Functional

| Requirement | Priority |
|---|---|
| Online card payments (one-off donations) | P0 — Phase 1 |
| SEPA Direct Debit (recurring mandates) | P1 — Phase 2 |
| Recurring / subscription billing | P0 — Phase 1 |
| Refunds and credit notes | P0 — Phase 1 |
| Webhook-driven donation recording | P0 — Phase 1 |
| Donation page embed (iframe/hosted) | P0 — Phase 1 |
| Multi-tenant: each NPO has its own payment account | P1 — Phase 1 |
| Platform commission on processed donations | P1 — Phase 1 |
| UK Gift Aid compatibility | P1 — Phase 1 |
| iDEAL (Netherlands), Bancontact (Belgium), EPS (Austria) | P2 — Phase 2 |
| Payouts to NPO bank accounts | P2 — Phase 2 |
| DACH local payment methods | P2 — Phase 2 |

### Non-functional

| Requirement | Constraint |
|---|---|
| GDPR / EU data residency | All payment data processed + stored in EU |
| PCI DSS | SAQ A target — no card data on Givernance servers |
| Single DPA | Prefer providers with EU GDPR DPA |
| Multi-tenant | Each NPO isolated; Givernance as platform |
| Webhook reliability | At-least-once delivery with idempotent processing |
| Reconciliation | Daily statement vs DB reconciliation |

## 3. Provider Comparison

### 3.1 Stripe Connect

| Attribute | Detail |
|---|---|
| Headquarters | San Francisco, US — EU operations via Stripe Payments Europe Ltd (Dublin) |
| Data residency | EU region available (data stored in AWS EU-WEST) |
| GDPR DPA | ✅ Standard Contractual Clauses (SCC) — widely accepted |
| PCI DSS | ✅ SAQ A — Stripe.js / Checkout / Payment Element |
| SEPA DD | ✅ Native — `sepa_debit` payment method |
| Recurring billing | ✅ Native — Stripe Subscriptions or PaymentIntents off-session |
| Platform/marketplace | ✅ **Stripe Connect** — best-in-class. Each NPO gets a connected account; Givernance takes platform fee via `application_fee_amount` |
| Commission model | ✅ `application_fee_amount` on each payment — Givernance collects fee directly |
| Multi-currency | ✅ 135+ currencies |
| iDEAL / Bancontact / EPS | ✅ All supported via Payment Element |
| Gift Aid | ✅ Payments work; Gift Aid claim is application-level (HMRC submission) |
| Pricing (EU) | 1.5% + €0.25 (EU cards) · 2.5% + €0.25 (non-EU) · SEPA DD: 0.8% capped €5 |
| NPO discounts | ❌ No dedicated NPO pricing (unlike Mollie) |
| SDK quality | ✅ Excellent — Node.js SDK, TypeScript types, Stripe CLI |
| Webhooks | ✅ Signed, retry logic, event log, Stripe CLI local testing |

**Connect model for Givernance**:
```
Donor → Stripe Checkout (hosted by Stripe)
  ↓
Payment captured → Stripe splits:
  - NPO connected account receives: amount - Stripe fees - Givernance platform fee
  - Givernance platform account receives: application_fee_amount
  ↓
Webhook → Givernance API → creates donation record
```

This means Givernance **never touches donor funds** — clean separation, no e-money licence needed.

### 3.2 Mollie

| Attribute | Detail |
|---|---|
| Headquarters | Amsterdam, Netherlands 🇳🇱 — natively EU |
| Data residency | ✅ EU-only (Amsterdam) |
| GDPR DPA | ✅ Native EU company — no SCC needed |
| PCI DSS | ✅ SAQ A — Mollie Components / Hosted Checkout |
| SEPA DD | ✅ Native |
| Recurring billing | ✅ Subscriptions + off-session mandates |
| Platform/marketplace | ⚠️ Mollie Organisations API — less mature than Stripe Connect |
| Commission model | ⚠️ Requires manual payout flows; no `application_fee` equivalent |
| Multi-currency | EUR primary; limited multi-currency |
| iDEAL / Bancontact / EPS | ✅ **Best-in-class for Benelux/DACH local methods** |
| Gift Aid | ⚠️ Payments work; same application-level HMRC claim |
| Pricing | €0.25–0.35/transaction (flat fee + %) — competitive for EU |
| NPO discounts | ✅ **Mollie has dedicated NPO/charity pricing** |
| SDK quality | ✅ Good — Node.js SDK, TypeScript support |
| Webhooks | ✅ Signed, good documentation |

**Assessment**: Mollie is excellent for FR/BE/NL NPOs due to local payment methods, NPO pricing, and simplified NPO verification. Co-primary alongside Stripe for French, Belgian, and Dutch associations from Phase 1. Connect model less mature than Stripe, but sufficient for single-tenant payment flows in these markets.

> **Note:** Mollie integration implementation deferred to Sprint 4 (Issue #62) to keep the initial Stripe MVP PR focused.

### 3.3 Mangopay

| Attribute | Detail |
|---|---|
| Headquarters | Luxembourg 🇱🇺 — natively EU |
| Data residency | ✅ EU-only |
| GDPR DPA | ✅ Native EU |
| PCI DSS | ✅ SAQ A |
| SEPA DD | ✅ but via mandate-based flow (less developer-friendly) |
| Recurring billing | ⚠️ Mandate-based; no native Subscriptions API |
| Platform/marketplace | ✅ **Core product** — built for marketplace money flows (e-wallets, splits, payouts) |
| Commission model | ✅ Wallet-based split — Givernance takes a cut before payout |
| E-money licence | ✅ Mangopay is an e-money institution — handles money movement natively |
| Multi-currency | ✅ |
| iDEAL / Bancontact | ✅ |
| Gift Aid | ❌ Not supported |
| Pricing | % + flat fee; volume-based negotiation; higher than Stripe for low volumes |
| NPO discounts | ❌ |
| SDK quality | ⚠️ Average — TypeScript SDK exists but less polished |
| Webhooks | ✅ |

**Assessment**: Mangopay is purpose-built for marketplace/platform money movement. Relevant **if** Givernance evolves toward an umbrella model where donations are pooled, split, and distributed to multiple sub-organisations. Overkill for Phase 1. Worth revisiting at Phase 3+.

### 3.4 SIX Saferpay (Worldline)

| Attribute | Detail |
|---|---|
| Headquarters | Basel, Switzerland 🇨🇭 |
| Data residency | ✅ Switzerland / EU datacentres |
| GDPR DPA | ✅ EU DPA available |
| PCI DSS | ✅ SAQ A via Payment Page / Hosted Fields |
| SEPA DD | ⚠️ Via acquiring bank — not a first-class API resource |
| Recurring billing | ❌ No native subscription management |
| Platform/marketplace | ❌ Not designed for platform model |
| Commission model | ❌ No platform fee mechanism |
| Multi-currency | ✅ |
| Local methods | ✅ TWINT (Switzerland), PostFinance — strong DACH |
| Gift Aid | ❌ |
| Pricing | Negotiated per account — not publicly listed |
| NPO discounts | ⚠️ Case-by-case |
| SDK quality | ⚠️ JSON API but no official Node.js SDK — must build client |
| Webhooks | ✅ |

**Assessment**: Saferpay is the right choice for Swiss-market NPOs (TWINT is dominant in Switzerland). Not suitable as a primary platform provider — no recurring billing API, no Connect equivalent. Relevant only as a Phase 3+ add-on for `.ch` tenants.

### 3.5 Summary matrix

| Criterion | Stripe | Mollie | Mangopay | Saferpay |
|---|:---:|:---:|:---:|:---:|
| EU data residency | ✅ | ✅ | ✅ | ✅ |
| SEPA DD (native API) | ✅ | ✅ | ⚠️ | ❌ |
| Recurring billing | ✅ | ✅ | ⚠️ | ❌ |
| Multi-tenant Connect | ✅ | ⚠️ | ✅ | ❌ |
| Platform commission | ✅ | ❌ | ✅ | ❌ |
| iDEAL/Bancontact/EPS | ✅ | ✅ | ✅ | ❌ |
| TWINT (CH) | ❌ | ❌ | ❌ | ✅ |
| NPO pricing | ❌ | ✅ | ❌ | ⚠️ |
| Gift Aid | ✅ | ✅ | ❌ | ❌ |
| SDK quality | ✅ | ✅ | ⚠️ | ❌ |
| Phase 1 readiness | ✅ | ✅ | ❌ | ❌ |

## 4. ADR-010 — Payment Provider Selection

> **Note:** The full architectural decision record has been moved to [ADR-010](../adrs/adr-010-payment-provider-selection.md).

## 5. Architecture

### 5.1 Payment abstraction layer

```
packages/api/src/lib/payments/
  gateway.interface.ts        ← PaymentGateway interface (createIntent, captureWebhook, refund, createMandate)
  stripe.gateway.ts           ← Stripe implementation
  mollie.gateway.ts           ← Mollie implementation (Phase 1 for FR/BE/NL tenants)
  gateway.factory.ts          ← Returns correct gateway based on tenant.payment_gateway setting
```

The `PaymentGateway` interface isolates payment logic from domain logic:

```typescript
interface PaymentGateway {
  createPaymentIntent(params: CreatePaymentIntentParams): Promise<PaymentIntentResult>;
  createSetupIntent(params: CreateSetupIntentParams): Promise<SetupIntentResult>;    // SEPA mandate
  chargeOffSession(params: ChargeOffSessionParams): Promise<ChargeResult>;           // recurring installment
  refund(params: RefundParams): Promise<RefundResult>;
  constructWebhookEvent(rawBody: Buffer, signature: string): WebhookEvent;
}
```

### 5.2 Stripe Connect onboarding flow

```
1. Super_admin creates NPO tenant
2. API calls: stripe.accounts.create({ type: 'express', country: 'FR', email })
3. API calls: stripe.accountLinks.create({ account, type: 'account_onboarding' })
4. Returns onboarding URL → NPO admin completes KYC on Stripe
5. NPO immediately enters TEST MODE — can use Stripe test keys to run
   the full donation flow (test cards, test SEPA) while KYB is pending (2-5 days)
6. Webhook: account.updated { charges_enabled: true } → switch tenant to LIVE MODE
   > **Note:** The `account.updated` webhook handler is deferred to Sprint 4 (Issue #62) to keep the initial Stripe MVP PR focused. For now, tenant live-mode activation is manual.
7. All subsequent charges: { stripe_account: tenant.stripe_account_id, application_fee_amount }
```

> **Test mode for fast onboarding**: KYB verification takes 2-5 business days, which blocks the "demo → first donation in < 1 hour" goal. To solve this, every new NPO starts in **Stripe test mode** immediately after step 4. The NPO admin can validate the complete flow — donation page, webhook processing, receipt generation — using Stripe test cards (`4242...`) and test SEPA IBANs. Once `account.updated { charges_enabled: true }` fires, the tenant is automatically switched to live mode. This ensures the "first donation in < 1 hour" experience while KYB runs in the background.
>
> **Note:** The automatic live-mode switch via `account.updated` webhook is deferred to Sprint 4 (Issue #62). Until then, live-mode activation requires manual intervention.

### 5.3 Webhook ingestion

```
POST /v1/donations/stripe-webhook   (public endpoint — no auth)
POST /v1/donations/mollie-webhook   (public endpoint — no auth, Phase 1 for FR/BE/NL — add to doc-04 API surface when ff.payments.mollie ships)
```

Both endpoints:
1. Verify webhook signature (provider-specific)
2. Check idempotency (`webhook_events` table)
3. Enqueue BullMQ job for async processing
4. Return 200 immediately (provider retries on non-200)

Processing is **async** (BullMQ) to avoid timeout on slow DB writes. The webhook handler itself is as thin as possible.

**BullMQ job config for webhook processor:**
```typescript
defaultJobOptions: {
  attempts: 3,
  backoff: { type: 'exponential', delay: 5000 }, // 5s, 10s, 20s
  removeOnComplete: 100, // keep last 100 completed for debugging
  removeOnFail: 500,     // keep failed jobs for investigation
}
```

### 5.4 Data model additions

```typescript
// Addition to packages/shared/src/schema/

export const webhookEvents = pgTable('webhook_events', {
  id: uuid('id').primaryKey().$defaultFn(() => uuidv7()),
  provider: text('provider').notNull(),               // 'stripe' | 'mollie'
  providerEventId: text('provider_event_id').notNull(),
  type: text('type').notNull(),
  orgId: uuid('org_id').references(() => tenants.id, { onDelete: 'set null' }), // nullable — null for platform-level events (e.g. account.updated)
  payload: jsonb('payload').notNull(),
  status: text('status').notNull(),                   // 'processing' | 'processed' | 'failed'
  error: text('error'),
  processedAt: timestamp('processed_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
}, (t) => ({
  uniqueProviderEvent: uniqueIndex('uq_webhook_provider_event').on(t.provider, t.providerEventId),
  byOrg: index('idx_webhook_events_org').on(t.orgId),
  byStatus: index('idx_webhook_events_status').on(t.status),
}));
```

Existing `donations` table additions:
```sql
-- Already in doc-03, confirming alignment:
payment_gateway  TEXT NOT NULL CHECK (payment_gateway IN ('stripe', 'mollie', 'manual'))
payment_ref      TEXT           -- stripe payment_intent_id or mollie payment id
```

Existing `pledges` table additions needed:
```sql
stripe_customer_id  TEXT  -- Stripe Customer object id
stripe_account_id   TEXT  -- Connected account id (for Connect charges)
payment_gateway     TEXT NOT NULL DEFAULT 'stripe'
```

## 6. PCI DSS Compliance

### Target: SAQ A

Givernance targets **PCI DSS SAQ A** — the lightest compliance level — by ensuring card data never touches Givernance infrastructure.

| Requirement | Implementation |
|---|---|
| Card capture | Stripe.js / Stripe Payment Element (iframe, hosted by Stripe) |
| SEPA capture | Stripe IBAN Element (hosted by Stripe) |
| Data stored | Only opaque refs: `stripe_payment_intent_id`, `stripe_mandate_id`, last 4 digits |
| TLS | TLS 1.3 minimum on all endpoints (doc-06 baseline) |
| Webhook secret | In environment variables only — never in DB or source code |
| Log redaction | `body.iban`, `body.cardNumber`, `body.pan`, `body.cvv` in Pino redact paths |

**Annual review**: The Security Architect must confirm SAQ A scope annually. Any new code path that could introduce card data handling triggers a scope review.

## 7. GDPR Considerations

| Concern | Decision |
|---|---|
| Legal basis for payment processing | **Contract** (Art. 6(1)(b)) — payment is required to fulfil the donation transaction |
| Data stored by Givernance | Opaque refs only — Stripe stores card/IBAN data under their own DPA |
| Stripe DPA | Standard Contractual Clauses (SCC) — widely accepted in EU; data in AWS EU-WEST |
| Mollie DPA | Native EU company (Amsterdam) — no SCC needed |
| SEPA mandate proof | Mandate acceptance timestamp + IP hash stored in `pledges` — lawful basis Art. 7 (explicit consent) |
| Donor right to erasure | Payment refs are **financial records** — exempt from erasure (legal obligation Art. 6(1)(c), 7-year accounting requirement). Document exception in doc-06. |
| Stripe customer ID in erasure | On GDPR erasure request: call `stripe.customers.del(customerId)` to delete payment methods from Stripe. Retain Givernance donation records (financial obligation) but mark `constituent.gdpr_erased = true`. |
| Fraud detection data | Stripe processes IP, device fingerprint for fraud scoring — covered by Stripe's own DPA |

## 8. Cross-Agent Rules

### For MVP Engineer
- All Stripe API calls MUST include `idempotencyKey: resourceUuid` parameter
- Webhook endpoint must use `fastify.addContentTypeParser('application/json', { parseAs: 'buffer' })` to get raw body for signature verification
- Donation record created ONLY in `payment_intent.succeeded` webhook — never on intent creation
- Use the `PaymentGateway` interface — never call `stripe.*` directly from route handlers
- `stripe_customer_id` lives on `pledges`, not `constituents` (a constituent may have different payment methods per pledge)
- Receipt generation is a BullMQ job — never synchronous in the webhook handler

### For QA Engineer
- Test: webhook with invalid signature → 400 before any DB write
- Test: duplicate `stripeEventId` is processed exactly once (idempotency)
- Test: `payment_intent.payment_failed` → installment retry scheduled, no donation created
- Test: refund on a donation in a closed GL batch → 409
- Test: SEPA DD flow blocked when `ff.payments.sepa_direct_debit` is off
- Use Stripe CLI (`stripe listen --forward-to localhost:3000/v1/donations/stripe-webhook`) for local testing
- Never put real card numbers in test fixtures — use Stripe test card numbers only (`4242 4242 4242 4242`)

### For Security Architect
- `STRIPE_WEBHOOK_SECRET` and `STRIPE_SECRET_KEY` in environment variables only — never in DB
- Use Stripe **restricted keys** with minimum permissions (not the full secret key)
- Confirm SAQ A scope is maintained — any card-data-adjacent code path triggers PCI review
- `webhook_events.payload` stores processed event object — never the raw HTTP body

### For Data Architect
- Add `webhook_events` table to Drizzle schema in `packages/shared/src/schema/`
- `donations.payment_gateway` should be a DB-level check constraint or Drizzle enum: `stripe | mollie | manual`
- Add `stripe_customer_id`, `stripe_account_id`, `payment_gateway` columns to `pledges` Drizzle schema
- Financial records (`donations`, `receipts`, `pledge_installments`) are exempt from GDPR erasure — document in doc-06 and the erasure flow in doc-03

### For Log Analyst
- Add to Pino redact paths: `body.iban`, `body.cardNumber`, `body.pan`, `body.cvv`, `body.cvc`, `body.card`, `body.bankAccount`
- Payment events logged at `info`: `{ correlationId, tenantId, paymentIntentId, amount, currency, gateway }`
- `payment.failed` events at `warn` with `{ tenantId, pledgeId, installmentId, attempt, errorCode }`
- Add payment audit events to doc-17 catalog: `payment.succeeded`, `payment.failed`, `payment.refunded`, `mandate.created`, `mandate.revoked`

### For Feature Flag Engineer
- `ff.payments.sepa_direct_debit` — gates all SEPA DD routes and the installment processor
- `ff.payments.mollie` — gates Mollie gateway activation for a tenant (Phase 1 for FR/BE/NL)
- `ff.integrations.xero` — payment data feeds into GL export; check Xero flag in reconciliation job
- No flag needed for basic Stripe card payments — P0 MVP functionality

## 9. ADR-010 Addendum — Stripe GDPR Assessment

> **Note:** The full addendum has been moved to [ADR-010 Addendum](../adrs/adr-010-payment-provider-selection.md#adr-010-addendum--stripe-gdpr-assessment).

