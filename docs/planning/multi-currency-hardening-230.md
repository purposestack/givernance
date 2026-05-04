# Multi-Currency Hardening — Plan d'implémentation (issue #230)

> Document de planification temporaire — basé sur l'[audit détaillé du 2026-05-01](https://github.com/purposestack/givernance/issues/230#issuecomment-4359667892) (4 agents, commit `28fed20`).
>
> **Branches et PRs :** trois branches créées, une par phase, en draft.

---

## TL;DR

| Phase | Criticité | Contenu | Migration |
|-------|-----------|---------|-----------|
| **P0** — Critical fixes | 🔴 Bloquant | Bug devise, dashboard faux, staging rate=1, colonnes DB manquantes | `0037` |
| **P1** — Robustesse + UX | 🟡 Requis | CRON job, cache Redis, `<Money>`, boutons "Nouveau don", allocations en % | `0038` |
| **P2** — Gouvernance | 🟢 Important | ADR multi-devise, docs, tests de régression, CHECKs SQL | aucune |

---

## Phase P0 — Correctifs critiques

**Branch:** `feat/multi-currency-p0-critical-fixes`
**Ferme :** issue #230 (partiellement)

### Périmètre

Cinq correctifs indépendants, tous bloquants pour un usage multi-devise fiable :

#### P0-1 — `EXCHANGE_RATE_API_KEY` absente du staging

| Fichier | Changement |
|---------|-----------|
| `config/deploy-staging.yml` | Ajouter `EXCHANGE_RATE_API_KEY` à `env.secret` |
| `.github/workflows/deploy-staging.yml` | Ajouter `EXCHANGE_RATE_API_KEY: ${{ secrets.EXCHANGE_RATE_API_KEY }}` dans le step `Setup Kamal Secrets` |

> **Effet :** staging tourne actuellement en `default_fallback` rate=1 sur toute donation en devise étrangère → corruption silencieuse des données.

#### P0-2 — Bug symbole devise `€` hardcodé dans `<AmountInput>`

**Cause racine :** `packages/web/src/components/shared/amount-input.tsx:38` — `currencySymbol = "€"` par défaut. Les deux call-sites dans `donation-form.tsx` (lignes 345 et 546) n'passent pas la prop.

**Correctifs :**

1. **`packages/web/src/lib/format.ts`** — ajouter `getCurrencySymbol(currency: string): string` (switch sur les 8 devises supportées).

2. **`packages/web/src/components/shared/amount-input.tsx:38`** — rendre `currencySymbol` prop required (supprimer le default `"€"`).

3. **`packages/web/src/components/donations/donation-form.tsx`** — passer `currencySymbol={getCurrencySymbol(form.watch("currency"))}` aux deux call-sites (lignes 345 et 546).

#### P0-3 — Migration `0037_multi_currency_hardening.sql`

Colonnes manquantes sur `donations` et corrections sur `exchange_rates` :

**Table `donations`** :

```sql
-- Ajouter :
exchange_rate_at       DATE         NOT NULL DEFAULT CURRENT_DATE
base_currency_at_donation VARCHAR(3) NOT NULL (backfill depuis tenants.base_currency)
exchange_rate_source   VARCHAR(32)  NOT NULL DEFAULT 'unknown'
-- Rendre NOT NULL :
exchange_rate NUMERIC(18,8) NOT NULL (patch NULL → 1.0 avant ALTER)
```

**Table `exchange_rates`** :

```sql
-- Ajouter :
source VARCHAR(32) NOT NULL DEFAULT 'unknown'
-- Ajouter contrainte :
CHECK (rate > 0)
-- Ajouter index composite :
CREATE INDEX exchange_rates_lookup_idx ON exchange_rates (currency, base_currency, date DESC)
```

**SQL complet de migration :**

```sql
-- Migration: 0037_multi_currency_hardening

-- ─── exchange_rates — source ───────────────────────────────────────────────
ALTER TABLE exchange_rates
  ADD COLUMN IF NOT EXISTS source VARCHAR(32) NOT NULL DEFAULT 'unknown';

-- ─── exchange_rates — rate > 0 ────────────────────────────────────────────
DO $$
DECLARE bad_count INTEGER;
BEGIN
  SELECT COUNT(*) INTO bad_count FROM exchange_rates WHERE rate <= 0;
  IF bad_count > 0 THEN
    RAISE EXCEPTION '0037: % exchange_rates rows have rate <= 0. Fix before migrating.', bad_count;
  END IF;
END $$;
--> statement-breakpoint
ALTER TABLE exchange_rates
  ADD CONSTRAINT exchange_rates_rate_positive CHECK (rate > 0);

-- ─── exchange_rates — index composite ─────────────────────────────────────
CREATE INDEX IF NOT EXISTS exchange_rates_lookup_idx
  ON exchange_rates (currency, base_currency, date DESC);

-- ─── donations — exchange_rate_at ─────────────────────────────────────────
ALTER TABLE donations
  ADD COLUMN IF NOT EXISTS exchange_rate_at DATE NOT NULL DEFAULT CURRENT_DATE;

-- ─── donations — base_currency_at_donation ────────────────────────────────
ALTER TABLE donations
  ADD COLUMN IF NOT EXISTS base_currency_at_donation VARCHAR(3);
--> statement-breakpoint
DO $$
DECLARE backfilled_from_tenant INTEGER; fallback_to_eur INTEGER;
BEGIN
  UPDATE donations d
    SET base_currency_at_donation = t.base_currency
    FROM tenants t WHERE d.org_id = t.id AND d.base_currency_at_donation IS NULL;
  GET DIAGNOSTICS backfilled_from_tenant = ROW_COUNT;
  UPDATE donations SET base_currency_at_donation = 'EUR' WHERE base_currency_at_donation IS NULL;
  GET DIAGNOSTICS fallback_to_eur = ROW_COUNT;
  RAISE NOTICE '0037: backfill base_currency_at_donation — % from tenants, % fallback EUR',
    backfilled_from_tenant, fallback_to_eur;
END $$;
--> statement-breakpoint
ALTER TABLE donations ALTER COLUMN base_currency_at_donation SET NOT NULL;

-- ─── donations — exchange_rate_source ─────────────────────────────────────
ALTER TABLE donations
  ADD COLUMN IF NOT EXISTS exchange_rate_source VARCHAR(32) NOT NULL DEFAULT 'unknown';

-- ─── donations — exchange_rate NOT NULL ───────────────────────────────────
DO $$
DECLARE parity_fixed INTEGER; foreign_nulls INTEGER;
BEGIN
  SELECT COUNT(*) INTO foreign_nulls
    FROM donations
   WHERE exchange_rate IS NULL AND currency <> COALESCE(base_currency_at_donation, 'EUR');
  IF foreign_nulls > 0 THEN
    RAISE NOTICE '0037 WARNING: % foreign-currency donations have NULL exchange_rate → setting to 1.0 sentinel — audit required.', foreign_nulls;
  END IF;
  UPDATE donations SET exchange_rate = 1.0, exchange_rate_source = 'parity'
   WHERE exchange_rate IS NULL AND currency = base_currency_at_donation;
  GET DIAGNOSTICS parity_fixed = ROW_COUNT;
  UPDATE donations SET exchange_rate = 1.0 WHERE exchange_rate IS NULL;
  RAISE NOTICE '0037: set exchange_rate — % parity rows (source=parity)', parity_fixed;
END $$;
--> statement-breakpoint
ALTER TABLE donations ALTER COLUMN exchange_rate SET NOT NULL;
```

**Drizzle schema — `donations` (nouveaux champs) :**

```typescript
// packages/shared/src/schema/index.ts — donations table
exchangeRate: numeric("exchange_rate", { precision: 18, scale: 8 }).notNull(), // NOT NULL depuis 0037
exchangeRateAt: date("exchange_rate_at").notNull().defaultNow(),
baseCurrencyAtDonation: varchar("base_currency_at_donation", { length: 3 }).notNull().default("EUR"),
exchangeRateSource: varchar("exchange_rate_source", { length: 32 }).notNull().default("unknown"),
```

**Drizzle schema — `exchangeRates` (champs ajoutés) :**

```typescript
source: varchar("source", { length: 32 }).notNull().default("unknown"),
// + index composite exchange_rates_lookup_idx
```

**Application layer — `donations/service.ts:508-522` :** passer les 3 nouveaux champs à l'INSERT :

```typescript
exchangeRateAt: new Date().toISOString().slice(0, 10), // ISO date
baseCurrencyAtDonation: baseCurrency,
exchangeRateSource: convertedAmount.source, // 'api' | 'local_fallback' | etc.
```

#### P0-4 — Dashboard "Total levé" utilise `amountBaseCents`

**Backend `packages/api/src/modules/dashboard/service.ts:47-48`** :
```typescript
// AVANT:
SUM(${donations.amountCents})
// APRÈS:
SUM(${donations.amountBaseCents})
```

Ajouter `baseCurrency` dans le retour du service (lecture depuis `tenants.baseCurrency`).

**API schema `dashboard/routes.ts`** : ajouter `baseCurrency: Type.String()` dans `DashboardStatsSchema`.

**Frontend `dashboard/page.tsx:78-79`** :
```typescript
// AVANT:
const primaryCurrency = kpiDonations?.data[0]?.currency ?? "EUR";
// APRÈS:
const baseCurrency = stats?.baseCurrency ?? "EUR";
// Utiliser baseCurrency dans formatCurrency() / <Money>
```

#### P0-5 — Filtres `amountMin`/`amountMax` et sort `amountCents` sur devise pivot

**`packages/api/src/modules/donations/service.ts:306-307`** — filtrer sur `amountBaseCents` par défaut :

```typescript
// Ajouter amountField?: "donor" | "base" à ListDonationsQuery
const amountCol = amountField === "donor" ? donations.amountCents : donations.amountBaseCents;
if (amountMin !== undefined) conditions.push(gte(amountCol, amountMin));
if (amountMax !== undefined) conditions.push(lte(amountCol, amountMax));
```

**`service.ts:159`** — sort `amountCents` → colonne `amountBaseCents` :

```typescript
if (sort === "amountCents") return [dir(donations.amountBaseCents), asc(donations.id)];
```

**`donations/routes.ts`** : ajouter `amountField: Type.Optional(Type.Union([...]))` au `ListQuery`.

---

### Risques P0

| Risque | Mitigation |
|--------|-----------|
| Backfill `base_currency_at_donation` incorrect si tenant a changé de devise | NOTICE dans la migration ; requête de réconciliation fournie |
| `exchange_rate_at = CURRENT_DATE` pour les dons historiques (approximation) | Documenté dans migration ; possible backfill post-déploiement |
| `exchange_rate NOT NULL` avec sentinel 1.0 sur dons en devise étrangère | NOTICE WARNING + audit manuel requis |

---

## Phase P1 — Robustesse et UX

**Branch:** `feat/multi-currency-p1-robustness-ux`
**Dépend de :** P0 mergé

### Périmètre (6 fonctionnalités)

#### P1-1 — Job BullMQ CRON `refresh-exchange-rates`

**Nouveau fichier :** `packages/worker/src/processors/refresh-exchange-rates.ts`

- Cron `"0 2 * * *"` UTC (02:00 chaque nuit)
- Récupère les paires `(donation.currency, tenant.base_currency)` distinctes actives sur 90 jours
- Appelle `ExchangeRateService.getRate()` pour chaque paire non-parity
- Logs structurés : `exchange_rate.refresh_start`, `exchange_rate.refresh_complete`, `exchange_rate.refresh_failed_pair`
- Aucun throw global — les erreurs par paire sont loguées et le reste continue

**`packages/worker/src/worker.ts`** :
```typescript
// Ajouter queue "exchange_rates"
// Ajouter dans scheduleRepeatableJobs():
await exchangeRatesQueue.add(
  EXCHANGE_RATE_JOBS.REFRESH,
  {},
  { jobId: "exchange-rates-refresh-nightly", repeat: { pattern: "0 2 * * *", tz: "UTC" }, ... },
);
```

**`packages/shared/src/jobs/index.ts`** : ajouter `EXCHANGE_RATES: "exchange_rates"` à `QUEUE_NAMES`.

#### P1-2 — Cache Redis pour `ExchangeRateService`

Remplacer `Map` process-local (`exchange-rate-service.ts:39`) par un cache Redis injecté via le constructeur.

**Interface injectable :**
```typescript
export interface ExchangeRateCache {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ttlSeconds: number): Promise<void>;
  del(key: string): Promise<void>;
}
```

**Clé Redis :** `fx:{src}:{tgt}:{date}` — TTL : 3600s.

Le shared package ne doit pas importer `ioredis` directement (ADR-013 type boundary). Le cache est injecté depuis l'API et le worker :

```typescript
// packages/api/src/modules/finance/exchange-rate-service.ts
cache: {
  get: (key) => redis.get(key),
  set: (key, value, ttl) => redis.set(key, value, "EX", ttl).then(() => undefined),
  del: (key) => redis.del(key).then(() => undefined),
},
```

#### P1-3 — Constantes devises unifiées

**Nouveau fichier :** `packages/shared/src/constants/currencies.ts`

```typescript
export const SUPPORTED_CURRENCIES = ["EUR","GBP","CHF","SEK","NOK","DKK","PLN","CZK"] as const;
export type Currency = (typeof SUPPORTED_CURRENCIES)[number];
export const BASE_CURRENCIES = [...SUPPORTED_CURRENCIES] as const;
export type BaseCurrency = (typeof BASE_CURRENCIES)[number];

export function getCurrencySymbol(currency: Currency, locale = "en-US"): string {
  const parts = new Intl.NumberFormat(locale, { style: "currency", currency,
    minimumFractionDigits: 0, maximumFractionDigits: 0 }).formatToParts(0);
  return parts.find(p => p.type === "currency")?.value ?? currency;
}

export function isSupportedCurrency(value: string): value is Currency { ... }
export function isBaseCurrency(value: string): value is BaseCurrency { ... }
```

**`packages/shared/src/validators/index.ts`** :
- Importer `SUPPORTED_CURRENCIES`, `BASE_CURRENCIES` depuis `constants/currencies`
- Remplacer les unions inline dans `DonationCreateSchema.currency` et `MultiCurrencySchema`
- Deprecate `MULTI_CURRENCY_VALUES` → re-exporter `BASE_CURRENCIES` avec jsdoc `@deprecated`

#### P1-4 — Migration `0038_allocation_enrichment.sql`

**Table `donation_allocations`** :

```sql
-- Ajouter :
amount_base_cents INTEGER  -- nullable, backfill progressif
percentage_bp     INTEGER  -- nullable, CHECK (BETWEEN 1 AND 10000)

-- Rendre amount_cents nullable (pour les splits en %) :
ALTER TABLE donation_allocations ALTER COLUMN amount_cents DROP NOT NULL;

-- Contrainte XOR (exactly one of amount_cents or percentage_bp) :
ADD CONSTRAINT donation_allocations_amount_or_bp
  CHECK (
    (amount_cents IS NOT NULL AND percentage_bp IS NULL) OR
    (amount_cents IS NULL AND percentage_bp IS NOT NULL)
  );
```

**Trigger `check_allocation_sum` rewrite** : mode A (amount_cents), mode B (percentage_bp = 10000 bp), rejet mixed-mode.

**Drizzle schema** :
```typescript
amountCents: integer("amount_cents"),           // nullable depuis 0038
percentageBp: integer("percentage_bp"),          // nullable
amountBaseCents: integer("amount_base_cents"),   // nullable
```

**Validator `DonationAllocationSchema`** : exposer `percentageBp` optionnel.

**UI — Allocation toggle** : ajouter un toggle "montant fixe / pourcentage" par ligne d'allocation dans `donation-form.tsx` + helper "répartir équitablement".

#### P1-5 — Boutons "Nouveau don" sur fiches détail

**`packages/web/src/app/(app)/constituents/[id]/page.tsx:358`** — dans `ProfileActions` (gated `donations:write`) :
```tsx
<Button asChild variant="secondary" size="sm">
  <Link href={`/donations/new?constituentId=${constituentId}`}>
    <Banknote size={16} aria-hidden="true" />
    {t("actions.newDonation")}
  </Link>
</Button>
```

**`packages/web/src/app/(app)/campaigns/[id]/page.tsx`** — dans le header de `DonationBreakdownCard` :
```tsx
<Button asChild variant="secondary" size="sm">
  <Link href={`/donations/new?campaignId=${campaign.id}`}>
    <Gift size={16} aria-hidden="true" />
    {tDonations("newDonation")}
  </Link>
</Button>
```

Ajouter les clés de traduction `fr.json` / `en.json`.

#### P1-6 — Pré-remplissage `/donations/new?constituentId=X&campaignId=Y`

**`packages/web/src/app/(app)/donations/new/page.tsx`** : lire `searchParams`, résoudre `campaign.defaultCurrency`, passer à `<DonationForm>` :
```tsx
interface NewDonationPageProps {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}
// ...
<DonationForm
  mode="create"
  initialConstituentId={constituentId}
  initialCampaignId={campaignId}
  initialCurrency={campaignDefaultCurrency}
/>
```

**`DonationForm`** : étendre `CreateMode` type + `buildDefaultValues` + `useEffect` pour charger le constituent via `ConstituentService.getConstituent()`.

#### P1-7 — Composant `<Money>` + migration `formatCurrency` 2-args

**Nouveau fichier :** `packages/web/src/components/shared/money.tsx`

```tsx
"use client";
export function Money({ cents, currency, locale: localeProp }: MoneyProps) {
  const localeFromHook = useLocale();
  const baseCurrency = useTenantBaseCurrency();
  return (
    <span className="font-mono tabular-nums">
      {formatCurrency(cents, localeProp ?? localeFromHook, currency ?? baseCurrency)}
    </span>
  );
}
```

**`packages/web/src/lib/hooks/use-tenant-base-currency.ts`** + **`packages/web/src/lib/context/tenant-context.ts`** + **`TenantProvider`** dans `(app)/layout.tsx`.

Migrer les 12+ call-sites `formatCurrency(x, locale)` sans 3ème argument vers `<Money cents={x} />` ou `<Money cents={x} currency={donation.currency} />`.

#### P1-8 — Settings → onglet Currency (8 devises)

**`packages/web/src/components/settings/settings-navigation.tsx`** : ajouter onglet `currency` → `/settings/currency`.

**`packages/web/src/components/settings/tenant-settings-form.tsx:23`** : étendre de 3 à 8 devises :
```typescript
const TENANT_CURRENCIES = ["EUR","GBP","CHF","SEK","NOK","DKK","PLN","CZK"] as const;
```

**Nouveau :** `packages/web/src/app/(app)/settings/currency/page.tsx`.

**API side :** vérifier que `PATCH /v1/tenants/:id` accepte les 8 devises dans `CurrencySchema`.

---

## Phase P2 — Gouvernance et documentation

**Branch:** `feat/multi-currency-p2-governance-docs`
**Dépend de :** P1 mergé (ou peut être parallèle)

### Périmètre

#### P2-1 — ADR multi-devise dans `docs/15-infra-adr.md`

Rédiger un ADR numéroté (suite des ADRs existants) couvrant :
- Problème : amountCents multi-devise additionnés sans conversion = KPIs faux
- Décision : `amountBaseCents` (pivot tenant), snapshot `baseCurrencyAtDonation`, `exchangeRateAt`, `exchangeRateSource`
- Fournisseur : exchangerate-api.com, granularité `DATE`, `NUMERIC(18,8)`
- Fallback : DB local → dernier taux connu → rate=1 (toujours loggué)
- Interaction Stripe : utiliser `intent.amount` (pas `amount_received`)
- Alternatives rejetées : conversion à la volée, colonne devise par montant, ECB uniquement
- Critères de révision : passage à NATS JetStream (Phase 4+), support XOF/XAF

#### P2-2 — Mettre à jour `docs/03-data-model.md`

- Ajouter table `exchange_rates` (colonnes, PK/UNIQUE, index composite)
- Mettre à jour `donations` : documenter `exchange_rate_at`, `base_currency_at_donation`, `exchange_rate_source`, noter `exchange_rate NOT NULL`
- Mettre à jour `donation_allocations` : `amount_base_cents`, `percentage_bp`, `amount_cents` nullable
- Mettre à jour `diagrams/core-erd.mmd` : ajouter `exchange_rates` comme entité

#### P2-3 — Documenter `EXCHANGE_RATE_API_KEY`

- **`README.md`** : section Variables d'environnement — source, fallback, lien signup
- **`.env.example:117`** : décommenter la ligne
- **`docs/dev/` (si fichier existe)** : ajouter au guide de setup local

#### P2-4 — Renommer migrations en collision `0023_*`

Les deux fichiers `0023_onboarding_runtime.sql` et `0023_multi_currency_schema.sql` coexistent. Pour P2, documenter dans un commentaire en tête de chaque fichier l'ordre d'application (par timestamp). Ne pas renommer les fichiers sur `main` (Drizzle suit par hash de nom) — créer un ADR ou une note dans `docs/infra/README.md` expliquant la collision.

#### P2-5 — CHECKs ISO 4217 SQL

```sql
-- Optionnel (validé côté app) mais défensif :
ALTER TABLE tenants ADD CONSTRAINT tenants_base_currency_iso
  CHECK (base_currency ~ '^[A-Z]{3}$');
ALTER TABLE donations ADD CONSTRAINT donations_currency_iso
  CHECK (currency ~ '^[A-Z]{3}$');
-- etc.
```

Ou créer une table `currencies` seedée + FK (plus robuste mais plus lourd).

#### P2-6 — Tests d'intégration

Voir la section **Tests** ci-dessous.

---

## Spécifications des tests par phase

### P0 — Tests d'intégration à ajouter

**Nouveau fichier :** `packages/api/src/tests/integration/multi-currency-p0.test.ts`

```
describe("P0-1: EXCHANGE_RATE_API_KEY env wiring")
  it("boots without key (Optional in dev)")
  it("utilise la clé pour le header Authorization dans les appels API")

describe("P0-3: Colonnes DB nouvelles + exchange_rate NOT NULL")
  it("rejects NULL exchange_rate on INSERT → pg error 23502")
  it("exchange_rate_at column accepts DATE value")
  it("base_currency_at_donation stores tenant base currency")
  it("exchange_rate_source stores 'api' or 'local_fallback'")

describe("P0-4: Dashboard totalRaisedCents uses amountBaseCents")
  it("CHF tenant: SUM(amountBaseCents) ≠ SUM(amountCents)")
  it("GET /v1/dashboard/stats returns baseCurrency field")
  it("previousMonth also uses amountBaseCents")

describe("P0-5: Filters and sort on amountBaseCents")
  it("?amountMin/amountMax filters by amountBaseCents for CHF tenant")
  it("?sort=amountCents&order=asc orders by amountBaseCents")
  it("?amountMin alone works as lower bound")
  it("?amountMax alone works as upper bound")
```

**Régressions à vérifier :**
- `exchange-rate-service.test.ts` — 5 tests existants passent
- `donations.test.ts:142-176` — EUR→CHF, `amountBaseCents=9500`
- `stripe-webhook.test.ts:239-296` — USD→JPY rate 150
- `dashboard-stats.test.ts` — tenant EUR inchangé
- `list-sort.test.ts` — tous les tris passent
- `schema-parity.test.ts` — aucune dérive Drizzle/SQL

### P1 — Tests d'intégration à ajouter

| Fichier | Nb tests |
|---------|---------|
| `packages/worker/src/tests/integration/exchange-rate-refresh.test.ts` | 5 |
| `packages/api/src/tests/integration/exchange-rate-redis-cache.test.ts` | 5 |
| `packages/api/src/tests/integration/donations-prefill.test.ts` | 4 |
| `packages/web/src/components/shared/money.test.tsx` | 8 |
| `packages/api/src/tests/integration/settings-currency.test.ts` | 8 |

**Régressions :** Worker boot pas en erreur après ajout queue, `receipt-processor.test.ts` inchangé, `stripe-webhook.test.ts` inchangé.

### P2 — Tests d'intégration à ajouter

| Fichier | Nb tests |
|---------|---------|
| `packages/api/src/tests/integration/multi-currency-dashboard.test.ts` | 5 |
| `packages/worker/src/tests/integration/rate-refresh-job.test.ts` | 4 |
| `packages/api/src/tests/integration/exchange-rate-api-down-fallback.test.ts` | 3 |
| `packages/api/src/tests/integration/concurrent-rate-fetch.test.ts` | 3 |
| `packages/api/src/tests/integration/donation-re-rate.test.ts` | 6 |

---

## Procédures de test manuelles

### P0

**T-P0-1 : EXCHANGE_RATE_API_KEY dans staging**
1. Vérifier la clé est présente sur le host staging (`printenv EXCHANGE_RATE_API_KEY | head -c 8`)
2. Redémarrer l'API
3. Vérifier les logs de boot : aucun warning `EXCHANGE_RATE_API_KEY`
4. Créer un don en CHF dans un org base-CHF
5. `SELECT exchange_rate_source, exchange_rate FROM donations ORDER BY created_at DESC LIMIT 1` → `source = 'api'`
6. ✅ Pass si `exchange_rate_source = 'api'`

**T-P0-2 : Symbole devise mis à jour en temps réel**
1. Naviguer vers `/donations/new`
2. Observer le symbole dans `AmountInput` → `€`
3. Changer la devise → `GBP` → observer le symbole → `£`
4. Changer → `CHF` → observer → `CHF`
5. Changer → `EUR` → observer → `€`
6. ✅ Pass si le symbole se met à jour sans rechargement

**T-P0-3 : Colonnes DB après migration**
1. `\d donations` → confirmer `exchange_rate_at DATE`, `base_currency_at_donation VARCHAR`, `exchange_rate_source VARCHAR`, `exchange_rate NOT NULL`
2. Tenter INSERT avec `exchange_rate = NULL` → erreur `23502`
3. `pnpm --filter @givernance/shared run db:check` → aucune dérive de schéma
4. ✅ Pass si tous les champs présents et NOT NULL enforced

**T-P0-4 : Dashboard "Total levé" en devise pivot**
1. Se connecter sur org à base CHF
2. Créer 2 dons : 100 EUR (→ 95 CHF), 50 EUR (→ 47.50 CHF)
3. Dashboard → "Total levé" = 142.50 CHF (pas 150 EUR)
4. Le label/symbole est `CHF`
5. ✅ Pass si valeur = sum(amountBaseCents)/100 dans la bonne devise

**T-P0-5 : Filtres et tri sur devise pivot**
1. Org CHF. Dons : A=190 CHF, B=47.50 CHF, C=95 CHF
2. `GET /donations?amountMin=7000&amountMax=15000` → seul C apparaît (9500 CHF-cents)
3. `GET /donations?sort=amountCents&order=asc` → ordre B→C→A
4. ✅ Pass si filtres appliqués sur amountBaseCents

### P1

**T-P1-1 : Job CRON refresh-exchange-rates**
1. Démarrer le worker (`pnpm --filter @givernance/worker dev`)
2. Confirmer dans les logs : `Scheduled repeatable job: exchange-rates.refresh`
3. Déclencher manuellement via Bull Board ou Redis CLI
4. `SELECT * FROM exchange_rates WHERE date = CURRENT_DATE ORDER BY currency` → rows présentes
5. ✅ Pass si le job existe et populate la table

**T-P1-2 : Cache Redis pour les taux**
1. Vider les clés `redis-cli KEYS "fx:*" | xargs redis-cli DEL`
2. Créer 2 dons back-to-back en devise étrangère (même org)
3. Logs API : 1er appel `source: 'api'`, 2ème `source: 'api_cache'` ou `source: 'db'`
4. `redis-cli GET "fx:EUR:CHF:2026-05-04"` → valeur non vide
5. ✅ Pass si 1 seul appel externe par fenêtre TTL

**T-P1-3 : Bouton "Nouveau don" sur fiche Constituent**
1. Naviguer sur `/constituents/:id`
2. Localiser le bouton "Nouveau don"
3. Cliquer → URL `/donations/new?constituentId=:id`
4. Champ Constituent pré-rempli avec le nom du constituent
5. Soumettre → don lié au constituent dans l'onglet Donations
6. ✅ Pass si pré-remplissage OK et don correctement lié

**T-P1-4 : Bouton "Nouveau don" sur fiche Campaign**
1. Naviguer sur `/campaigns/:id`
2. Localiser le bouton "Nouveau don"
3. Cliquer → URL `/donations/new?campaignId=:id`
4. Champ Campaign pré-rempli + devise = `campaign.defaultCurrency`
5. Soumettre → don lié à la campagne
6. ✅ Pass si pré-remplissage OK et don correctement lié

**T-P1-5 : `/donations/new` dual pré-remplissage**
1. Naviguer vers `/donations/new?constituentId=C1&campaignId=CAM1`
2. Deux champs pré-remplis simultanément
3. Devise = `CAM1.defaultCurrency`
4. Soumettre → `constituentId=C1` + `campaignId=CAM1`
5. ✅ Pass si les deux FK sont correctement persistées

**T-P1-6 : Composant `<Money>` — aucun appel `formatCurrency` 2-args**
1. `grep -r "formatCurrency" packages/web/src --include="*.tsx" --include="*.ts"` → 0 appels sans 3ème argument
2. Dashboard : montants affichés dans la bonne devise
3. Liste des dons : symbole correct par devise de chaque don
4. ✅ Pass si grep retourne 0 résultats à 2 args et UI correcte

**T-P1-7 : Settings → onglet Currency (8 devises)**
1. Naviguer sur `/settings` → onglet "Devise" visible
2. Sélecteur affiche exactement 8 options : EUR, GBP, CHF, SEK, NOK, DKK, PLN, CZK
3. Sélectionner CHF → Sauvegarder → toast succès
4. Recharger la page → CHF affiché
5. Viewer → sélecteur disabled ou bouton absent
6. ✅ Pass si 8 options, persistance, et viewer bloqué

---

## Dépendances inter-phases

```
P0 (migration 0037, bug fixes)
  └─► P1 (migration 0038, robustesse)
        └─► P2 (docs, ADR, tests, CHECKs)
```

P2 peut être lancé en parallèle de P1 pour les parties documentation pure (ADR, README, data-model).

---

## Checklist CI avant chaque merge

Conformément à `CLAUDE.md` :

```bash
pnpm install
pnpm build
pnpm run format
pnpm run lint
pnpm typecheck
pnpm test
```

Aucun merge si l'une de ces commandes échoue.
