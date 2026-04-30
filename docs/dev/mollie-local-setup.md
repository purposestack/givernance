# Mollie — Local Development Setup

This guide walks through wiring Mollie into your local Givernance dev environment, end-to-end, so you can run a full donor-pays-NPO flow against the real Mollie API **in test mode** (no money moves, no NPO verification needed).

The first time you do this you'll spend about 15 minutes. After that, the only step that needs to be running between sessions is the public tunnel that fronts your local API for Mollie's webhook to reach.

> **Audience.** Engineers running the stack via `pnpm dev` + Docker Compose, who already have Stripe local dev set up (see [stripe-local-setup.md](stripe-local-setup.md)). The two providers coexist — you don't need to tear down Stripe to add Mollie.
>
> **Why two payment providers.** ADR-010 (`docs/20-payment-strategy.md` §4) selects Stripe Connect as the primary gateway and Mollie as **co-primary for FR/BE/NL** because Mollie's NPO program offers simpler verification + native EU residency. The architecture is per-tenant: each org chooses one provider in Settings → Payment gateway. This doc gets you to the point where you can test the Mollie path locally with the same dev DB you use for Stripe testing.

---

## Prerequisites

- Repo cloned and `pnpm install` run.
- Docker Compose stack up (`./scripts/dev-up.sh`).
- API + worker + web running (`pnpm dev`).
- A way to expose `http://localhost:4000` to the public internet — Mollie's webhook is a real HTTP POST from Mollie's servers and **cannot reach `localhost`**. Recommended:
  - **Cloudflare Tunnel** (free, no signup-time-of-day limits): `brew install cloudflared`
  - **ngrok** as fallback: `brew install ngrok`

---

## Step 1 — Create a Mollie account (test mode only)

1. Go to https://my.mollie.com/dashboard/signup.
2. Sign up with your work email. Pick **non-profit** as the organisation type — that path stays in test mode without asking for the verification documents Mollie needs to enable live payments. (For real NPO onboarding, Mollie's NPO programme requires a few documents; it's still simpler than Stripe's KYB.)
3. Confirm your email; the dashboard loads in **test mode** by default. The toggle is the round badge in the top-right of every dashboard page — keep it on **Test mode** for everything in this guide. Test-mode payments never move money and never trigger payouts.
4. **No NPO verification is required for test mode.** You can run the full local donor flow today.

---

## Step 2 — Copy your Mollie test API key

1. Open **Developers → API keys** (https://my.mollie.com/dashboard/developers/api-keys).
2. You'll see two keys:
   - **Test API key** — starts with `test_…`. **This is the one you want.**
   - **Live API key** — starts with `live_…`. Don't touch this for local dev.
3. Click the **eye** icon next to the test key to reveal it, then copy.

> **One key per Mollie account, not per tenant.** Unlike Stripe Connect (where the platform creates a separate connected account per NPO), Mollie's Phase 1 model gives each NPO their own Mollie account and they paste their own test/live key into Givernance Settings. For local dev, you're playing both roles — your Mollie test key represents "the NPO's Mollie account" in Step 6.

---

## Step 3 — Mint the platform webhook signing secret

The `X-Mollie-Signature` HMAC verification on `POST /v1/donations/mollie-webhook` uses a **platform-level** signing secret (one per Givernance deployment), distinct from the per-tenant API key. Mollie generates this when you register a webhook endpoint.

For local dev, we don't register a permanent endpoint — we use the per-payment `webhookUrl` field that Mollie reads off each `payments.create` call. That field doesn't have its own signing secret yet (Mollie's "next-gen webhooks" signing is opt-in per endpoint), so for **local development we generate a synthetic secret** and configure Givernance to verify against it. The Mollie CLI (or a `curl` request that signs the body identically) can then drive the worker through the full webhook flow.

Generate a random 32-byte secret:

```sh
openssl rand -hex 32
# → 7f3a8b…  (copy this)
```

You'll paste it into `.env` in Step 5 and use it again in Step 7 when crafting test webhook requests.

> **Why synthetic in dev.** Mollie production tenants register the endpoint under **Developers → Webhooks → New endpoint** and Mollie issues a `whsec`-style secret bound to that endpoint. We deliberately avoid that for local dev because (a) the endpoint URL changes every tunnel restart and (b) Mollie webhooks can be replayed manually from the dashboard, so a synthetic secret + the same HMAC algorithm gives full coverage without dashboard juggling. See `docs/20-payment-strategy.md` §5.3 for the production registration flow.

---

## Step 4 — Start a public tunnel to your local API

Mollie's webhook is a server-to-server POST from Mollie's data centre. It must hit a publicly resolvable hostname.

**Option A — Cloudflare Tunnel (recommended):**

In a terminal you'll keep running for the rest of your session:

```sh
cloudflared tunnel --url http://localhost:4000
```

After 5–10 seconds, the output prints:

```
Your quick Tunnel has been created! Visit it at:
  https://random-words-here.trycloudflare.com
```

Copy that hostname. Your local API is now reachable at `https://random-words-here.trycloudflare.com/v1/donations/mollie-webhook`.

**Option B — ngrok:**

```sh
ngrok http 4000
```

Copy the `https://….ngrok-free.app` URL from the output.

> **Cloudflare Tunnel vs ngrok.** Cloudflare Tunnel issues a fresh hostname per session with no time limit and no account needed. ngrok's free tier is also fine but rate-limits more aggressively and requires sign-up after the first few minutes. Either works.

The tunnel terminal must stay open the whole time you're testing — closing it kills the URL and Mollie webhook delivery breaks.

---

## Step 5 — Wire Mollie into `.env`

Open the repo's root `.env` (copy from `.env.example` if it doesn't exist yet). Add a **Mollie** block:

```sh
# Platform-level webhook signing secret (Step 3). HMAC-SHA256 of the
# raw request body, hex-encoded, in the X-Mollie-Signature header.
MOLLIE_WEBHOOK_SECRET=7f3a8b…  # the openssl rand -hex 32 output

# Public hostname Mollie can reach. Used by the donate endpoint to set
# webhookUrl on every payments.create call. Leave APP_URL alone if you
# don't have any public-tunnel-aware code path beyond the donor flow.
APP_URL=https://random-words-here.trycloudflare.com  # the tunnel URL
```

> **`APP_URL` does double duty.** It's the canonical public URL for the API and is used for two things in the Mollie path: (1) it's the prefix for the donor `redirectUrl` (`${APP_URL}/p/<campaignId>`) — Mollie sends donors here after checkout, (2) it's the prefix for `webhookUrl` (`${APP_URL}/v1/donations/mollie-webhook`) — Mollie POSTs status changes here. The donor redirect would technically work even with `APP_URL=http://localhost:3000` because the donor's browser does the navigation, but the webhook MUST be a real public URL or every donation stays stuck in `open` status.

Restart `pnpm dev` so the API + worker pick up the new env. Both services read `.env` once at boot and don't watch it.

---

## Step 6 — Onboard your tenant via the Settings UI

The org-admin Settings page now has a **Payment gateway** panel that lets you switch between Stripe / Mollie / Manual.

1. Sign in to `http://localhost:3000` as an org admin (use the seeded admin from `pnpm db:seed:local` — see `scripts/dev-up.sh`).
2. Navigate to **Settings → Payment gateway**.
3. The Mollie option is **disabled by default**. To enable it for your test tenant, you need to flip the `ff.payments.mollie` feature flag on the tenant row. There's no admin UI for the flag yet (doc-18 will add one) — do it directly in Postgres:
    ```sh
    docker compose exec postgres psql -U givernance -d givernance -c \
      "UPDATE tenants SET feature_flags = '{\"ff.payments.mollie\": true}'::jsonb WHERE slug = 'givernance';"
    ```
    (Replace `'givernance'` with whatever slug your seeded admin tenant uses.)
4. Refresh the Settings page. The **Mollie** option in the dropdown is now selectable.
5. Pick **Mollie**, paste your `test_…` API key from Step 2 into the **Mollie API key** field, and click **Save changes**.
6. The panel re-fetches state and shows **Active: Mollie** + a **Mollie key configured** badge. The tenant's `payment_gateway` column is now `'mollie'` and `mollie_api_key` holds the test key.

The API key is stored as plaintext VARCHAR for the FR/BE/NL pilot — KMS encryption is a Phase 2 follow-up (issue #223). The Settings response NEVER echoes the stored key back; only a `mollieConfigured` boolean. The Pino redact paths cover the request body so the key can't leak into Loki on a 4xx/5xx.

> **No NPO-side onboarding form.** This is the biggest UX difference from Stripe Connect: Mollie tenants paste a key they got from their own Mollie dashboard, end of story. No hosted onboarding flow, no `accounts.create` round-trip, no `account.updated` webhook to wait for. The trade-off is that Mollie tenants must already have a Mollie account; Stripe tenants get created on the fly during onboarding.

---

## Step 7 — Test a real donation from the public campaign page

1. Make sure you have a published campaign with a public page. If not, in the app: **Campaigns → New**, then on the campaign detail page open **Public page**, fill the title/description, set status to **Published**.
2. Open the public URL: `http://localhost:3000/p/<campaign-id>` (the campaign page exposes a copy-link button).
3. Fill the donor details: name, email, amount (`50` is fine), currency (EUR).
4. Click **Continue to payment**. The browser navigates AWAY from Givernance to a Mollie-hosted checkout URL like `https://www.mollie.com/checkout/test/2-tr_xxx…`.
5. Mollie's test-mode checkout doesn't ask for real card / IBAN data. You see a **status picker**:
    - **Paid** — simulates a successful donation
    - **Failed** — simulates a card decline / IBAN reject
    - **Canceled** — simulates donor abandoning at the bank
    - **Expired** — simulates a SEPA / iDEAL session timing out
    - (and a few more — see https://docs.mollie.com/overview/testing)
6. Pick **Paid**.
7. Mollie redirects the donor back to `${APP_URL}/p/<campaign-id>` (the URL set on `redirectUrl`). The donor sees the campaign page render normally — no in-page confirmation yet (that's a polish follow-up; the donation is already credited server-side).

While this is happening, watch your terminals:

- **Cloudflare Tunnel terminal** prints `POST /v1/donations/mollie-webhook → 200`
- **API terminal** prints `Mollie webhook event queued` with `molliePaymentId: tr_…`
- **Worker terminal** prints `Donation created from Mollie payment.paid` with the donation ID

Switch back to the app:

- In **Donations** (admin), the new gift appears with `payment_method: ideal` (or `bancontact`, `creditcard`, etc. — whatever Mollie picked for test mode), `payment_ref: tr_…`, and a constituent matched/created from the donor email.
- The campaign's `platform_fees_cents` is **not** incremented — Mollie has no Stripe-Connect-equivalent fee mechanism in Phase 1, so Mollie donations record `platform_fee_cents = 0` (see ADR-010 follow-up #224 for the planned monetisation path).

> **The webhook fires multiple times per payment.** Mollie sends a webhook on every status transition (`open → pending → paid` / `failed` / etc.). Givernance's worker fetches the payment via `payments.get` to learn the actual status; the `webhook_events` row gets re-keyed from `tr_xxx` to `tr_xxx-paid` so each transition is processed exactly once but a true retry on the same status is deduped. Look at the worker logs — you may see two `Mollie webhook event queued` entries for a single donation, which is normal.

---

## Test methods reference

Mollie test mode lets you pick the resulting status directly in the checkout UI — there are no "test card numbers" because the donor never enters card data on the Mollie test page. The status picker covers:

| Picker option | Worker outcome |
| --- | --- |
| **Paid** | `donations` row inserted, `donation.created` outbox event |
| **Pending** | No row yet — wait for the next webhook to fire `paid` or `failed` |
| **Authorized** | No row yet — `authorized` is a pre-capture hold for "pay later" methods like Klarna; we wait for the capture flow's own `paid` webhook |
| **Failed** | No row inserted, status logged |
| **Canceled** / **Expired** | No row inserted, status logged |

For automated testing (`packages/worker/src/tests/integration/mollie-webhook.test.ts`), the Mollie SDK is mocked at the module boundary so we can synthesise any of these without hitting Mollie. See that file for the test pattern.

Full list of Mollie test scenarios: https://docs.mollie.com/overview/testing.

---

## Troubleshooting

**Settings → Payment gateway shows Mollie greyed out**
The `ff.payments.mollie` flag isn't set on the tenant. Run the `UPDATE tenants SET feature_flags = …` query from Step 6, then hard-refresh the Settings page (the panel reads the flag from the API on every load).

**`POST /v1/admin/payment-gateway → 400 Mollie API key is required when switching gateway to mollie`**
You picked **Mollie** in the dropdown but the **Mollie API key** field was empty. The API refuses to enable the gateway without a key (we don't want a tenant whose `payment_gateway = 'mollie'` but no key — the donor flow would 502). Paste a `test_…` key.

**`POST /v1/donations/mollie-webhook → 400 Signature verification failed`**
Either `MOLLIE_WEBHOOK_SECRET` doesn't match the secret you signed the test request with, or you restarted `pnpm dev` without re-reading `.env`. The signing algorithm is HMAC-SHA256 over the raw form-encoded body, hex-encoded, in the `X-Mollie-Signature` header (with optional `sha256=` prefix). To craft a manual test:
```sh
SECRET=$(grep MOLLIE_WEBHOOK_SECRET .env | cut -d= -f2)
BODY="id=tr_test_manual_$$"
SIG=$(echo -n "$BODY" | openssl dgst -sha256 -hmac "$SECRET" | awk '{print $2}')
curl -X POST https://your-tunnel.trycloudflare.com/v1/donations/mollie-webhook \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -H "X-Mollie-Signature: $SIG" \
  -d "$BODY"
```

**Webhook arrives but donation never appears**
Check the worker terminal for `No Mollie tenant claimed this payment — skipping`. This means `processMollieWebhook` iterated every Mollie-enabled tenant's API key calling `payments.get(<id>)` and got 404 from all of them. Cause: the test payment id you sent isn't owned by the API key in `tenants.mollie_api_key`. If you crafted the request manually with a synthetic id, this is expected — only payments Mollie actually issued under your test key will resolve.

**Donor redirected back to the app but the page doesn't show the donation immediately**
Eventual consistency. The webhook fires asynchronously after the donor's redirect; depending on tunnel latency this can lag the redirect by 1–2 seconds. Refresh and the donation appears under **Donations**. If it doesn't appear after 10s, check the worker logs.

**`Cannot connect to Mollie API` errors in the worker**
The per-tenant `mollie_api_key` is wrong or expired. Mollie test keys don't expire on a fixed schedule but they do get invalidated if you regenerate them in the dashboard. Re-paste a fresh key in Settings.

**Tunnel URL changed and `APP_URL` is stale**
Cloudflare Tunnel issues a fresh URL on every restart. After restarting the tunnel, update `APP_URL` in `.env` and `pnpm dev` to pick up the new URL — otherwise existing payments use a stale `webhookUrl` and Mollie's delivery retries land on a defunct hostname. (For longer sessions, register a named Cloudflare Tunnel — `cloudflared tunnel create givernance-dev` — which gives you a stable URL across restarts.)

---

## Differences from Stripe (fee model + marketplace)

If you're already familiar with the Stripe flow from `stripe-local-setup.md`, these are the differences that affect onboarding, fee collection, and operations.

### 1. Marketplace / "platform" model

| | Stripe Connect | Mollie (Phase 1) |
| --- | --- | --- |
| Givernance's role | **Platform** in Stripe's marketplace model. Owns a single Stripe platform account; each NPO is a **connected account** (`acct_…`) created on-demand via Express onboarding. | **Not a marketplace operator.** Givernance is just a relay: it stores the NPO's own Mollie API key and uses it server-side. The NPO has their own Mollie account, signed up directly with Mollie. |
| NPO onboarding | Hosted Express form on `connect.stripe.com`. Givernance's API calls `accounts.create` + `accountLinks.create`; the NPO never logs into Stripe directly — KYB is collected by Stripe and verified out-of-band. | NPO signs up at `my.mollie.com`, completes Mollie's NPO verification (separately from Givernance), copies their `live_…` API key, pastes it into Givernance Settings → Payment gateway. |
| Identity proof | Stripe's KYB (typically 2–5 business days for live mode). Test mode is instant. | Mollie's NPO programme (faster than Stripe per ADR-010, but still a few days). Test keys work immediately without verification. |
| Single source of truth for "is this account chargeable?" | `account.updated` webhook → `tenants.stripe_charges_enabled` cached in our DB (PR #222). | The presence of a `live_…` key in `tenants.mollie_api_key` IS the readiness signal — there's no equivalent webhook because Givernance isn't the operator of the Mollie account. |

**Operational implication.** Stripe lets us ship a single signup flow that takes a tenant from "no payments" to "donor can donate" without leaving the Givernance UI. Mollie's Phase 1 flow is a two-step ritual: NPO signs up with Mollie themselves, then comes back to Givernance to paste a key. Filed as follow-up #224 — Mollie Connect / OAuth would close that gap.

### 2. Platform fee collection (this is the most important difference)

| | Stripe Connect | Mollie (Phase 1) |
| --- | --- | --- |
| How Givernance gets paid | `application_fee_amount` on every PaymentIntent → Stripe automatically routes that fraction to the platform balance, the rest to the NPO's connected account balance, in **a single charge**. | **No equivalent mechanism.** Mollie has no platform-fee facility for non-Connect accounts. 100% of the donation lands on the NPO's Mollie balance. |
| Today's behaviour in code | `packages/api/src/lib/payments/stripe-gateway.ts` passes `application_fee_amount: applicationFeeAmountCents` (1.5% + 30¢, computed in `packages/api/src/modules/public/service.ts:calculatePlatformFee`). The `payment_intent.succeeded` worker logs that fee on `donations.platform_fee_cents` and accumulates it on `campaigns.platform_fees_cents`. | `packages/worker/src/processors/mollie-webhook.ts:handleMolliePaid` hardcodes `platformFeeCents = 0` and skips the campaign accumulator update entirely. The `application_fee_cents` field IS still written to Mollie metadata for audit traceability but the worker doesn't read it — Mollie doesn't actually deduct anything. |
| Refund handling | `refunds.create` with `refund_application_fee: true` returns the application fee to the NPO's balance alongside the donor refund — the platform's books reverse cleanly. | The refund route currently bypasses Mollie entirely (it's still Stripe-only — see follow-up #225). Once gateway-aware, Mollie refunds simply move the full donation amount back from the NPO's Mollie balance — there's no platform-fee reversal because there was no platform fee to begin with. |
| Cash-flow timing | Stripe pays out the NPO's balance on its rolling Stripe schedule (default daily, T+2 to T+7 in EU); the platform fee shows up in Givernance's Stripe balance immediately. | Mollie pays out the NPO's full donation balance on its own schedule. Givernance receives nothing automatically — we'd have to invoice the NPO for our SaaS subscription separately. |

**Operational implication.** Today, Stripe-tenant donations finance Givernance's platform automatically. Mollie-tenant donations don't — we currently rely on Mollie tenants paying their Givernance subscription out-of-band. **Don't roll Mollie out to a tenant who isn't on a paid Givernance plan**, otherwise we're processing donations for them at zero revenue.

The two paths to fix this in Phase 2:

1. **Mollie Connect (preferred)** — same model as Stripe Connect, where Mollie is aware of Givernance as a platform and supports a payout split. Filed as follow-up #224.
2. **Stripe-billed platform fee** — keep Mollie for the donor checkout, but bill the NPO a periodic Givernance subscription fee via Stripe Billing. Decoupled from per-donation flow but adds a moving part. Discussed in `docs/20-payment-strategy.md` §10 future work.

### 3. Webhook contract

| | Stripe | Mollie |
| --- | --- | --- |
| Body | Signed JSON envelope (`event.data.object` is the resource). | Form-encoded `id=tr_…` only — you fetch the payment via the API to learn the actual status. |
| Signature | `Stripe-Signature: t=<unix>,v1=<hex>` plus an optional secondary `v0=` value — verified by `stripe.webhooks.constructEvent`, which handles both signing methods + a 5-minute replay window. | `X-Mollie-Signature: <hex>` (or `sha256=<hex>` with optional prefix) — HMAC-SHA256 of the raw body, no timestamp / replay window. We re-implement verification in `packages/api/src/lib/payments/mollie-gateway.ts` using Node's `crypto.createHmac` because the `@mollie/api-client@4.x` SDK doesn't ship with a verifier helper. |
| Replay protection | Stripe's signature includes a timestamp; the SDK rejects events older than 5 minutes by default. | None — Mollie's signature is content-only. Replay attacks are mitigated by the `(provider, provider_event_id)` unique index on `webhook_events`: a duplicate webhook for the same status transition is rejected at insert time. |
| Local development tooling | `stripe listen` forwards live events to localhost + issues a per-session signing secret. | No CLI equivalent. You need a public tunnel (Cloudflare Tunnel / ngrok) and a synthetic `MOLLIE_WEBHOOK_SECRET` you sign requests with manually. |
| Unique event id | `evt_…` per webhook — Stripe never sends the same `evt_id` twice. | None. Mollie sends the resource id (`tr_…`) which can repeat across status transitions (open → pending → paid, all carry the same `tr_…`). The worker re-keys the `webhook_events` row to `${id}-${status}` to give each transition its own row. |
| Cross-account events | Stripe lets the platform subscribe to events on connected accounts via the **"Listen to events on Connected accounts"** toggle on the dashboard webhook endpoint. Without this toggle, donations on connected accounts fire events to *the connected account's* own webhooks, not the platform's. | N/A — there's no platform/connected-account distinction in Mollie's Phase 1 model, so all events are direct. |

### 4. Donor UX

| | Stripe | Mollie |
| --- | --- | --- |
| Where the donor enters payment data | In-page **Stripe Payment Element** iframe — the donor never leaves Givernance. PCI SAQ A scope (no card data on our servers). | Mollie-hosted checkout page — the donor is redirected away from Givernance to `https://www.mollie.com/checkout/…` and back. The donor experience is two more clicks but Givernance never sees card / IBAN data. |
| Payment methods supported | Cards, SEPA Direct Debit, Apple Pay, Google Pay, Stripe Link (one-click), iDEAL/Bancontact/EPS via Payment Element. | iDEAL, Bancontact, SOFORT, KBC, Belfius, ING Home'Pay, cards, SEPA Direct Debit, Apple Pay, Klarna, PayPal — Mollie's NL/BE coverage is the strongest argument for offering it. |
| Granular payment-method tracking | We store `payment_method = 'stripe'` on every donation. Stripe-side data identifies the actual method but we don't denormalise it. | We store `payment_method = 'ideal' | 'bancontact' | 'creditcard' | 'sepadirectdebit' | …` from `payment.method` on the Mollie Payment object. Belgian/Dutch reporting cares about this distinction; SEPA DD reconciliation queries key on `'sepadirectdebit'`. |
| Test-mode flow | Stripe Payment Element accepts `4242 4242 4242 4242` → success, `4000 0025 0000 3155` → 3DS challenge, `4000 0000 0000 0002` → declined. | Mollie's test checkout shows a status picker (Paid / Failed / Canceled / Expired / Authorized). No card numbers needed. |

### 5. Refunds (current state)

The refund route at `POST /v1/donations/:id/refund` is **Stripe-only today** and bypasses the gateway abstraction (see `packages/api/src/modules/donations/routes.ts:refundDonation`). Trying to refund a Mollie donation through that endpoint returns `kind: "not_stripe"`. Filed as follow-up #225 — gateway-aware refunds need: (a) a `refund` method on the `PaymentGateway` interface (already in ADR-010 §5.1, just unimplemented), (b) Mollie-side refund handling via `client.payment_refunds.create`, and (c) a Mollie webhook handler for `refund.paid` to mirror the donation status flip we already do for `charge.refunded` on Stripe.

---

## What's not covered yet

- **Mollie Connect / OAuth flow** — the platform-fee mechanism and the smoother NPO onboarding flow are both unlocked by this. Tracked in [issue #224](https://github.com/purposestack/givernance/issues/224).
- **Mollie API key encryption at rest** — plaintext today; KMS / pgcrypto follow-up in [issue #223](https://github.com/purposestack/givernance/issues/223).
- **Gateway-aware refund flow** — Stripe-only today; Mollie refund support tracked in [issue #225](https://github.com/purposestack/givernance/issues/225).
- **Production webhook endpoint registration** — the `MOLLIE_WEBHOOK_SECRET` flow described above is local-dev-shaped (synthetic secret + manual sign). Production registers a real endpoint via **Developers → Webhooks** and binds the secret to that endpoint URL. Documented separately when the staging deployment story for Mollie lands.
- **Staging deployment** — once the Mollie pilot moves to staging, this guide's "Staging deployment" section (mirroring the Stripe section in `stripe-local-setup.md`) gets written.

If you hit a snag this guide doesn't cover, file an issue with the `payments` label and link the failing log line.
