## ADR-010 — Payment Provider Selection

**Status**: Proposed
**Date**: 2026-04-02
**Deciders**: Engineering team
**Supersedes**: —

### Decision

**Primary: Stripe Connect** for all deployments from Phase 1.
**Deferred: Mollie.** Originally planned as a co-primary for FR/BE/NL NPOs to simplify NPO verification, Mollie integration has been put on hold indefinitely. The project focuses exclusively on Stripe Connect to minimize operational complexity for Phase 1. Mollie may be reconsidered in the future, but its use is currently uncertain.

### Rationale

**Stripe Connect chosen because:**

1. **Platform commission model**: `application_fee_amount` on each charge enables Givernance to collect its platform fee without handling e-money flows — no e-money licence required
2. **Multi-tenant isolation**: each NPO is a Stripe connected account — full financial isolation, own statement, own Stripe dashboard
3. **SEPA DD + recurring**: both are first-class API resources with full webhook lifecycle
4. **Developer experience**: best-in-class Node.js SDK, TypeScript types, Stripe CLI for local webhook testing
5. **Ecosystem**: Gift Aid claims work on top of Stripe payments; iDEAL/Bancontact/EPS available via single Payment Element

**Why Mollie was initially considered:**
1. **Simplified NPO verification** — Mollie's NPO program offered faster onboarding for French, Belgian, and Dutch associations than Stripe's standard KYB. However, to avoid maintaining two distinct payment gateway integrations, Stripe is the sole provider for Phase 1.
2. NPO-specific pricing makes it more cost-effective for small FR/BE/NL NPOs
3. iDEAL/Bancontact are dominant payment methods in NL/BE
4. EU-native (no SCC needed) is a selling point for privacy-conscious NPOs
5. Abstract enough to add without changing donation core logic

**Mangopay rejected for Phase 1**: requires wallet-based architecture and is overkill for the Phase 1 donation model. Revisit at Phase 3+ if umbrella/pooling use cases emerge.

**Saferpay rejected for primary**: no native recurring billing API, no Connect equivalent. Add as Phase 3+ option for `.ch` tenants (TWINT support).

### Consequences

- `donations.payment_gateway` enum: `stripe | manual` (Mollie removed for now)
- `pledges` table carries both `stripe_customer_id` and `stripe_mandate_id` (Mollie equivalent fields added when Mollie feature ships)
- All payment flows are abstracted behind a `PaymentGateway` interface in `packages/shared` — concrete implementations are `StripeGateway` and `MollieGateway`
- Givernance never stores card numbers, CVV, or IBAN — SAQ A scope maintained


## ADR-010 Addendum — Stripe GDPR Assessment

> **Date**: 2026-04-02
> **Raised by**: Payment Engineer agent review
> **Status**: Accepted — no change to provider decision, action items recorded

### Context

Givernance markets itself as *GDPR-native, EU-first*. ADR-010 selects Stripe Connect (a US company) as primary. This addendum documents the GDPR nuance and the mitigations.

### Stripe's GDPR posture

| Attribute | Detail |
|---|---|
| EU legal entity | Stripe Payments Europe Ltd — Dublin, Ireland |
| Data location | AWS eu-west-1 (Ireland) |
| Transfer mechanism | **Standard Contractual Clauses (SCC)** — legally valid post-Schrems II, widely accepted by EU DPAs |
| US jurisdiction risk | Stripe Inc. (US parent) subject to FISA / CLOUD Act — can be compelled to provide EU data to US authorities |
| Mitigation | SCC + Stripe's DPA — standard industry practice, used by thousands of EU companies |

### Why the risk is limited for Givernance

Givernance targets **PCI DSS SAQ A** — no card data, IBAN, or beneficiary PII ever touches Givernance servers. The only data Stripe holds for Givernance:

- Tokenised payment method references (opaque)
- Transaction amounts + timestamps
- Stripe Customer IDs (opaque)

No health data, no case notes, no social/medical information ever reaches Stripe. SCCs for opaque payment transaction refs are far less contentious than SCCs for Art. 9 special-category data. The practical GDPR risk is **low**.

### Decision

**Keep Stripe Connect as primary.** The platform model (Connect), `application_fee_amount` commission, and developer experience advantages outweigh the SCC concern for payment-only data of this scope.

### Mandatory mitigations

| Action | Owner | When |
|--------|-------|------|
| Privacy policy: do not claim "100% EU" for payments — use *"EU-region payment processing via Stripe (SCC) or Mollie (native EU)"* | Legal / Product | Before launch |
| Include Stripe's DPA in the legal docs checklist alongside Scaleway's DPA | Legal | Before launch |
| Mollie positioned as first-class alternative (not just DACH fallback) for FR/BE/NL NPOs and any NPO with a strict DPO | Product | ADR-010 update |
| Document DPO opt-out path: NPOs in public sector or health-adjacent contexts can request Mollie gateway at onboarding — no SCC, full EU | Engineering | Phase 1 onboarding flow |

### Mollie Deprioritization

Mollie has been removed from the immediate roadmap to reduce integration complexity. All tenants, regardless of region, will use Stripe (with SCCs for GDPR compliance) for Phase 1. |
| Switzerland | Stripe Phase 1 → Saferpay/TWINT Phase 3 |
| All others | Stripe (default) |

This is reflected in the `payment_gateway` tenant setting at onboarding — guided choice, not arbitrary.


## 10. Open Questions

- [ ] **Stripe Connect account type**: `express` vs `standard` vs `custom`? Proposal: `express` for Phase 1 (Stripe hosts KYC/dashboard); `standard` for larger NPOs who want full Stripe dashboard access.
- [x] **Onboarding speed — KYB delay**: KYB takes 2-5 business days. **Resolved**: NPOs start in Stripe test mode immediately (see §5.2). Full flow validation in < 1 hour; auto-switch to live when `charges_enabled: true`. No KYB wait for first experience.
- [ ] **Platform fee model**: flat `application_fee_amount` per transaction, or percentage? Proposal: percentage (e.g. 0.5%) — aligns with doc-08 commission model discussion.
- [ ] **Stripe vs Mollie for first NPO**: should the first pilot NPO be on Stripe or Mollie? Proposal: depends on country — FR/BE/NL default to Mollie; UK/multi-currency default to Stripe (see §9 GDPR assessment).
- [ ] **Dispute/chargeback handling**: when a charge is disputed, Stripe freezes funds. What is the NPO notification and resolution flow? Needs a runbook.
- [ ] **UK Gift Aid claim submission**: HMRC claim is application-level (Givernance generates the XML). Is this Phase 1 or Phase 2? Doc-04 lists it — clarify in roadmap.
- [ ] **Mangopay revisit trigger**: define the specific use case (umbrella orgs? pooled donations?) that would trigger Mangopay evaluation for Phase 3+.
- [ ] **Saferpay / TWINT**: is there a Phase 3 Swiss-market plan? If yes, define the tenant configuration flag.

### From ADR-010 §9 GDPR addendum — mandatory action items

- [ ] **Privacy policy wording** — do not claim "100% EU data" for payments. Required wording: *"Payment processing via Stripe (EU-region, SCC) or optionally Mollie (native EU)"*. Owner: Legal/Product. Deadline: before public launch.
- [ ] **Mollie positioning** — make Mollie the default gateway for FR/BE/NL tenants (native-EU is a sales differentiator, NPO pricing). Update onboarding flow to route by tenant country. Owner: Engineering. Phase: 1 onboarding.
- [ ] **DPO opt-out path** — document and implement that NPOs with strict DPOs (public sector, health-adjacent) can request Mollie at onboarding — no SCC, full EU. Add to tenant onboarding form as a gateway selection with guidance text. Owner: Engineering. Phase: 1.
- [ ] **Stripe DPA review** — include Stripe's Data Processing Agreement in the legal docs checklist alongside Scaleway's DPA. Currently only Scaleway is referenced in `CLAUDE.md` tech stack. Owner: Legal. Deadline: before processing first live payment.

## 11. Implementation Phases

### Phase 1 (Core payment — Stripe Connect + Mollie for FR/BE/NL)

- [ ] `PaymentGateway` interface in `packages/shared/src/lib/payments/`
- [ ] `StripeGateway` implementation
- [ ] `MollieGateway` implementation (FR/BE/NL tenants) — **deferred to Sprint 4 (Issue #62)**
- [ ] `ff.payments.mollie` feature flag — **deferred to Sprint 4 (Issue #62)**
- [ ] Tenant payment gateway selection at onboarding (country-based routing) — **deferred to Sprint 4 (Issue #62)**
- [ ] `webhook_events` Drizzle schema + unique index
- [ ] Stripe Connect onboarding flow (`POST /admin/tenants/:id/stripe-connect`) with test mode support
- [ ] Mollie webhook endpoint + handler — **deferred to Sprint 4 (Issue #62)**
- [ ] Webhook endpoint with signature verification + idempotency
- [ ] BullMQ webhook processor
- [ ] One-off donation payment intent + `payment_intent.succeeded` handler
- [ ] Receipt generation BullMQ job
- [ ] Refund flow with GL batch check
- [ ] Platform fee configuration per tenant (`application_fee_amount`)
- [ ] Integration tests (see QA cross-agent rules)

### Phase 2 (SEPA Direct Debit + expansion)

- [ ] SEPA mandate setup (`POST /v1/pledges/:id/setup-mandate`) — gated behind `ff.payments.sepa_direct_debit`
- [ ] `process_pledge_installments` BullMQ repeatable job (SEPA DD recurring charges)
- [ ] SEPA DD webhook handling (`setup_intent.succeeded`, mandate lifecycle)
- [ ] Mollie expansion to additional markets beyond FR/BE/NL

### Phase 3+ (Saferpay / TWINT / Mangopay evaluation)

- [ ] `.ch` tenant detection + Saferpay gateway
- [ ] TWINT payment method integration
- [ ] Mangopay evaluation for umbrella/pooled donation use cases

