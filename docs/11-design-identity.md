# 11 — Design Identity, UI & UX

> **Givernance NPO Platform** — A platform that feels like it was built for people, not for systems.
> Last updated: 2026-03-17

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

#### Core palette

| Role | Name | Token | Hex | Usage |
|---|---|---|---|---|
| Primary | Givernance Green | `--color-primary` | `#2E7D5E` | Brand identity, CTAs, active nav states |
| Primary light | Sage | `--color-primary-light` | `#4CAF82` | Success badges (with icon) |
| Primary dark | Forest | `--color-primary-dark` | `#1A5240` | Text on light bg, deep brand accents |
| Primary hover | — | `--color-primary-hover` | `#267052` | Button/link hover states |
| Primary active | — | `--color-primary-active` | `#1F5C44` | Button/link pressed states |
| Primary 50 | Mint | `--color-primary-50` | `#E8F5EE` | Focus rings, success backgrounds |
| Primary 100 | — | `--color-primary-100` | `#C8E6D7` | Subtle borders, success alert borders |

#### Neutral palette (warm stone)

| Token | Name | Hex | Usage |
|---|---|---|---|
| `--color-neutral-50` | Warm White | `#FAFAF8` | Page backgrounds |
| `--color-neutral-100` | Linen | `#F2F0EC` | Card surfaces, panel backgrounds |
| `--color-neutral-200` | Stone | `#E4E0D9` | Borders, dividers |
| `--color-neutral-300` | Pebble | `#D1CCC4` | Disabled borders, scrollbar thumbs |
| `--color-neutral-400` | Ash | `#A8A29E` | Muted text, placeholders |
| `--color-neutral-500` | Dusk | `#8A857E` | — |
| `--color-neutral-600` | Slate | `#6B6760` | Secondary text |
| `--color-neutral-700` | Shadow | `#4A4742` | — |
| `--color-neutral-800` | Charcoal | `#2E2C28` | Dark UI surfaces |
| `--color-neutral-900` | Ink | `#1C1B19` | Primary body text |

#### Semantic colors

| Role | Token | Hex | Light / 50 | Usage |
|---|---|---|---|---|
| Success | `--color-success` → `--color-primary-light` | `#4CAF82` | `#E8F5EE` | Positive outcomes, completed states |
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
| `--color-surface-alt` | `#F2F0EC` | Alternate surface |
| `--color-surface-raised` | `#FFFFFF` | Elevated surfaces |
| `--color-surface-sunken` | `#F2F0EC` | Inset/recessed areas |
| `--color-overlay` | `rgba(28, 27, 25, 0.5)` | Modal/drawer backdrops |

**Rationale**: Warm off-whites and organic greens evoke sustainability, trust, and care. Error and destructive states use **red** (`#DC2626`) — a universally understood danger signal. Red is always paired with icons and text labels to ensure accessibility for all color vision types. Indigo is retained as a decorative accent, not a semantic signal.

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
| Forest `#1A5240` on white | ~7.5:1 | AAA |
| Primary `#2E7D5E` on white | ~4.6:1 | AA (large text) |
| Ink `#1C1B19` on Warm White `#FAFAF8` | ~16:1 | AAA |
| Red `#DC2626` on white | ~4.5:1 | AA |
| Red Dark `#991B1B` on white | ~7.8:1 | AAA |

**Colorblind simulation**: Every UI screen must be reviewed through a deuteranopia simulation before design handoff.

### 2.3 Typography

| Role | Font | Token | Weights | Size range |
|---|---|---|---|---|
| Headings | **Instrument Serif** (Lora fallback) | `--font-heading` | 400 | 20–48px |
| Body / UI | **Inter** | `--font-body` | 300, 400, 500, 600, 700 | 11–16px |
| Data / numbers | **JetBrains Mono** | `--font-mono` | 400, 500 | 11–14px |
| Labels | Inter | — | 500, uppercase, tracked | 11–13px |

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

**Rationale**: A serif heading font adds warmth and editorial quality without sacrificing readability. Inter is the gold standard for UI legibility. Monospace for financial and data fields improves scanability.

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

All shadows use warm-tinted `rgba(28, 27, 25, ...)` instead of pure black for a premium, cohesive feel.

### 2.8 Spacing

4px base grid. All spacing values available as `--space-{n}` tokens:

`0` · `1px` · `2px` · `4px` · `6px` · `8px` · `12px` · `16px` · `20px` · `24px` · `32px` · `40px` · `48px` · `56px` · `64px` · `72px` · `80px` · `96px`

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

- Active section highlighted with a left accent bar (white on green sidebar)
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
| Pure black shadows | Use warm-tinted rgba(28,27,25,...) for cohesion |

---

## 8. Future: white-label and theming

Givernance's design system is built theme-ready from day one:

- All brand colors expressed as CSS custom properties (overridable per tenant)
- Logo slot in navigation sidebar (org logo replaces Givernance logo for white-label partners)
- Custom domain support (no Givernance branding visible if tenant requests)
- Theme configuration stored in org settings; applied server-side to prevent flash

This is a v2 feature but the architecture must not foreclose it.

---

## 9. Vision future — Mode Conversationnel

Au-dela du KITT principle (suggestions IA inline dans le GUI classique), Givernance explore un paradigme **conversationnel et agentique** : un agent IA en langage naturel qui peut orchestrer des actions, afficher des resultats inline (graphiques, tableaux, formulaires), et reduire la friction de navigation entre modules.

Ce mode conversationnel utilise les memes composants UI (DataTable, StatWidget, etc.) invoques dynamiquement dans un flux de chat, en complement du GUI structure existant.

Voir : [docs/vision/conversational-mode.md](./vision/conversational-mode.md) pour la vision complete, et `docs/design/conversational-mode/` pour les 11 mockups exploratoires.

---

*This document is owned by the Design Architect agent and reviewed collaboratively with Platform Architect and Domain Analyst.*
