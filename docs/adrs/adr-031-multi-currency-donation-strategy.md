## ADR-027 — Multi-currency donation strategy

**Status**: Accepted (2026-04-23, implemented in PR #122/#123/#124; hardened in PR #297)
**Related**: ADR-010 (payment strategy), issue #119, issue #230

### Context

Givernance serves European nonprofits that receive donations in multiple currencies (EUR, GBP, CHF, SEK, NOK, DKK, PLN, CZK). The system needs to:
1. Accept donations in any supported currency
2. Report all amounts in the tenant's reporting (base) currency
3. Preserve historical integrity even if a tenant later changes their base currency

### Decision

#### Provider
exchangerate-api.com via the `ExchangeRateService` in `packages/shared/src/finance/exchange-rate-service.ts`. API key is `EXCHANGE_RATE_API_KEY` (optional — service degrades gracefully without it).

#### Granularity
One snapshot per day per currency pair, stored in the `exchange_rates` table with a UNIQUE constraint on `(currency, base_currency, date)`.

#### Pivot currency
`tenants.base_currency` — all aggregations (dashboard KPIs, campaign ROI, reports) use `donations.amount_base_cents` which is pre-computed at donation time.

#### Rate lookup cascade
1. `same_currency` — source == target, rate = 1
2. `local_exact` — exact row for today in `exchange_rates`
3. `api_cache` — in-process Map cache (TTL 1h)
4. `api` — live fetch from exchangerate-api.com, persisted in `exchange_rates`
5. `local_fallback` — most recent row in `exchange_rates` regardless of date (logged as warning)
6. `default_fallback` — rate = 1 (logged as warning, corrupts `amount_base_cents`)

The fallback strategy prioritises availability over accuracy. `exchange_rate_source` on each donation row makes the data quality visible at query time.

#### Historical integrity
Each donation stores:
- `exchange_rate_at` — the date the rate was fetched (always = donation date)
- `base_currency_at_donation` — the tenant's base currency at that moment
- `exchange_rate_source` — how the rate was obtained

This snapshot immunises historical reports against future tenant currency changes (e.g. a tenant expanding from CHF to EUR).

#### Interaction with Stripe
The Stripe webhook uses `intent.amount` / `intent.currency`, not `amount_received`. This means FX markups applied by Stripe Connect (if the tenant uses a different presentation currency) are not captured. Accepted trade-off for MVP: all Stripe integrations in scope are same-currency or simple EUR/GBP.

#### Rejected alternatives
- **Reconversion at read time**: rejected because it makes historical figures change as rates fluctuate. Also requires a rate for every historical date.
- **Redis cache**: deferred to Phase 2 when multi-node deployment lands. In-process Map is sufficient for single-node staging/production.
- **Rate NOT NULL**: exchange_rate is nullable for legacy rows (created before this ADR was implemented). New rows always have a rate via the fallback cascade.

### Consequences
- Dashboard "Total raised" uses `SUM(amount_base_cents)` — always in the tenant's base currency
- `amountMin/amountMax` donation filters compare against `amount_base_cents` for cross-currency correctness
- The `default_fallback` case silently corrupts `amount_base_cents` — operators MUST configure `EXCHANGE_RATE_API_KEY` in production/staging
- Backfilling historical rates (pre-MVP donations) is explicitly out of scope; see issue #119 follow-up
