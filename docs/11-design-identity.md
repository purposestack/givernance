# 11 — Design Identity, UI & UX

> **Givernance NPO Platform** — A platform that feels like it was built for people, not for systems.
> Last updated: 2026-02-26

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

| Role | Name | Hex | Usage |
|---|---|---|---|
| Primary | Givernance Green | `#2E7D5E` | Brand identity, CTAs, active nav states |
| Primary light | Sage | `#4CAF82` | Hover states, success badges (with icon) |
| Primary dark | Forest | `#1A5240` | Text on light bg, deep brand accents |
| Neutral 50 | Warm White | `#FAFAF8` | Page backgrounds |
| Neutral 100 | Linen | `#F2F0EC` | Card surfaces, panel backgrounds |
| Neutral 200 | Stone | `#E4E0D9` | Borders, dividers |
| Neutral 600 | Slate | `#6B6760` | Secondary text, placeholders |
| Neutral 900 | Ink | `#1C1B19` | Primary body text |
| Accent 1 | Amber | `#D97706` | Warnings, fundraising highlights |
| Accent 2 | Indigo | `#5B4FD4` | Destructive actions, error states |
| Accent 3 | Sky | `#2E79A6` | Info states, links, grant-related contexts |

**Rationale**: Warm off-whites and organic greens evoke sustainability, trust, and care. The previous palette used a terracotta/red accent for destructive states — this has been replaced with **indigo** to eliminate the red/green conflict that affects users with deuteranopia (red-green color blindness, ~8% of men). Indigo is clearly distinguishable from forest green for all major color blindness types, while maintaining a warm, non-corporate feel.

### 2.2.1 Color accessibility constraints ⚠️

**Color must never be the sole means of conveying information.** This is both a WCAG 2.1 requirement (criterion 1.4.1) and a design quality standard.

| Rule | Implementation |
|---|---|
| Status badges | Always pair color with an icon (✓ ✕ ⚠ ℹ) AND a text label |
| Form validation | Error highlighted in border color + icon + text message below the field |
| Chart data series | Use color + pattern or color + direct label (never color-only legends) |
| Green vs. anything | Never use forest green and another color as the only distinction for semantic meaning |
| Destructive actions | Indigo badge/button + trash/warning icon + explicit label |

**Colorblind simulation**: Every UI screen must be reviewed through a deuteranopia simulation (available in Figma, Chrome DevTools, and macOS Accessibility Inspector) before design handoff.

**Safe color pairs** (distinguishable across common colorblindness types):

| Use case | Color | Works because |
|---|---|---|
| Brand / CTA | Givernance Green `#2E7D5E` | Brand color, not a semantic status signal alone |
| Warning | Amber `#D97706` | Yellow-orange — clearly distinct for all types |
| Error / Destructive | Indigo `#5B4FD4` | Blue-violet — clearly distinct from green for all types |
| Info | Sky `#2E79A6` | Blue — distinguishable from green even for deuteranopes |
| Neutral state | Stone `#E4E0D9` | Achromatic — safe for all |

### 2.3 Typography

| Role | Font | Weight | Size range |
|---|---|---|---|
| Headings | **Instrument Serif** (or Lora as fallback) | 400, 600 | 20–36px |
| Body / UI | **Inter** | 400, 500, 600 | 13–16px |
| Data / numbers | **JetBrains Mono** (or Tabular Inter) | 400 | 12–14px |
| Labels | Inter | 500, uppercase, tracked | 11–12px |

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

- Purposeful, not decorative. Every animation must reduce cognitive load, not add to it.
- Transition duration: 150–200ms for micro-interactions, 250–300ms for page transitions
- Easing: `ease-out` for entrances, `ease-in` for exits
- No gratuitous loading spinners — use skeleton screens for content-heavy pages
- No bounce, no elastic — this is a professional tool

---

## 3. UI system & component design

### 3.1 Design tokens

All visual constants are managed as **design tokens** in a single source of truth:

```
/design-system/tokens/
  colors.json       → all palette values
  typography.json   → font sizes, weights, line-heights
  spacing.json      → 4px base grid (4, 8, 12, 16, 24, 32, 48, 64)
  radius.json       → border radii (4px sm, 8px md, 12px lg, 9999px pill)
  shadows.json      → elevation levels (1–4)
  motion.json       → durations, easings
```

Tokens are consumed by:
- **Tailwind CSS config** (via `tailwind.config.ts`)
- **CSS custom properties** (for Storybook and native elements)
- **Figma** (via Token Studio plugin — source of truth is code, not Figma)

### 3.2 Component library (shadcn/ui foundation)

Built on **shadcn/ui** with Givernance-specific overrides. Every component lives in `packages/ui/` and is:
- Headless by default (styled via Tailwind variants)
- Accessible (ARIA, keyboard navigation, focus ring visible at all times)
- Themeable (dark mode ready from day one, even if not shipped in v1)

Key components requiring Givernance-specific design:

| Component | Design note |
|---|---|
| **DataTable** | Dense but breathable; row hover subtle; sticky header; column sorting visible |
| **Card** | Warm background, gentle shadow, clearly delineated sections |
| **StatWidget** | Large number, contextual trend indicator, always labeled |
| **DonorTimeline** | Chronological, scannable, color-coded by event type |
| **ConstituentCard** | Photo placeholder with initials fallback; relationship badges |
| **CampaignProgress** | Warm progress bar (green fill), milestone markers, goal label |
| **GrantStatusBadge** | Color-coded pipeline stage pill; never just a raw string |
| **NavigationSidebar** | Collapsed to icons on small screens; active section clearly highlighted |
| **CommandPalette** | `Cmd+K` global search; constituent/donation/grant quick access |
| **FormSection** | Grouped fields with a heading and helper text; errors inline not modal |

### 3.3 Layout principles

- **Sidebar navigation** (persistent, collapsible) — not top nav. NPO users live in the app; sidebar orientation reduces accidental back-navigation.
- **Content max-width**: 1280px for list views, 800px for forms and detail views (no sprawling full-width forms)
- **Density toggle**: users can switch between `comfortable` (default) and `compact` density for data tables
- **Responsive**: fully functional on 1280px laptops (most NPO hardware); tablet support for volunteer and beneficiary portals
- **Mobile**: limited scope — receipts viewing, quick donation recording, volunteer hour log. Full data entry is desktop-first.

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

- Active section highlighted with a left accent bar (Givernance Green)
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
| Focus ring | Always visible, never hidden with `outline: none` without replacement |
| Screen reader support | ARIA labels on all interactive elements; landmark regions on all pages |
| Form labels | Always explicit `<label>` — never placeholder-only |
| Error identification | Errors announced to screen readers, not just shown visually |
| Skip navigation | "Skip to main content" link on every page |

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
| Design tokens | Design Architect agent | `packages/ui/tokens/` |
| Component library | Design Architect agent | `packages/ui/components/` |
| Storybook | Design Architect agent | `packages/ui/storybook/` |
| Figma file | Design Architect agent | Figma (linked in README) |
| UX research notes | Design Architect agent | `docs/ux-research/` |
| Accessibility audit | Design Architect agent | `docs/ux-research/a11y-audits/` |
| Brand guidelines PDF | Design Architect agent | `docs/brand/` |

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

---

## 8. Future: white-label and theming

Givernance's design system is built theme-ready from day one:

- All brand colors expressed as CSS custom properties (overridable per tenant)
- Logo slot in navigation sidebar (org logo replaces Givernance logo for white-label partners)
- Custom domain support (no Givernance branding visible if tenant requests)
- Theme configuration stored in org settings; applied server-side to prevent flash

This is a v2 feature but the architecture must not foreclose it.

---

---

## 9. Vision future — Mode Conversationnel

Au-delà du KITT principle (suggestions IA inline dans le GUI classique), Libero explore un paradigme **conversationnel et agentique** : un agent IA en langage naturel qui peut orchestrer des actions, afficher des résultats inline (graphiques, tableaux, formulaires), et réduire la friction de navigation entre modules.

Ce mode conversationnel utilise les mêmes composants UI (DataTable, StatWidget, etc.) invoqués dynamiquement dans un flux de chat, en complément du GUI structuré existant.

Voir : [docs/vision/conversational-mode.md](./vision/conversational-mode.md) pour la vision complète, et `docs/design/conversational-mode/` pour les 11 mockups exploratoires.

---

*This document is owned by the Design Architect agent and reviewed collaboratively with Platform Architect and Domain Analyst.*
