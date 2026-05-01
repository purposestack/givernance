## ADR-015: Internationalization & Translation Strategy

- **Status**: Accepted
- **Date**: 2026-04-17
- **Deciders**: Magino (founder/architect) + Claude agents (architecture review)

### Context

Givernance targets European NPOs across FR, BE, NL, DE, and CH markets. The five user personas speak French (all), English (3/5), German (1/5), and Arabic (1/5 — conversational). The organization settings screen (ADM-001) includes a locale selector. Yet after Sprint 4 frontend implementation, ~110 user-facing strings are hardcoded across 15 files — a mix of French (app shell, dashboard) and English (auth pages, error pages). Without a formal i18n strategy, hardcoded strings will compound as Sprint 5+ builds 84+ screens.

### Decision

#### Library: next-intl (non-prefixed routing)

Adopt **next-intl** for frontend i18n with **cookie-based locale detection** (no URL prefix routing). A CRM is not a public SEO-dependent site — locale-prefixed URLs (`/fr/dashboard`, `/en/dashboard`) add complexity without benefit. The locale is determined by:

1. `NEXT_LOCALE` cookie (set via org settings or user preference)
2. `Accept-Language` header fallback
3. Default: `fr` (primary market)

#### Supported Locales

| Phase | Locales | Rationale |
|-------|---------|-----------|
| Phase 2 (now) | `fr`, `en` | Primary markets (FR, BE francophone, UK/international NPOs) |
| Phase 3 | + `de`, `nl` | DE/CH/NL expansion |
| Phase 4+ | + `ar` (RTL) | Persona Karim — requires RTL CSS preparation |

Default locale: **`fr`** — all mockups are in French, primary market is French NPOs.

#### Key Structure: Module Namespaces

Translation keys use **dot-separated module namespaces** in a single file per locale:

```
messages/
├── fr.json    ← { "common": {...}, "auth": {...}, "appShell": {...}, "dashboard": {...} }
└── en.json
```

Naming convention: `{module}.{component}.{element}` — e.g., `auth.login.title`, `appShell.sidebar.dashboard`, `common.actions.cancel`.

Single file per locale (not split per module) because:
- The CRM has ~110 keys today, projected ~500 at full build — well within a single file
- Simplifies CI key-parity check and avoids import complexity
- next-intl loads only the requested namespace at runtime regardless of file structure

#### Frontend i18n Pattern

**Server Components** (pages, layouts):
```typescript
import { getTranslations } from "next-intl/server";
const t = await getTranslations("dashboard");
// t("greeting", { name: auth.firstName })
```

**Client Components** (interactive UI):
```typescript
import { useTranslations } from "next-intl";
const t = useTranslations("appShell");
// t("sidebar.dashboard")
```

**Configuration**: `src/i18n/request.ts` provides the locale and messages to next-intl's server context. The root layout wraps children in `<NextIntlClientProvider>` for client component access.

#### Backend i18n

| Concern | Approach |
|---------|----------|
| API error messages (RFC 9457 `detail`) | Accept `Accept-Language` header; Fastify plugin resolves locale; error `detail` field translated via `i18next` with JSON message files in `packages/api/messages/` |
| Email templates (BullMQ) | Deferred to Phase 3 — no email templates exist yet. BullMQ job payload will carry `locale` field; worker resolves templates per locale |
| PDF generation (fiscal receipts) | Deferred to Phase 3 — PDF engine will accept locale parameter for number/date formatting and legal text |

#### Database Content

Translatable fields (e.g., campaign public page title, custom form labels) use a **JSON column** pattern:

```sql
title_i18n JSONB NOT NULL DEFAULT '{}' -- {"fr": "Appel aux dons", "en": "Fundraising appeal"}
```

With a helper: `getLocalized(row.title_i18n, locale, 'fr')` — falls back to French if translation missing. This avoids a separate translation table while keeping the schema simple for Phase 2.

#### Pluralization & Formatting

- **Plurals**: ICU MessageFormat via next-intl — `{count, plural, one {# don} other {# dons}}`
- **Currency**: `Intl.NumberFormat` with locale + currency from org settings (EUR/CHF)
- **Dates**: `Intl.DateTimeFormat` with locale from org settings
- **Centralized**: Formatting utilities in `src/lib/format.ts` wrapping `Intl` APIs, driven by org locale

#### RTL Preparation

Phase 4+ (Arabic). Architecture must not block it:
- CSS logical properties (`margin-inline-start` not `margin-left`) — enforced via Biome lint rule when Arabic is added
- `dir="rtl"` attribute on `<html>` driven by locale
- Tailwind v4 RTL utilities (`rtl:` variant) available when needed
- No hardcoded `left`/`right` positioning in layout components (use `start`/`end`)

#### Type Safety

next-intl's TypeScript integration with a global type declaration:

```typescript
// src/types/next-intl.d.ts
import type messages from "../../messages/fr.json";
type Messages = typeof messages;
declare module "next-intl" {
  interface AppConfig { Messages: Messages; }
}
```

This provides compile-time checks that all translation keys exist. Missing keys cause TypeScript errors.

#### Translation Workflow

1. Developer writes French strings first (source language)
2. Developer provides English translation in the same PR
3. Translation Specialist agent reviews both languages during PR review
4. Future: Tolgee (self-hostable, GDPR-friendly) for professional translator access — evaluated but not procured in Phase 2

### Rejected Alternatives

| Option | Pros | Cons | Verdict |
|---|---|---|---|
| **react-intl (FormatJS)** | Mature, ICU MessageFormat, good DX | No native App Router/RSC support; requires wrapping every Server Component; heavier bundle than next-intl | Rejected |
| **i18next + react-i18next** | Massive ecosystem, namespace support, backend support | Complex setup for Next.js App Router; `next-i18next` wrapper abandoned; no native RSC integration | Rejected |
| **next-intl** | Native App Router/RSC support, ICU MessageFormat, TypeScript type safety, lightweight, active maintenance | Smaller ecosystem than i18next | **Selected** |
| **URL-prefix routing** (`/fr/dashboard`) | SEO-friendly, locale in URL | CRM is auth-gated (no SEO need), doubles route complexity, breaks existing route structure | Rejected for CRM (appropriate for marketing site) |
| **Per-module JSON files** | Clean separation | Overhead for ~500 keys; complicates CI check; next-intl namespace loading handles this already | Rejected |

### Consequences

- ✅ All user-facing strings are translatable — no hardcoded text in JSX
- ✅ Type-safe keys prevent typos and missing translations at compile time
- ✅ French-first approach matches mockup language and primary market
- ✅ Cookie-based locale keeps CRM URLs clean (no /fr/ /en/ prefixes)
- ✅ Same library (next-intl) can be used if a marketing site is added later
- ⚠️ Single JSON file per locale will need splitting if key count exceeds ~1000 (Phase 4+)
- ⚠️ Backend i18n (i18next for Fastify) is a separate library from frontend (next-intl) — term glossary ensures consistency
- ⚠️ Arabic RTL support requires CSS audit before Phase 4 — logical properties must be enforced retroactively

### 2026-04-26 amendment — 3-layer locale resolution (issue #153)

The original ADR left "BullMQ job payload will carry `locale` field" deferred ("no email templates exist yet"). Phase-1 email templates shipped in PR #143/#148 and inferred the recipient's locale from the tenant's signup `country` field, recovered by walking the outbox. That worked for self-serve tenants but broke for enterprise-seeded tenants (no signup event → permanent EN fallback) and conflated **country** (jurisdiction) with **locale** (language).

Issue #153 generalises locale into a first-class 3-layer chain stored on the database, with the original ADR's `'fr'` default preserved as the floor.

#### Resolution chain

```
effective_locale = user.locale ?? tenant.default_locale ?? APP_DEFAULT_LOCALE ('fr')
```

1. **`users.locale`** — explicit personal preference, NULL = inherit. Persisted only when the invitee picks a value at acceptance time that differs from the tenant default; accepting the default leaves the column NULL so subsequent tenant-default changes apply automatically.
2. **`tenants.default_locale`** — organisation default, NOT NULL with `'fr'` floor (mirror of `APP_DEFAULT_LOCALE`).
3. **`APP_DEFAULT_LOCALE`** — `'fr'`, exported from `@givernance/shared/i18n/locales.ts`. Imported by Drizzle CHECK constraints (migration 0027), TypeBox/Zod validators on the public API, the worker email-template selector, and the web `next-intl` config — keeping every layer in lockstep.

#### Schema changes (migration 0027_locale_resolution)

All three columns are **new** in this migration — `country` previously existed only as an outbox-payload field (never as a row column).

| Column | Type | Constraint |
|---|---|---|
| `tenants.country` | `varchar(2)` NULL | `country IS NULL OR country ~ '^[A-Z]{2}$'` |
| `tenants.default_locale` | `varchar(10)` NOT NULL DEFAULT `'fr'` | `default_locale IN ('en','fr')` |
| `users.locale` | `varchar(10)` NULL | `locale IS NULL OR locale IN ('en','fr')` |

Backfill rule preserves existing email-language behaviour:
- `country = 'FR'` → `default_locale = 'fr'`
- `country IS NOT NULL AND country != 'FR'` → `default_locale = 'en'` (preserves prior EN fallback for BE/DE/NL/CH self-serve signups)
- `country IS NULL` (enterprise-seeded or pre-country signup) → `default_locale = 'fr'` (column DEFAULT — fixes the bug where enterprise tenants always got EN by accident)

#### Email-language selection (BullMQ payload)

`tenant.signup_verification_*` and `invitation.*` outbox payloads now carry `locale: Locale` (BCP-47), resolved at enqueue time by the API. The worker reads `payload.locale` directly — `pickLocale(country)` is deleted. For one transitional release the worker also accepts a legacy `country` field on the payload to render in-flight jobs that pre-date the upgrade; the dispatcher emits a `WARN` log when it falls back, and the country branch is removed once the queue has drained.

#### What stays the same

- Default app locale is still `'fr'`. The signup form's locale picker defaults to the country-derived value (FR→fr, else en), so a French signup still pre-selects French; the user can flip the picker before submit.
- `next-intl` cookie-based detection on the browser side is unchanged; `request.ts` now imports `SUPPORTED_LOCALES` and `APP_DEFAULT_LOCALE` from `@givernance/shared/i18n` so the API contract and the frontend supported set cannot drift.
- Phase-3 plan (DE, NL) and Phase-4 plan (AR + RTL) stand — adding a locale means appending to `SUPPORTED_LOCALES`, the CHECK constraint values, and the translation files.

#### Out of scope (filed as follow-ups)

- `/settings/profile` language switcher (PATCH `/v1/users/me { locale }`).
- `/settings/organization` `default_locale` switcher (PATCH `/v1/tenants/me { default_locale }`).
- Carrying `locale` through Keycloak SSO claims (attribute mapper).
- Region subtags (`fr-CA`, `fr-BE`) — relevant only when region-specific number/date formatting ships.

---

