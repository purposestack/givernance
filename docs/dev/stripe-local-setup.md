# Stripe — Local Development Setup

This guide walks through wiring Stripe Connect into your local Givernance dev environment, end-to-end, so you can run a full donor-pays-NPO flow against real Stripe APIs **in test mode** (no money moves, no business verification needed).

The first time you do this you'll spend about 15 minutes. After that, the only step that needs to be running is `stripe listen`.

> **Audience.** Engineers running the stack via `pnpm dev` + Docker Compose. If you're deploying to a real environment, see [docs/20-payment-strategy.md](../20-payment-strategy.md) — production keys, key rotation, and Stripe restricted-key scoping live there.

---

## Prerequisites

- Repo cloned and `pnpm install` run.
- Docker Compose stack up (`./scripts/dev-up.sh`).
- API + worker + web running (`pnpm dev`).
- Homebrew on macOS (for the Stripe CLI install). Linux users can use the Stripe CLI install instructions at https://docs.stripe.com/stripe-cli.

---

## Step 1 — Create a Stripe account (test mode only)

1. Go to https://dashboard.stripe.com/register.
2. Sign up with email + password. **No business or tax info is required for test mode.**
3. When the dashboard loads, confirm there's a **TEST MODE** badge in the top-left toggle. Stay in test mode for the entire setup — no funds will move and no payouts are scheduled.

Test mode is fully isolated from live mode. You can switch at any time, but for local dev you never need live mode.

---

## Step 2 — Enable Stripe Connect on the platform account

Givernance acts as a Stripe Connect platform: each NPO connects their own Stripe account to receive donations directly. The platform account itself never holds donor funds.

1. Open https://dashboard.stripe.com/test/settings/connect.
2. Click **Get started**.
3. Fill the platform profile:
    - **Platform name** — anything (e.g. `Givernance dev`).
    - **Business type** — pick whatever; not verified in test mode.
    - **Connected account type** — pick **Express**. The codebase (`packages/api/src/modules/payments/service.ts:startStripeOnboarding`) creates accounts with `type: "express"`, so this must match.
4. Submit. The platform is now Connect-enabled.

---

## Step 3 — Copy your test API keys

1. Open https://dashboard.stripe.com/test/apikeys.
2. You'll see two keys at the top — **Publishable key** (`pk_test_…`) and **Secret key** (`sk_test_…`). Copy both.

> **Restricted keys vs secret keys.** In production, use a Stripe restricted key with only the scopes Givernance needs (PaymentIntents, Connect accounts, Webhook endpoints). For local dev the full secret key is fine.

---

## Step 4 — Install the Stripe CLI

The CLI does two things you need: it forwards Stripe webhooks to your local API, and it gives you a webhook signing secret bound to that forwarder session.

```sh
brew install stripe/stripe-cli/stripe
```

Verify:

```sh
stripe --version
```

---

## Step 5 — Wire Stripe into `.env`

Open the repo's root `.env` (copy from `.env.example` if it doesn't exist yet). Set three variables in the **Stripe Connect** block:

```sh
# server-side: API → Stripe (Connect onboarding, PaymentIntents)
STRIPE_SECRET_KEY=sk_test_…  # from step 3

# server-side: Stripe-Signature verification (filled in step 6)
STRIPE_WEBHOOK_SECRET=

# browser-side: Stripe.js Payment Element on the public donation page
NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY=pk_test_…  # from step 3
```

**Don't restart the dev server yet** — `STRIPE_WEBHOOK_SECRET` comes from the next step.

---

## Step 6 — Start the webhook forwarder

In a separate terminal that you'll keep running for the rest of your session:

```sh
stripe login
# ↑ first time only — opens a browser, authenticates the CLI to your account.

stripe listen \
  --forward-to http://localhost:4000/v1/donations/stripe-webhook \
  --events payment_intent.succeeded,charge.refunded,account.updated
```

The first line of output looks like:

```
Ready! Your webhook signing secret is whsec_… (^C to quit)
```

> **This `whsec_…` is unique to the CLI session, not the dashboard.** Don't try to find it in the Stripe dashboard's "Webhook signing secret" UI — that one is for production webhooks and won't validate signatures from `stripe listen`.

Copy the `whsec_…` value into `STRIPE_WEBHOOK_SECRET` in `.env`.

The `--events` filter mirrors what the API actually handles today: `payment_intent.succeeded` (donation creation), `charge.refunded` (refund flow — issue #199), and `account.updated` (Connect lifecycle — drives the auto-promote-to-live work in [issue #62](https://github.com/purposestack/givernance/issues/62)). Without `charge.refunded`, the local refund flow ships donor-card refunds through Stripe but the local DB never reflects the new status — handy if you're testing the API path in isolation, otherwise leave all three on.

---

## Step 7 — Restart the dev server

```sh
# In the terminal running `pnpm dev`, Ctrl+C, then:
pnpm dev
```

Both the API and worker reload `.env` on boot — they don't watch it. The web app picks up `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY` from the same `.env` because of the `dotenv -e ../../.env` prefix in `packages/web/package.json`.

---

## Step 8 — Onboard your tenant via the Settings UI

The org-admin settings page now has a **Stripe Connect** panel that wraps the API onboarding endpoints.

1. Sign in to `http://localhost:3000` as an org admin (use the seeded admin from `pnpm db:seed:local` — see `scripts/dev-up.sh`).
2. Navigate to **Settings**. Scroll to the **Stripe Connect** section.
3. Click **Connect Stripe**. The page redirects to Stripe's hosted Express onboarding form.
4. Fill it in with **test data** — Stripe pre-fills these for you:
    - Phone number: `000-000-0000`
    - SSN: `000-00-0000` (US) / national ID: any test value (EU)
    - Routing number: `110000000`
    - Account number: `000123456789`
    - Date of birth: `01/01/1901`
    - Address: any
5. Submit. Stripe redirects you back to the Settings page.
6. The **Stripe Connect** panel re-fetches status and now shows a **Connected** badge with your `acct_…` ID. The tenant's `stripe_account_id` column is populated and the account has `charges_enabled: true`.

If onboarding doesn't fully complete (e.g. you abandoned the form), the panel shows **Onboarding incomplete** and the button label changes to **Continue onboarding** — clicking it generates a fresh account link.

> **Direct-charge model.** Givernance creates PaymentIntents on the connected account (see `packages/api/src/modules/public/service.ts:createDonationIntent`, line `requestOptions.stripeAccount`). This means the platform fee (1.5% + 30¢, defined in `calculatePlatformFee`) is collected via `application_fee_amount` and the rest goes directly to the NPO's Stripe balance. Givernance never holds donor funds.

---

## Step 9 — Test a real donation from the public campaign page

1. Make sure you have a published campaign with a public page. If not, in the app: **Campaigns → New**, then on the campaign detail page open **Public page**, fill the title/description, set status to **Published**.
2. Open the public URL: `http://localhost:3000/p/<campaign-id>` (the campaign page exposes a copy-link button).
3. Fill the donor details: name, email, amount (`50` is fine), currency.
4. Click **Continue to payment**. The form replaces itself with the Stripe **Payment Element**.
5. Use Stripe's test card:
    - Card number: `4242 4242 4242 4242`
    - Expiry: any future date (e.g. `12/34`)
    - CVC: any three digits
    - ZIP/postal code: any
6. Click **Donate €50**.

Watch your terminal:

- **`stripe listen` terminal** prints `--> payment_intent.succeeded [evt_…]`
- **API terminal** prints `Webhook event queued`
- **Worker terminal** prints `Donation created from Stripe payment_intent.succeeded` with the donation ID

Switch back to the app:

- The donor sees a **Thank you for your donation!** confirmation in-page.
- In **Donations** (admin), the new gift appears with constituent matched/created from the donor email.

---

## Test cards reference

| Scenario                         | Card                  |
| -------------------------------- | --------------------- |
| Successful payment               | `4242 4242 4242 4242` |
| Payment requires authentication  | `4000 0025 0000 3155` |
| Card declined (`generic_decline`) | `4000 0000 0000 0002` |
| Card declined (insufficient funds) | `4000 0000 0000 9995` |

Full list: https://docs.stripe.com/testing#cards.

---

## Troubleshooting

**`POST /v1/admin/stripe-connect → 502`**
The API can't reach Stripe. Check `STRIPE_SECRET_KEY` is set and the API has been restarted since you set it. The API logs the underlying error on the server side; the response intentionally masks it (we never leak Stripe error messages to authenticated callers either).

**`POST /v1/donations/stripe-webhook → 400 Signature verification failed`**
Either `STRIPE_WEBHOOK_SECRET` doesn't match what `stripe listen` is using, or the API hasn't been restarted since you set it. Stop `stripe listen`, re-run it, copy the *new* `whsec_…` (it changes each session), and restart the API.

**Public page says "Stripe is not configured for this environment."**
`NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY` is missing or empty. Set it in `.env` and restart `pnpm dev` — the web package only reads it at build time / dev-server boot, not at request time.

**Public page returns 502 on Continue to payment**
Likely `Organization has not completed Stripe onboarding` or `…account is not fully onboarded`. Go back to **Settings → Stripe Connect**, finish the Express form. The API rejects PaymentIntent creation until `charges_enabled: true` on the connected account.

**`stripe listen` keeps printing `connection refused`**
Your API isn't running on port 4000, or `--forward-to` doesn't match. Check `PORT` in `.env`.

**Webhook arrives but donation never appears**
Check the worker terminal — the BullMQ job processor logs `Failed to process Stripe webhook event` with the underlying reason. The most common cause is that `event.account` (the connected account ID on the event) doesn't match any tenant's `stripe_account_id` — which can happen if you triggered the event before completing onboarding.

---

## Staging deployment

Staging (`staging.givernance.org`) runs the same Stripe Connect code as local dev but reads its credentials from GitHub Actions secrets via Kamal (`config/deploy-staging.yml` + `.github/workflows/deploy-staging.yml`). Setting it up the first time is a 4-step ritual; afterwards the deploy workflow re-applies the config on every push to `main`.

### Step 1 — register secrets in the `staging` GitHub Environment

The deploy workflow declares `environment: staging` on the deploy job, which scopes every `secrets.X` lookup to the `staging` GitHub Environment first (falling back to repo-level secrets). That means staging and a future production environment can hold distinct values for the same logical key — no `STAGING_*` / `PROD_*` prefix dance — and approval gates / branch policies attach to the environment, toggleable in **Settings → Environments → staging** without touching workflow YAML.

If the `staging` environment doesn't exist yet, create it once: **GitHub repo → Settings → Environments → New environment → "staging"** (no protection rules — push-to-`main` should keep deploying without manual approval).

The deploy workflow has empty fallbacks for all of them so it doesn't crash on a fresh repo, but the donor flow will block at "Stripe is not configured" (publishable key missing) or 502 on `Continue to payment` (secret key missing) until you set them.

```sh
# Run from a machine with `gh` auth + repo admin access.
# `--env staging` scopes the secret to the staging environment so a
# future prod environment can hold a different value under the SAME name.

# 1. Stripe platform credentials. Use sk_test_… / pk_test_… for staging
#    (we never want real money to move on a staging environment).
gh secret set STRIPE_SECRET_KEY --env staging \
  --repo purposestack/givernance --body "sk_test_…"
gh secret set NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY --env staging \
  --repo purposestack/givernance --body "pk_test_…"

# 2. Webhook signing secret. This is the dashboard-issued endpoint
#    secret (NOT the `whsec_…` from `stripe listen`, which is a separate
#    local-dev-only value). Step 2 below describes how to mint this from
#    the Stripe dashboard.
gh secret set STRIPE_WEBHOOK_SECRET --env staging \
  --repo purposestack/givernance --body "whsec_…"

# 3. SeaweedFS SSE-S3 KEK passphrase for AES256 server-side encryption. Worker
#    DLQs every receipt PDF without this. Generate fresh (no length constraint —
#    SeaweedFS HKDF-derives the KEK; see ADR-034):
gh secret set SEAWEEDFS_SSE_KEY --env staging \
  --repo purposestack/givernance --body "$(openssl rand -hex 32)"

# 4. Optional — bucket name overrides. These aren't secrets; prefer
#    environment variables over secrets so they show in plaintext in the
#    Environments UI. Defaults to `receipts` / `campaigns` if unset.
# gh variable set S3_RECEIPTS_BUCKET --env staging --body "receipts"
# gh variable set S3_CAMPAIGNS_BUCKET --env staging --body "campaigns"
```

The IDE will lint these as "Context access might be invalid" until they're registered — soft warning, deploys succeed regardless. The fallbacks in the workflow are deliberate so deploys never fail on a missing secret; the user-facing surface (donor sees "Stripe is not configured" or 502 on Continue to payment) is what tells you something's misconfigured.

> **Existing un-prefixed secrets stay repo-level for now.** A handful of secrets pre-date the environment-scoping switch (`POSTGRES_PASSWORD`, `KEYCLOAK_ADMIN_PASSWORD`, `SESSION_SECRET`, `KEYCLOAK_ADMIN_CLIENT_SECRET`). (The object-store secrets were re-minted as `SEAWEEDFS_S3_SECRET_KEY` / `SEAWEEDFS_SSE_KEY` in the ADR-034 migration and are env-scoped from the start.) They still resolve via repo-level fallback, so the deploy keeps working. Migrating them to the staging environment is a separate hygiene task — atomic per secret: register the new value in the environment, redeploy to confirm, then unset the repo-level one. Don't piecemeal-rename alongside other work.

### Step 2 — register the staging Stripe webhook endpoint

In the Stripe dashboard (test mode):

1. Go to **Developers → Webhooks → Add endpoint**.
2. **URL**: `https://api.staging.givernance.org/v1/donations/stripe-webhook`
3. **Events to send**:
    - `payment_intent.succeeded`
    - `charge.refunded`
    - `account.updated` (subscribe even though Givernance ingests this passively today — issue #62 will wire the auto-promote-to-live path)
4. **Listen to events on Connected accounts** — toggle ON. Without this, donor payments on connected accounts fire events to *the connected account's* webhooks, not yours. Givernance is the platform; we want the platform-side fan-in.
5. Save. Copy the **Signing secret** (starts with `whsec_`) into the `STRIPE_WEBHOOK_SECRET` GitHub secret from step 1.

If you skip step 4, donations land in Stripe and never reach our worker — a silent failure mode that only shows up on the first donor test.

### Step 3 — register the platform Connect account

Same as the local-dev step 2, but in test mode against your staging Stripe account (which can be the same Stripe account you use for local — Stripe scopes everything to test/live). Confirm:

- Platform settings → Connect → Get started
- Connected account type: **Express** (matches `type: "express"` in `packages/api/src/modules/payments/service.ts`)
- Capabilities: leave the defaults; the API requests `card_payments`, `transfers`, `link_payments` on every account it creates.

### Step 4 — push to `main`

The deploy workflow does the rest:

- Builds the Docker image with `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY` baked in (Next.js inlines `NEXT_PUBLIC_*` at build time, so this CAN'T be done at runtime — see Dockerfile + `config/deploy-staging.yml` `builder.args`).
- Writes the runtime secrets (`STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `SEAWEEDFS_SSE_KEY`) to `.kamal/secrets`.
- Restarts the SeaweedFS accessory with the SSE-S3 KEK passphrase configured.
- Runs `db:migrate` + `db:seed` — same as before.
- **New**: runs an idempotent bucket-creation + lifecycle step (the SeaweedFS init script via `aws s3api`, ADR-034) so the worker has somewhere to upload receipts on the very first donation.

After deploy, smoke-test by:

1. Signing in to `https://staging.givernance.org` as the seeded admin.
2. Settings → Stripe Connect → onboard.
3. Make a test donation on the public campaign page (test card `4242 4242 4242 4242`).
4. Confirm in Stripe dashboard: webhook event delivered with HTTP 200.
5. Confirm in app: donation appears, receipt PDF generated.

### Rotating staging credentials

- **Stripe keys**: regenerate in the dashboard, update both `gh secret set …` values, redeploy.
- **SEAWEEDFS_SSE_KEY**: generate a new value, update the secret, redeploy. **Existing receipts encrypted with the old KEK won't be readable** — staging data is non-load-bearing so this is acceptable; production rotation needs a re-encryption migration to keep old objects readable. SeaweedFS HKDF-derives the KEK, so there is no length constraint on the passphrase (see [ADR-034](../adrs/adr-034-seaweedfs-over-minio-for-self-hosted-object-storage.md)).

### Rotating an accessory env var without a full setup

`kamal deploy` (the per-push staging flow) only rolls app containers — `web`, `api`, `worker`, `relay`. Accessories (`postgres`, `redis`, `seaweedfs`, `keycloak`) keep running with whatever env they were last booted with. So when you rotate an accessory secret (e.g. `SEAWEEDFS_SSE_KEY`, `KEYCLOAK_ADMIN_PASSWORD`) or bump an accessory image for a CVE patch, the per-push deploy will *not* pick it up.

Use **`Reboot Staging Accessory`** (`.github/workflows/staging-accessory-reboot.yml`) — `Actions → Reboot Staging Accessory → Run workflow`, pick the accessory, type its name into the confirm field. The workflow reuses the same secrets bag as the deploy (single source of truth in `.github/actions/setup-kamal-secrets/action.yml`), then runs `kamal accessory reboot <name>`. This is the path that would have closed the 2026-04-29 incident in one click instead of an SSH session (issue #212).

When NOT to use it:
- **Accessory schema/topology change** (new port mapping, new mounted file, new env var added in `config/deploy-staging.yml`). Kamal needs to re-render the Compose config — use `workflow_dispatch` on the regular `Deploy to Staging` workflow, which runs `kamal setup` (slower, full bootstrap).
- **App container restart** (web, api, worker, relay). Push to `main` or re-run the deploy workflow; `kamal deploy` already covers these.

---

## What's not covered yet

- **`account.updated` webhook handling** — when a connected account flips `charges_enabled: true`, we should auto-promote the tenant to live mode. Tracked in [issue #62](https://github.com/purposestack/givernance/issues/62).
- **Mollie gateway** — co-primary for FR/BE/NL, gated behind `ff.payments.mollie`. Same issue.
- **Production key handling** — restricted keys, key rotation against Scaleway Object Storage's native SSE-S3, separate Stripe live-mode platform account, KMS-rotation-with-fallback. Tracked in `docs/06-security-compliance.md` and `docs/20-payment-strategy.md`.

If you hit a snag this guide doesn't cover, file an issue with the `payments` label and link the failing log line.
