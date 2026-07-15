# 11 — Design Identity, UI & UX

> **Givernance NPO Platform** — A platform that feels like it was built for people, not for systems.
> Last updated: 2026-06-05

---

## 0. Why this document exists

Architecture, data models, and APIs are necessary — but insufficient. A platform adopted by nonprofit staff needs to feel **right**: trustworthy, warm, effortless. This document defines Givernance's visual soul and interaction principles. It is not cosmetic. It is a product constraint as binding as any technical requirement.

> *"The best interface is one that feels like it was always there."*

NPO staff are not power users. They are social workers, fundraising coordinators, volunteer managers — people who care deeply about their mission and have limited patience for software friction. Givernance must earn their trust every time they open it.

---

## 1. Design north star

**Givernance should feel like a calm, capable companion — not a corporate tool.**

| Attribute | What it means in practice |
|---|---|
| **Warm** | Colors, typography, and language that feel human, not institutional |
| **Calm** | Visual hierarchy that reduces cognitive load; no panic-inducing dashboards |
| **Capable** | Dense enough to do real work; never dumbed down |
| **Trustworthy** | Consistent, predictable, no surprises — especially for sensitive data |
| **Inclusive** | Accessible to non-technical staff; WCAG 2.1 AA minimum |

---

## 2. Brand & visual identity

### 2.1 Personality

Givernance's visual identity should communicate:
- **Liberation** — freedom from complexity, from Salesforce, from administrative burden
- **Rootedness** — European, local, civic-minded (not Silicon Valley slick)
- **Warmth** — the cause matters; the people matter; the software acknowledges this

### 2.2 Color palette

> **2026 rebrand (website PR #24)**: green → teal, phoenix → cube, Newsreader/Inter/JetBrains → Sora/Manrope/IBM Plex Mono. The brand primary moved from Givernance Green to a teal family, and **Ember coral** was introduced as a second brand colour. The success/error/warning/info semantic palette is unchanged.

#### Core palette

| Role | Name | Token | Hex | Usage |
|---|---|---|---|---|
| Primary | Givernance Teal | `--color-primary` | `#08675B` | Brand identity, CTAs, active nav states |
| Secondary | Teal | `--color-secondary` | `#0A6B5E` | Secondary brand surfaces, accents |
| Primary container | — | `--color-primary-container` | `#2E7D72` | Tonal container fills |
| Surface tint | — | `--color-surface-tint` | `#0A6B5E` | Material You surface tinting |
| Primary dark | Deep Teal | `--color-primary-dark` | `#00514A` | Text on light bg, deep brand accents, hover |
| Primary active | — | `--color-primary-active` | `#04332E` | Button/link pressed states |
| Primary 50 | Mint | `--color-primary-50` | `#D1FFF4` | Focus rings, brand-tint backgrounds |
| Primary 100 | — | `--color-primary-100` | `#A4F3E4` | Subtle borders, brand-tint alert borders |

#### Ember coral — brand accent

| Role | Name | Token | Hex | Usage |
|---|---|---|---|---|
| Accent | Ember coral | `--color-accent` | `#EC6A66` | Second brand colour — logo cube accent, brand moments, illustration highlights |
| Accent text | Ember text | — | `#B52E29` | AA-contrast text/icon variant of ember on light surfaces |

**Ember coral is a brand colour, not a status colour.** It pairs with the teal primary in the logo and across brand-led surfaces (marketing, hero illustrations, the cube mark). It must **never** be used to signal success, warning, error, or any semantic state — those keep their dedicated palette below. The teal brand anchor used in the logo and strong brand contexts is `#008570`.

#### Neutral palette (cool sophisticated gray)

| Token | Name | Hex | Usage |
|---|---|---|---|
| `--color-neutral-50` | Cloud | `#F8F9FA` | Page backgrounds |
| `--color-neutral-100` | Mist | `#F1F3F5` | Card surfaces, panel backgrounds |
| `--color-neutral-200` | Silver | `#E2E5E9` | Borders, dividers |
| `--color-neutral-300` | Pewter | `#CED3D9` | Disabled borders, scrollbar thumbs |
| `--color-neutral-400` | Ash | `#9BA3AD` | Muted text, placeholders |
| `--color-neutral-500` | Dusk | `#6B7280` | — |
| `--color-neutral-600` | Slate | `#4B5563` | Secondary text |
| `--color-neutral-700` | Shadow | `#374151` | — |
| `--color-neutral-800` | Charcoal | `#1F2937` | Dark UI surfaces |
| `--color-neutral-900` | Ink | `#111827` | Primary body text |

#### Semantic colors

| Role | Token | Hex | Light / 50 | Usage |
|---|---|---|---|---|
| Success | `--color-success` → `--color-green` | `#16A34A` | `#F0FDF4` | Positive outcomes, completed states |
| Warning | `--color-warning` → `--color-amber` | `#D97706` | `#FFFBEB` | Caution states, expiring items |
| Error | `--color-error` → `--color-red` | `#DC2626` | `#FEF2F2` | Validation errors, destructive actions |
| Info | `--color-info` → `--color-sky` | `#2E79A6` | `#F0F9FF` | Informational messages, links |

#### Accent colors

| Role | Token | Hex | Usage |
|---|---|---|---|
| Indigo | `--color-indigo` | `#5B4FD4` | Decorative accent, special badges |
| Navy | `--color-navy` | `#1E293B` | Data-heavy sections, dashboard headers |

#### Surface & overlay tokens

| Token | Value | Usage |
|---|---|---|
| `--color-surface` | `#FFFFFF` | Card/panel backgrounds |
| `--color-surface-alt` | `var(--color-neutral-100)` = `#F1F3F5` | Alternate surface |
| `--color-surface-raised` | `#FFFFFF` | Elevated surfaces |
| `--color-surface-sunken` | `var(--color-neutral-100)` = `#F1F3F5` | Inset/recessed areas |
| `--color-overlay` | `rgba(17, 24, 39, 0.5)` | Modal/drawer backdrops |

**Rationale**: Cool sophisticated grays paired with the teal primary evoke trust, professionalism, and care; ember coral adds warmth and human energy at brand moments without ever standing in for a status signal. Error and destructive states use **red** (`#DC2626`) — a universally understood danger signal. Red is always paired with icons and text labels to ensure accessibility for all color vision types. Indigo is retained as a decorative accent, not a semantic signal.

### 2.2.1 Color accessibility constraints

**Color must never be the sole means of conveying information.** This is both a WCAG 2.1 requirement (criterion 1.4.1) and a design quality standard.

| Rule | Implementation |
|---|---|
| Status badges | Always pair color with an icon and a text label |
| Form validation | Error highlighted in border color + icon + text message below the field |
| Chart data series | Use color + pattern or color + direct label (never color-only legends) |
| Destructive actions | Red badge/button + trash/warning icon + explicit label |

**Key contrast ratios** (verified):

| Combination | Ratio | Rating |
|---|---|---|
| Deep Teal `#00514A` on white | ~7.5:1 | AAA |
| Primary `#08675B` on white | ~5.5:1 | AA |
| Ember text `#B52E29` on white | ~4.9:1 | AA |
| Ink `#111827` on Cloud `#F8F9FA` | ~15:1 | AAA |
| Red `#DC2626` on white | ~4.5:1 | AA |
| Red Dark `#991B1B` on white | ~7.8:1 | AAA |

**Colorblind simulation**: Every UI screen must be reviewed through a deuteranopia simulation before design handoff.

### 2.2.2 Logo / brand-mark

The Givernance brand mark is **three interlocking isometric cubes** rendered in the brand teal (`#008570`) with an ember coral (`#EC6A66`) accent face. The cubes read as building blocks — composable, structural, civic — and the interlock evokes the relationships at the heart of a CRM (people, organizations, households fitting together).

- **Source of truth**: the React component [`packages/web/src/components/shared/logo.tsx`](../packages/web/src/components/shared/logo.tsx) and the canonical asset [`docs/design/shared/assets/givernance-logo.svg`](./design/shared/assets/givernance-logo.svg) (mirrored to `packages/web/public/givernance-logo.svg`). Never hand-redraw the mark; always inline the component or `<img>`-reference the SVG.
- **Colours**: teal `#008570` + coral `#EC6A66` only. Do not recolour the cube to a status palette.
- **Scope**: use the cube wherever a surface shows the **Givernance** brand (top bar, login, marketing). A donor- or NPO-facing tenant logo slot is **not** the Givernance mark — those render the tenant's own logo (or the colored-initial fallback in §8.1) and must be left untouched.

> The previous mark — a phoenix formed from a bird rising out of an offering hand — was retired in the 2026 rebrand (website PR #24) and must no longer appear anywhere in the product or docs.

### 2.3 Typography

| Role | Font | Token | Weights | Size range |
|---|---|---|---|---|
| Display / headings | **Sora** | `--font-heading` | 400, 500, 600, 700 | 20–48px |
| Body / UI | **Manrope** | `--font-body` | 300, 400, 500, 600, 700 | 11–16px |
| Data / numbers / code | **IBM Plex Mono** | `--font-mono` | 400, 500 | 11–14px |
| Labels | IBM Plex Mono | — | 500, uppercase, tracked | 11–13px |

**Type scale** (all sizes available as tokens):

| Token | Size | Usage |
|---|---|---|
| `--text-xs` | 11px | Labels, badges, captions |
| `--text-sm` | 13px | Secondary text, table cells |
| `--text-base` | 14px | Default body text |
| `--text-md` | 16px | Emphasized body, icons |
| `--text-lg` | 20px | Card titles, h4 |
| `--text-xl` | 24px | Section titles, h3 |
| `--text-2xl` | 28px | Page titles, h2 |
| `--text-3xl` | 36px | Hero headings, h1 |
| `--text-4xl` | 48px | Marketing / landing headings |

**Letter spacing**:
- `--tracking-tighter: -0.025em` — large display headings
- `--tracking-tight: -0.01em` — standard headings
- `--tracking-normal: 0` — body text
- `--tracking-wide: 0.025em` — table headers
- `--tracking-wider: 0.05em` — uppercase labels

**Line heights**:
- `--leading-none: 1` — display text
- `--leading-tight: 1.25` — headings
- `--leading-snug: 1.375` — compact paragraphs
- `--leading-normal: 1.5` — body text (default)
- `--leading-relaxed: 1.75` — long-form reading

**Rationale**: **Sora** is a geometric grotesque with a confident, modern character that gives headings a distinct brand voice while staying highly readable. **Manrope** is a clean, slightly rounded sans-serif tuned for UI legibility at small sizes — warm without being soft. **IBM Plex Mono** for financial, numeric, and code fields improves scanability and column alignment while echoing the brand's open, civic-minded tone.

### 2.4 Iconography

- Use **Lucide** (open source, consistent, geometric, lightweight)
- 24px grid, 1.5px stroke weight
- Icons always paired with labels in primary navigation; standalone icons only in dense data tables with tooltips
- Never use icons as the sole affordance for destructive actions

### 2.5 Illustration & empty states

- Custom illustration style: **line art**, warm stroke colors, human silhouettes — not generic SaaS mascots
- Empty states tell a story: "No donors yet — your first campaign starts here." with a gentle call to action
- Error states: calm, constructive, never accusatory ("Something went wrong. We've been notified — try again in a moment.")

### 2.6 Motion & animation

| Token | Duration | Usage |
|---|---|---|
| `--duration-instant` | 75ms | Micro-interactions (checkbox, toggle) |
| `--duration-fast` | 100ms | Button feedback, hover states |
| `--duration-normal` | 150ms | Standard transitions |
| `--duration-slow` | 250ms | Panel reveals, page transitions |
| `--duration-slower` | 300ms | Modal entrance/exit |

**Easing curves**:
- `--ease-out` — entrances, expanding elements
- `--ease-in` — exits, collapsing elements
- `--ease-in-out` — continuous motion
- `--ease-spring` — playful micro-interactions (e.g., badge pop-in)
- `--ease-smooth` — general-purpose

**Rules**:
- Purposeful, not decorative. Every animation must reduce cognitive load, not add to it.
- No gratuitous loading spinners — use skeleton screens for content-heavy pages
- Use spring easing sparingly — this is a professional tool, not a game

**Loading & data-transition choreography** (cascade order, directional data-draw, ghost placeholders, refetch rules, modal replay) is codified in [ADR-035](adrs/adr-035-loading-motion-choreography.md) — the binding spec for any screen that loads or transitions data.

### 2.7 Shadows

| Token | Usage |
|---|---|
| `--shadow-xs` | Subtle depth (buttons, chips) |
| `--shadow-card` | Card elevation |
| `--shadow-md` | Raised elements (popovers) |
| `--shadow-elevated` | Elevated panels (dropdowns) |
| `--shadow-modal` | Modal/dialog overlays |
| `--shadow-card-hover` | Card hover lift effect |
| `--shadow-ring` | Focus state ring (primary color) |
| `--shadow-inset` | Pressed/inset states |

All shadows use cool-tinted `rgba(17, 24, 39, ...)` instead of pure black for a premium, cohesive feel.

### 2.8 Spacing

4px base grid. All spacing values available as `--space-{n}` tokens:

`0` · `1px` · `2px` · `4px` · `6px` · `8px` · `12px` · `16px` · `20px` · `24px` · `32px` · `40px` · `48px` · `56px` · `64px` · `72px` · `80px` · `96px`

### 2.9 Auth surface — marketing continuity

The pre-auth screens (login, signup, forgot/reset-password, invite-accept) and the Keycloak login theme are styled as a **continuation of the marketing site's hero** (website PR #24), not as a standalone product chrome. Three rules:

- **Background** — the marketing hero's cream (`--color-cream` = `oklch(0.965 0.012 86)`), warmer than the in-app `--color-background` (`#fcfbf9`). Used verbatim on the auth surface only.
- **Filigree waves** — a faithful port of the hero's drifting-wave backdrop: right-anchored inline SVG, teal→ember gradient (`--color-wave-deep` → `--color-ember`), `wave-drift` keyframe, plus a soft top-right ember glow. Pure SVG + CSS (no canvas, no JS) so the Keycloak theme stays GDPR-clean (LG München — no third-party scripts/fonts). Frozen under `prefers-reduced-motion`.
- **Flat card** — the auth card mirrors the marketing hero's dashboard card: a teal-16% hairline border (`--color-border-brand` = `oklch(0.545 0.115 178 / 0.16)`) and **no box-shadow**. It reads as part of the page, not a floating elevated panel.

Implemented in `packages/web/src/components/auth/auth-waves.tsx` + `auth-card.tsx` + the `(auth)` layout (SPA) and `infra/keycloak/themes/givernance/login/` (`template.ftl` markup + `givernance.css`). The previous interactive canvas icon-rain background was retired here.

### 2.10 Post-login continuity — the cohesion conventions

The authenticated app must read as **one continuous surface with the login card and the marketing hero**, not a stack of floating panels. The login card (§2.9) is the in-app gold standard. Seven north-star rules:

1. **Flat surfaces.** Cards, panels, table containers, and tabs sit *in* the page — no drop shadow on a resting surface. Separation comes from a hairline, not elevation.
2. **Teal-16% hairline is the surface-separation border.** `--color-border-brand` (`oklch(0.545 0.115 178 / 0.16)`) borders every card / panel / section / table container / resting overlay — the in-app equivalent of the marketing site's `--color-border`.
3. **Warm-grey outline is reserved for form controls only.** `--color-outline-variant` (`#c3c1bc`) is the border for input / textarea / select-trigger / checkbox / radio. That is the *only* correct grey-hairline use — a control wants a firmer edge than a surface.
4. **Soft shadow is reserved for genuinely-floating overlays.** One token, `--shadow-overlay`, on dropdown / popover / select-content / dialog / tooltip / toast / the mobile sidebar drawer. `--shadow-elevated` and `--shadow-modal` alias onto it; the old `--shadow-card` / `--shadow-kpi` grey rings are retired on resting surfaces.
5. **Softened contrast.** The "violence" was never text contrast (which passes AA) — it was heavy shadows, the raw `rgba(30,27,22,0.5)` modal scrim (now `--color-overlay` = `rgba(28,27,25,0.32)`), and saturated full-bleed banner fills (now soft `--color-banner-warning-bg` / `--color-banner-danger-bg`). Text tokens are unchanged, so every AA ratio is preserved or improved.
6. **Ember is a rare positive/brand accent only** (`bg-ember/15 text-ember-text`, the `accent` Badge variant). Never a status colour, never a default CTA — default actions stay teal `--color-primary`.
7. **One interaction curve, one duration.** All hover/press feedback uses `transition-colors duration-normal ease-out` (150ms, `cubic-bezier(0.16, 1, 0.3, 1)`); focus is the instant `focus-visible:shadow-ring`. The global `prefers-reduced-motion` block neutralises it.

**Two firm conventions for reviewers:** (1) `border-border-brand` for surfaces / `border-outline-variant` for inputs only; (2) `shadow-overlay` for floating overlays only — resting surfaces are flat. Applied across `components/ui/*`, `components/layout/*`, `components/shared/*`, and the operator screens under `app/(app)/**`. Donor-facing surfaces (`archetypes/**`, `app/(public)/**`, the donor donation form) keep their own per-template identities and are intentionally **out of scope**.

---

## 3. UI system & component design

### 3.1 Design tokens

All visual constants are managed as **CSS custom properties** in a single source of truth: `docs/design/shared/tokens.css`.

Token categories:
- **Colors** — primary, neutrals, red, amber, indigo, sky, navy, semantic aliases, surfaces, overlay
- **Typography** — font families, sizes (xs–4xl), weights (light–bold), line heights, letter spacing
- **Spacing** — 4px base grid (18 values from 0 to 96px)
- **Border radius** — sm (4px) through pill (9999px) and full (50%)
- **Shadows** — 8 levels from xs to modal, plus ring and inset
- **Motion** — 5 durations (instant–slower), 5 easing curves
- **Layout** — sidebar widths, topbar height, content max-widths, table row heights
- **Z-index** — 6 layers from base to tooltip
- **Component tokens** — focus ring, border width, transition shorthand, card padding

Tokens are consumed by:
- **CSS custom properties** (`docs/design/shared/tokens.css` — source of truth)
- **Tailwind CSS config** (via `tailwind.config.ts`, generated from tokens)
- **Figma** (via Token Studio plugin — source of truth is code, not Figma)

### 3.2 Component library

The design system includes these base components, all defined in `docs/design/shared/base.css`:

| Component | Variants | Notes |
|---|---|---|
| **Button** | primary, secondary, ghost, destructive | Sizes: sm, md, lg. States: loading, disabled. Icon button variant. |
| **Badge** | success, warning, error, info, neutral | Shapes: pill (default), square |
| **Alert** | success, warning, error, info | Left border accent + icon + content |
| **Card** | default, flat, linen, interactive | Interactive has hover lift effect |
| **Avatar** | green, amber, indigo, sky, red | Sizes: xs (20px), sm, md, lg, xl. Shapes: circle (default), rounded |
| **DataTable** | — | Sticky header, sortable columns, zebra stripes, compact row height |
| **StatWidget** | — | Large number + trend indicator + label |
| **Form inputs** | text, select, textarea | States: default, focus, error, success. Required label indicator. |
| **Tabs** | — | Bottom border indicator |
| **Progress** | default (green), amber | — |
| **Timeline** | — | Colored icons + connector lines |
| **Pagination** | — | Page buttons + info text |
| **Filter chips** | default, active | Pill-shaped |
| **Dropdown menu** | — | Items with icons, dividers, destructive variant |
| **Tooltip** | — | CSS-only via `data-tooltip` attribute |
| **Skeleton** | text, heading, avatar, card | Shimmer animation |
| **Empty state** | — | Icon + title + description + CTA |
| **Kanban board** | — | Columns + draggable cards |
| **Wizard steps** | — | Dot + label + connector |
| **Checklist** | — | Checkable items with completion state |

### 3.3 Layout principles

- **Sidebar navigation** (persistent, collapsible) — not top nav
- **Content max-width**: 1280px for list views, 800px for forms
- **Topbar**: sticky with glass-morphism blur effect (`backdrop-filter: blur(12px)`)
- **Density toggle**: users can switch between `comfortable` (48px rows) and `compact` (36px rows) density
- **Responsive**: fully functional on 1280px laptops; mobile sidebar slides in via overlay
- **Scrollbars**: thin, branded (neutral-300 thumb on transparent track)

### 3.4 Navigation architecture

```
Sidebar (primary)
├── Dashboard (org overview)
├── Constituents
│   ├── People
│   ├── Organizations
│   └── Households
├── Fundraising
│   ├── Donations
│   ├── Campaigns
│   └── Grants
├── Programs
│   ├── Beneficiaries
│   ├── Cases
│   └── Impact
├── Volunteers
│   ├── Profiles
│   └── Schedules
├── Communications
├── Reports
└── Settings (org admin only)
```

- Active section highlighted with a left accent bar (white on teal sidebar)
- Subtle `rgba(255,255,255,0.15)` background for active items
- Breadcrumbs on every sub-page
- Global search (`Cmd+K`) across all entity types

---

## 4. UX principles

### 4.1 Progressive disclosure

Show what the user needs, when they need it. Not everything at once.

- Record detail pages: summary first, then tabbed sections (Activity, Related, Documents)
- Forms: step-by-step for multi-field creations (e.g., new grant wizard), single-page for simple records
- Advanced filters collapsed by default; one-click to reveal
- Power-user features (bulk actions, data exports, GL posting) accessible but not foregrounded

### 4.2 AI-assisted interactions (KITT principle)

The AI layer inside Givernance should feel like a **quiet expert in the background** — not an intrusive chatbot.

- AI suggestions appear inline in context (e.g., "This donor hasn't given in 14 months — send a reactivation email?")
- Suggestion card: compact, dismissible, explains its reasoning in one sentence
- Never blocks the user — always an offer, never a gate
- Keyboard shortcut to accept / dismiss AI suggestions (`Y` / `N` / `Esc`)
- AI confidence visible when relevant: "High confidence based on 3 previous records"

### 4.3 Feedback and confirmation

- Every mutation gives immediate visual feedback (toast notification, inline state change)
- Destructive actions: two-step confirmation with consequence summary
- Async operations (PDF generation, bulk exports): progress indicator + notification on completion
- Form validation: real-time on blur, never on submit only
- Error messages: specific and actionable ("Email address is missing a domain" not "Invalid email")

### 4.4 Onboarding & first use

- Org setup wizard: 5 steps max, skippable, resumable
- First-time empty states: guided, with clear "what to do next"
- Contextual help: `?` icon on every section opens a panel with a 2-minute video or 3-step guide
- "Setup checklist" visible on dashboard until org has completed core configuration (constituents imported, one campaign created, GDPR consent settings reviewed)

### 4.5 Accessibility (non-negotiable)

| Requirement | Standard |
|---|---|
| Color contrast (text) | WCAG 2.1 AA minimum (4.5:1 normal text, 3:1 large) |
| Keyboard navigation | All interactive elements reachable and operable without mouse |
| Focus ring | Always visible — `--focus-ring` token provides consistent style |
| Screen reader support | ARIA labels on all interactive elements; landmark regions on all pages |
| Form labels | Always explicit `<label>` — never placeholder-only |
| Error identification | Errors announced to screen readers, not just shown visually |
| Skip navigation | "Skip to main content" link on every page |
| Text selection | Brand-tinted selection (`::selection`) for visual coherence |

---

## 5. UX research requirements

Before finalizing UI for any major module, run a lightweight research loop:

1. **Identify top 3 friction tasks** — what do users struggle with most in Salesforce or spreadsheets for this domain?
2. **Map interaction flows** — current vs. Givernance proposed; where do we save clicks?
3. **Prototype** — Figma mid-fidelity prototype; test with 2–3 NPO staff (recruited from target segment)
4. **Measure** — time-on-task, error rate, confidence rating (1–5)
5. **Iterate** — at least one revision cycle before dev handoff

Priority order for UX research sessions:
1. Constituent record creation + duplicate detection
2. Donation recording + receipt generation
3. Grant pipeline management
4. Beneficiary enrollment + case note entry
5. Volunteer shift scheduling

---

## 6. Design system governance

| Artifact | Owner | Location |
|---|---|---|
| Design tokens (source of truth) | Design Architect agent | `docs/design/shared/tokens.css` |
| Base component styles | Design Architect agent | `docs/design/shared/base.css` |
| Design system reference | Design Architect agent | `docs/design/design-system.html` |
| Component library (production) | Design Architect agent | `packages/ui/components/` |
| Storybook | Design Architect agent | `packages/ui/storybook/` |
| Figma file | Design Architect agent | Figma (linked in README) |
| UX research notes | Design Architect agent | `docs/ux-research/` |
| Accessibility audit | Design Architect agent | `docs/ux-research/a11y-audits/` |

**Process**:
- All new components proposed as GitHub issues with design spec + usage examples
- Component merged only with: (a) Storybook story, (b) accessibility check, (c) design review
- Breaking changes to tokens trigger a design system changelog entry

---

## 7. Anti-patterns (explicitly prohibited)

| Anti-pattern | Why |
|---|---|
| `outline: none` without visible focus replacement | Accessibility violation |
| Modal dialogs for forms with more than 3 fields | Cognitive overload; use a dedicated page |
| Success messages that auto-dismiss in < 4 seconds | User may miss them; 5s minimum or persistent |
| Placeholder text as the only label | Disappears on focus; inaccessible |
| Infinite scroll on financial data tables | Auditability requires pagination + page size |
| Gradient backgrounds on data-dense pages | Visual noise; reserve gradients for marketing surfaces |
| Icons without tooltip on icon-only buttons | Undiscoverable for non-power-users |
| "Are you sure?" generic confirmation dialogs | Tell the user exactly what will happen and what they'll lose |
| Color as sole semantic signal | Always pair with icon + text label |
| Pure black shadows | Use cool-tinted rgba(17,24,39,...) for cohesion |

---

## 8. White-label and theming

Givernance's design system is built theme-ready from day one:

- All brand colors expressed as CSS custom properties (overridable per tenant)
- **Logo slot in navigation sidebar — implemented (Epic #286)**: the sidebar reads `tenants.logo_asset_id` and renders the `sidebar` variant (128×128 WebP) above the bottom tenant-switcher dropdown. The same source asset feeds the public donation page hero, the postal-letter PDF, and the Keycloak login screen via four pre-generated variants. Full pipeline: [`docs/24-branding-assets.md`](./24-branding-assets.md).
- Custom domain support (no Givernance branding visible if tenant requests) — *deferred*
- Theme configuration stored in org settings; applied server-side to prevent flash — `theme_primary_color` already wired to Keycloak; tenant-level theming on the in-app shell is *deferred to v2*.

### 8.1 Initial-letter colored fallback (Slack pattern)

Tenants who skip the optional logo-upload step on onboarding don't land on a broken-looking empty state. The fallback is a **colored initial letter**, deterministic per tenant — the same Slack/Notion/Linear pattern.

The hash + palette rules:

- **Color seed**: stable hash of `tenant.id` (UUID v7 / v4 — the time prefix is irrelevant here, the hash is over the full bytes).
- **Palette**: 8 colors, all WCAG-AA against white text (4.5:1 minimum contrast), chosen to read as "professional but distinct" rather than "saturated and alarming." The palette is a token in the design system; consumers reference it by name (`--gv-tenant-fallback-1` … `--gv-tenant-fallback-8`).
- **Letter**: the first character of `tenant.name`, uppercased and locale-folded (German "ß" → "S", French "É" → "E"). Non-letter starts (digits, emoji, symbols) fall back to the literal character.
- **Shape**: rounded square (4px corner radius at `sidebar` size, 12px at `preview` size, 24px at `public-hero` size — proportional to the logo slot).
- **Determinism**: the same tenant gets the same color forever. Re-uploading and removing a logo does not change the fallback color when the logo is gone again — the operator sees their tenant's "color identity" even before they upload anything.

The fallback is the same component everywhere it renders: sidebar, tenant-switcher card, onboarding mock-preview, and (gradient + initial overlay) the public donation page hero when `tenants.logo_asset_id IS NULL`. Operators who never upload a logo land on a usable, branded-feeling empty state instead of "where the logo would go" placeholder text.

---

## 9. Vision future — Mode Conversationnel

Au-dela du KITT principle (suggestions IA inline dans le GUI classique), Givernance explore un paradigme **conversationnel et agentique** : un agent IA en langage naturel qui peut orchestrer des actions, afficher des resultats inline (graphiques, tableaux, formulaires), et reduire la friction de navigation entre modules.

Ce mode conversationnel utilise les memes composants UI (DataTable, StatWidget, etc.) invoques dynamiquement dans un flux de chat, en complement du GUI structure existant.

Voir : [docs/vision/conversational-mode.md](./vision/conversational-mode.md) pour la vision complete, et `docs/design/conversational-mode/` pour les 11 mockups exploratoires.

---

*This document is owned by the Design Architect agent and reviewed collaboratively with Platform Architect and Domain Analyst.*
