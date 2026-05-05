## ADR-023: Multi-Currency Pivot Design — `amountBaseCents`, Snapshot Fields, and Exchange-Rate Service

**Status**: Accepted (issue #230)
**Related**: ADR-003 (Drizzle ORM), ADR-008 (BullMQ), ADR-020 (BullMQ dead-letter), ADR-010 (payment provider), `docs/20-payment-strategy.md`

---

### Context

Every donation record carries both a *donor currency* (`currency`, `amountCents`) and a tenant-defined *base currency* (`tenants.base_currency`). Phase 1 stored only `amountCents` and `currency`; KPI queries naively summed `amountCents` across all rows. For a tenant with base currency CHF that received a €100 donation and a £50 donation, the "Total raised" KPI returned 150 — a dimensionless number that meant nothing.

Three additional failure modes surfaced during the multi-currency audit (2026-05-01, issue #230):

1. **Staging rate=1 sentinel.** `EXCHANGE_RATE_API_KEY` was missing from the staging deployment secrets. The service silently fell through to `default_fallback` (rate=1.0), inserting `amountBaseCents = amountCents` for every foreign-currency donation. Data looked correct but was wrong.

2. **No audit trail for the rate used.** If a tenant changed their base currency, or if the rate for a given day was subsequently corrected, there was no way to reconstruct what rate was applied at donation time. The `exchange_rates` table held the current state, not a point-in-time snapshot.

3. **`<AmountInput>` hardcoded `€`.** The web form always showed the euro symbol regardless of the selected currency, causing visible UX breakage and confusion for CHF/GBP-denominated campaigns.

---

### Decision

#### 1. Pivot column: `amount_base_cents`

Every `donations` row stores a pre-computed `amount_base_cents INTEGER NOT NULL` — the donor amount converted to the tenant's base currency **at the time of donation**. All aggregate queries (dashboard KPIs, campaign totals, reports) MUST use `amount_base_cents`. The raw `amount_cents` remains for donor-facing display only.

```sql
-- donations table excerpt (migration 0037)
amount_cents            INTEGER NOT NULL,          -- donor amount in donor currency
currency                VARCHAR(3)  NOT NULL,       -- ISO 4217 donor currency
amount_base_cents       INTEGER NOT NULL,           -- pivot amount in tenant base currency
exchange_rate           NUMERIC(18,8) NOT NULL,     -- rate applied (>0, non-null since 0037)
exchange_rate_at        DATE NOT NULL DEFAULT CURRENT_DATE,
base_currency_at_donation VARCHAR(3) NOT NULL,      -- snapshot of tenants.base_currency
exchange_rate_source    VARCHAR(32) NOT NULL DEFAULT 'unknown',
```

The same pattern applies to `donation_allocations.amount_base_cents` (nullable, backfilled progressively — migration 0038).

#### 2. Snapshot fields

Three snapshot columns on `donations` guard against base-currency changes and enable forensic reconstruction:

| Column | Purpose |
|---|---|
| `base_currency_at_donation` | Tenant's base currency at the moment of conversion. Decouples historical conversions from future tenant currency changes. |
| `exchange_rate_at` | Calendar date of the rate. Allows exact replay of the conversion using `exchangeRates` table. |
| `exchange_rate_source` | Traceability code: `same_currency`, `local_exact`, `api`, `api_cache`, `local_fallback`, `default_fallback`. A `default_fallback` in production is a WARN-level signal. |

#### 3. Exchange rate provider: exchangerate-api.com

| Property | Value |
|---|---|
| Provider | [exchangerate-api.com](https://www.exchangerate-api.com/) |
| Granularity | Daily (`YYYY-MM-DD`). One lookup per (source, target, date) triple. |
| Numeric precision | `NUMERIC(18, 8)` — sufficient for any realistic EUR→JPY or USD→CHF conversion without overflow. |
| Storage | `exchange_rates` table: `(currency, base_currency, date, rate, source)` with composite UNIQUE on `(currency, base_currency, date)`. |
| Nightly pre-warm | BullMQ CRON job at 02:00 UTC (`exchange-rates.refresh`) queries distinct `(currency, base_currency)` pairs active in the last 90 days and pre-warms the rate. This eliminates live API calls during European business hours. |

#### 4. Fallback cascade

`ExchangeRateService.getRate()` resolves the rate via a deterministic cascade:

```
same_currency  →  rate = 1.0, no DB/API call
local_exact    →  exact match in exchange_rates for today
api            →  external API call → stored in exchange_rates + Redis cache
api_cache      →  Redis key `fx:{src}:{tgt}:{date}` (TTL 3600s)
local_fallback →  most recent rate in exchange_rates for (src, tgt), any date
default_fallback → rate = 1.0 (WARN logged; signals missing API key or prolonged outage)
```

A `default_fallback` in production MUST be investigated. The staging deployment secret `EXCHANGE_RATE_API_KEY` must be provisioned via `config/deploy-staging.yml` and the corresponding GitHub Actions workflow.

#### 5. Redis cache layer

The in-process `Map` cache (process-local, lost on restart) was replaced with an injectable `ExchangeRateCache` interface backed by Redis in API and Worker:

```typescript
export interface ExchangeRateCache {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ttlSeconds: number): Promise<void>;
  del(key: string): Promise<void>;
}
```

The `shared` package does **not** import `ioredis` directly (ADR-013 frontend type boundary — the same principle applies to avoid bundler bleed). The Redis adapter is instantiated in `packages/api/src/modules/finance/exchange-rate-service.ts` and `packages/worker/src/lib/cache-redis.ts` and injected via the constructor.

The Worker uses a **dedicated** Redis connection for the cache (`maxRetriesPerRequest: null` is reserved for BullMQ queue connections; the cache connection uses default retry behavior and a distinct `connectionName`).

#### 6. Stripe `intent.amount` vs `amount_received`

When processing `payment_intent.succeeded` webhooks, the canonical amount is `intent.amount` — the amount the customer was charged. `intent.amount_received` is a Stripe convenience field that may differ under partial captures or when fees are deducted. Using `amount_received` would corrupt `amountCents`, making the donation total irreconcilable with the Stripe charge.

#### 7. `<AmountInput>` currency symbol

The `currencySymbol` prop on `<AmountInput>` is required (no default `"€"`). The symbol is derived at call-site via `getCurrencySymbol(currency)` — a pure `Intl.NumberFormat`-based lookup in `@givernance/shared/constants/currencies`. This ensures the symbol updates reactively when the donation-form currency field changes.

#### 8. ISO 4217 format guards (P2 follow-up)

Application-layer validation (Zod/TypeBox schemas) already rejects non-ISO-4217 currency codes before they reach the database. As a defence-in-depth measure, the following CHECK constraints should be added in a migration after P0+P1 are merged (migration 0039):

```sql
ALTER TABLE tenants
  ADD CONSTRAINT tenants_base_currency_iso CHECK (base_currency ~ '^[A-Z]{3}$');

ALTER TABLE donations
  ADD CONSTRAINT donations_currency_iso CHECK (currency ~ '^[A-Z]{3}$'),
  ADD CONSTRAINT donations_base_currency_at_donation_iso
    CHECK (base_currency_at_donation ~ '^[A-Z]{3}$');

ALTER TABLE exchange_rates
  ADD CONSTRAINT exchange_rates_currency_iso CHECK (currency ~ '^[A-Z]{3}$'),
  ADD CONSTRAINT exchange_rates_base_currency_iso CHECK (base_currency ~ '^[A-Z]{3}$');
```

#### 9. Supported currencies

Eight currencies are supported for Phase 1 (European NPO scope). The canonical list lives in `packages/shared/src/constants/currencies.ts`:

```typescript
export const SUPPORTED_CURRENCIES = [
  "EUR", "GBP", "CHF", "SEK", "NOK", "DKK", "PLN", "CZK"
] as const;
```

All tenant `base_currency` values, all donation `currency` values, and all `exchange_rates` rows MUST use one of these eight codes. The `isBaseCurrency()` / `isSupportedCurrency()` guards in that module are the single validation gate.

---

### Alternatives rejected

| Alternative | Reason for rejection |
|---|---|
| **Convert on the fly** at query time | Requires a live rate lookup in every aggregate query; creates implicit coupling between reporting and the exchange-rate API; rate may change between queries in the same report |
| **One amount column per currency** (`amount_eur`, `amount_chf`, …) | Schema explosion; doesn't scale past 8 currencies; forces migration for every new currency |
| **ECB rates only** | ECB publishes EUR-denominated rates for 27 currencies, but the supported set includes non-EUR pivots (CHF, GBP, SEK). A CHF-based tenant would need a two-hop conversion (CHF→EUR→GBP), accumulating rounding error and requiring special-casing |
| **Rate stored as `FLOAT8`** | Floating-point representation introduces silent rounding errors that compound across large donation volumes. `NUMERIC(18,8)` is exact |
| **Single in-process Map cache** | Lost on process restart; not shared between API workers in a multi-replica deployment; silently stale after TTL without Redis pub/sub invalidation |

---

### Consequences

**Positive**
- KPI aggregates (`SUM(amount_base_cents)`) are always correct regardless of donation currency mix.
- Full audit trail: any historical donation can be exactly reconstructed by joining to `exchange_rates WHERE currency = d.currency AND base_currency = d.base_currency_at_donation AND date = d.exchange_rate_at`.
- Redis cache eliminates repeated API calls in multi-replica deployments; nightly CRON pre-warms common pairs before business hours.
- `default_fallback` rate=1 is now an observable and alertable signal (source column + WARN log), not silent data corruption.

**Negative / trade-offs**
- `exchange_rate_at = CURRENT_DATE` for donations imported via the Salesforce ETL will be an approximation — the backfill migration (0037) documents this explicitly.
- Exchange-rate API has a free-tier rate limit; the nightly CRON job must stay within quota. At 8 currencies × 8 possible base currencies = 56 pairs maximum (minus parity = 48), well within the free plan's 1500 requests/month.
- Historical donations with `exchange_rate_source = 'default_fallback'` require manual reconciliation after `EXCHANGE_RATE_API_KEY` is provisioned in staging.

---

### Revisit criteria

- **Phase 4+ (NATS JetStream)**: If donation events are published to JetStream, the exchange-rate lookup could move into a projection/materialised view, removing the synchronous API call from the write path. Revisit caching strategy.
- **XOF/XAF/NGN support**: West-African franc and naira require adding to `SUPPORTED_CURRENCIES` and validating the ECB/exchangerate-api coverage. The `isBaseCurrency()` guard gates the UI; the DB column only constrains the 3-char ISO pattern (no FK to a currencies table today — see ADR-023 §8).
- **Multi-currency allocations**: `donation_allocations.percentage_bp` (added in migration 0038) enables percentage-based fund splits without hard-coding a currency per allocation line. If the allocation model becomes more complex (partial payments, multi-stage pledges), re-evaluate whether `amount_base_cents` should be computed at allocation level rather than donation level.
