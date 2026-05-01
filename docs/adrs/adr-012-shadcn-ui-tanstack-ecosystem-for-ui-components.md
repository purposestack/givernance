## ADR-012: shadcn/ui + TanStack Ecosystem for UI Components

- **Status**: Accepted
- **Date**: 2026-04-16
- **Deciders**: Magino (founder/architect) + Claude agents (architecture review)

### Context

Givernance's frontend (Next.js 16, React 19, Tailwind CSS v4) must render 84+ screens across 17 domain modules — from dense financial data tables and multi-step grant wizards to inline AI suggestion cards. The existing design system is mature: 366-line `tokens.css` (CSS custom properties for colors, typography, spacing, shadows, motion), 2,000+ line `base.css` component styles, and 97 interactive HTML mockups defining the Material You Warm visual language.

Key constraints driving this decision:

1. **White-label readiness**: Every color must resolve through CSS custom properties in `@theme` — no default Tailwind palette colors permitted anywhere in the codebase
2. **WCAG 2.1 AA accessibility**: Non-negotiable for NPO staff who are not power users — keyboard navigation, screen reader support, focus management, and ARIA compliance on every interactive element
3. **Colorblind-safe semantics**: Indigo for destructive/error states (not red/green pairs); color is never the sole signal — always paired with icon + text label
4. **Density modes**: All data-heavy components must support `comfortable` (48px rows) and `compact` (36px rows) density
5. **Financial data integrity**: Pagination required on all financial tables — infinite scroll explicitly prohibited (see `11-design-identity.md` section 7 anti-patterns)
6. **TypeBox schema reuse**: Form validation schemas defined once in `@givernance/shared/validators` must flow through to frontend form validation without duplication

### Decision

Adopt a **four-library frontend component stack** (note: TanStack Query v5 for server data caching is decided in ADR-011 as part of state management, not repeated here):

1. **shadcn/ui** — UI primitive layer (code-ownership model)
2. **@tanstack/react-table v8** — headless data table engine
3. **React Hook Form + @hookform/resolvers/typebox** — form state management with shared schema validation
4. **lucide-react** — icon library

#### 1. shadcn/ui (UI Primitives)

Copy shadcn/ui components into the repository (`components/ui/`) and own every line. Components are built on **Radix UI** accessibility primitives and restyled to match Givernance's Material You Warm design tokens exactly.

**Component hierarchy**:

```
components/
├── ui/                  ← shadcn/ui primitives (Button, Dialog, Select, Tabs, Tooltip, etc.)
├── data/                ← Data composites (DataTable, StatWidget, DonorTimeline, etc.)
├── forms/               ← Form composites (FormSection, ConstituentForm, DonationWizard, etc.)
└── layout/              ← Layout composites (Sidebar, Topbar, CommandPalette, PageShell, etc.)
```

- **Tier 1 — UI Primitives** (`components/ui/`): Direct shadcn/ui components restyled with Givernance tokens. These are generic, reusable, and have no domain knowledge.
- **Tier 2 — Composites** (`components/data/`, `forms/`, `layout/`): Domain-specific components that compose Tier 1 primitives. Examples: `ConstituentCard` composes `Card` + `Avatar` + `Badge`; `CampaignProgress` composes `Progress` + `StatWidget`.

**Token integration**: shadcn/ui's default CSS variables are replaced entirely with Givernance's `tokens.css` custom properties. The `components.json` configuration points Tailwind to the project's custom theme — no `slate`, `zinc`, or `neutral` from the default palette.

#### 2. @tanstack/react-table v8 (Data Tables)

Headless table engine providing sort, filter, pagination, row selection, and column visibility — with zero rendering opinions. The visual layer is implemented using Givernance's `DataTable` composite component, which applies:

- Sticky headers with `backdrop-filter: blur(12px)` glass effect
- Zebra striping using `--color-neutral-50` alternation
- Density toggle (`comfortable` / `compact` via `--table-row-height` token)
- Server-side pagination with configurable page sizes (25 / 50 / 100)
- Monospace font (`--font-mono`, JetBrains Mono) for financial columns
- Sort indicators with Lucide `arrow-up` / `arrow-down` icons

**Pagination is mandatory on all financial data tables.** Infinite scroll is explicitly prohibited — auditability requires deterministic page boundaries (see `11-design-identity.md` section 7 anti-patterns).

#### 3. React Hook Form + @hookform/resolvers/typebox (Forms)

Form state management using React Hook Form with TypeBox schema validation, enabling a **single source of truth** for data contracts:

```
@givernance/shared/validators/donation.ts (TypeBox schema)
  → API route: Fastify request validation + OpenAPI 3.1 generation
  → Frontend form: React Hook Form validation via @hookform/resolvers/typebox
```

Configuration:
- Validation mode: `onBlur` — validates each field when the user leaves it, never on keystroke (reduces noise) and never only on submit (too late)
- Server error mapping: RFC 9457 `fieldErrors` from API responses are mapped to form fields via `setError()`, providing inline server-side validation feedback
- Multi-step forms (grant wizard, constituent create): each step validates its own TypeBox sub-schema independently before allowing progression

#### 4. lucide-react (Icons)

Tree-shakeable icon library providing named SVG imports. Only icons actually used are included in the bundle — no variable font download.

- Grid: 24px
- Stroke weight: 1.5px (matches design spec in `11-design-identity.md` section 2.4)
- Native shadcn/ui integration (icons used directly in Button, Alert, Badge, etc.)
- Consistent with the 97 existing HTML mockups which already use Lucide CDN

### Rationale

#### Why shadcn/ui over alternatives

| Criterion | shadcn/ui + Radix | Headless UI (Tailwind Labs) | Ant Design | Material UI | Build from scratch |
|---|---|---|---|---|---|
| **Code ownership** | Full — components copied into repo, every line editable | Full — headless primitives | None — import from `antd`, override via `ConfigProvider` | None — import from `@mui`, override via `createTheme` | Full |
| **Accessibility** | Radix UI primitives — WAI-ARIA compliant, focus trap, keyboard nav, screen reader tested | Good — built by Tailwind Labs | Mixed — some components lack ARIA compliance | Good — follows Material spec | Must build from scratch |
| **Tailwind v4 compatibility** | Native — designed for Tailwind | Native | Poor — CSS-in-JS (Emotion) conflicts with Tailwind utility model | Poor — Emotion/styled-components, theme provider conflicts | N/A |
| **White-label theming** | CSS custom properties — drop-in token replacement | CSS custom properties | `ConfigProvider` + `antd-style` — complex, leaks default styles | `createTheme` — deep but opinionated | Full control |
| **Bundle size** | Tree-shakeable, only imported components included | Minimal | ~1.2 MB minified (full import), heavy even with tree-shaking | ~300 KB+ for core, Emotion runtime overhead | Minimal |
| **Design language** | Neutral — adapts to any design system | Neutral | Opinionated Ant style — fighting it is constant work | Opinionated Material — requires heavy override for non-Material designs | Any |
| **React 19 / RSC support** | Yes — `"use client"` only where needed | Yes | Partial — many components require client-side rendering | Partial — Emotion SSR complexity | Must implement |
| **Community + ecosystem** | 75k+ GitHub stars, 100+ components, active maintenance | Smaller component set (~15 primitives) | Massive (Chinese enterprise ecosystem) | Massive (Google-backed) | None |
| **Verdict** | **Selected** | Good primitives but fewer components; would need to build more composites | Rejected — CSS-in-JS conflicts, opinionated style, heavy bundle | Rejected — CSS-in-JS conflicts, Material design language fights Givernance identity | Rejected — 6+ months to reach shadcn/ui parity on accessibility alone |

#### Why @tanstack/react-table over alternatives

| Criterion | @tanstack/react-table v8 | AG Grid | Mantine DataTable |
|---|---|---|---|
| **Rendering model** | Headless — full visual control | Opinionated grid with theme API | Mantine-styled — tied to Mantine theme |
| **Givernance token integration** | Direct — render layer uses Tailwind + design tokens | Theme override required, AG Grid CSS fights custom styles | Requires Mantine `MantineProvider`, separate from Tailwind |
| **Server-side pagination** | Native — `manualPagination`, `pageCount`, `onPaginationChange` | Native | Native |
| **Bundle size** | ~15 KB (headless core) | ~200 KB+ (community), ~1 MB+ (enterprise) | ~50 KB + Mantine core dependency |
| **License** | MIT | Community: MIT, Enterprise: paid (features like row grouping, pivoting) | MIT |
| **Financial table fit** | Excellent — monospace columns, custom cell renderers, controlled pagination | Excellent — but visual override cost is high | Good — but Mantine style dependency |
| **Verdict** | **Selected** | Rejected — too heavy, visual lock-in, enterprise features not needed at Phase 1 | Rejected — introduces Mantine as a parallel design system |

#### Why React Hook Form + TypeBox over alternatives

| Criterion | React Hook Form + TypeBox | Formik | Native React forms |
|---|---|---|---|
| **Performance** | Uncontrolled inputs — minimal re-renders | Controlled inputs — re-renders entire form on every change | Depends on implementation |
| **Schema reuse** | `@hookform/resolvers/typebox` — validates with the same TypeBox schemas used by Fastify routes | Yup/Zod schemas — separate from TypeBox API schemas, duplication risk | Manual validation — full duplication |
| **Bundle size** | ~9 KB (RHF) + ~2 KB (resolver) | ~13 KB | 0 KB |
| **Server error integration** | `setError()` API maps RFC 9457 `fieldErrors` directly to fields | `setFieldError()` — similar capability | Manual state management |
| **Multi-step forms** | Built-in — each step is a separate `useForm()` or sub-schema validation | Possible but verbose | Manual orchestration |
| **TypeScript DX** | Excellent — form values inferred from TypeBox schema type | Good with Yup, weaker with plain objects | Manual typing |
| **Verdict** | **Selected** | Rejected — heavier, controlled re-renders, separate schema system | Rejected — no schema reuse, no built-in validation lifecycle |

#### Why lucide-react over alternatives

| Criterion | lucide-react | Material Symbols | Heroicons | Phosphor Icons |
|---|---|---|---|---|
| **Bundle strategy** | Named imports — tree-shakeable, only used icons in bundle | Variable font — ~300 KB download regardless of usage | Named imports — tree-shakeable | Named imports — tree-shakeable |
| **Icon count** | 1,500+ | 3,000+ | ~300 | 1,200+ |
| **Grid / stroke** | 24px / 1.5px — matches design spec | 24px / variable weight — configurable but heavier | 24px / 1.5px or 2px | 24px / variable weight |
| **shadcn/ui integration** | Native — shadcn/ui uses Lucide by default | None — must configure separately | Partial — some shadcn forks use Heroicons | None — must configure separately |
| **Consistency with mockups** | Direct match — 97 HTML mockups already use Lucide CDN | Would require icon remapping across all mockups | Different icon set — visual inconsistency | Different icon set — visual inconsistency |
| **Verdict** | **Selected** | Rejected — 300 KB font download, no tree-shaking, mockup inconsistency | Rejected — too small a set (300 icons), partial shadcn compatibility | Rejected — good alternative but no native shadcn integration, mockup inconsistency |

### Consequences

- ✅ **Code ownership**: Every UI component lives in the repository — no upstream dependency can break the design or introduce breaking changes
- ✅ **Single validation source of truth**: TypeBox schemas in `@givernance/shared/validators` are used by Fastify routes (API validation + OpenAPI generation) and React Hook Form (frontend validation) — zero schema duplication
- ✅ **Full visual control**: Headless primitives (Radix UI, TanStack Table) render through Givernance's token system — white-label theming requires only `tokens.css` override, no library-specific theme configuration
- ✅ **Accessibility baseline**: Radix UI provides WAI-ARIA compliant focus management, keyboard navigation, and screen reader support out of the box — the team builds on top of tested primitives rather than implementing ARIA from scratch
- ✅ **Mockup continuity**: The 97 existing HTML mockups already use Lucide icons and the same visual patterns — migration to React components is a 1:1 translation, not a redesign
- ✅ **Bundle efficiency**: Tree-shakeable icons (Lucide) + headless table (~15 KB) + uncontrolled forms (RHF ~9 KB) — no large framework runtime overhead
- ⚠️ **shadcn/ui update friction**: Because components are copied (not imported), upstream improvements require manual cherry-picking — the team must periodically review shadcn/ui releases for accessibility fixes and new primitives
- ⚠️ **Radix UI version coupling**: shadcn/ui components depend on specific Radix UI primitive versions — major Radix updates may require coordinated component updates
- ⚠️ **TypeBox resolver maturity**: `@hookform/resolvers/typebox` is less widely used than the Zod resolver — edge cases in complex nested schemas may require custom resolver patches
- ⚠️ **Component build-out effort**: shadcn/ui provides ~40 primitives; Givernance needs ~25 domain composites (DataTable, ConstituentCard, DonorTimeline, CampaignProgress, etc.) — these must be designed and built by the team
- ⚠️ **AI suggestion card XSS risk**: AI-generated content rendered in suggestion cards must never use `dangerouslySetInnerHTML`. All AI output must be rendered as plain text or through a sanitization layer (e.g., DOMPurify) to prevent stored XSS from model outputs. See `13-ai-modes.md` for AI output policy.
- ⚠️ **CSP compatibility**: Radix UI primitives use inline styles for positioning (popovers, tooltips, dropdown menus). A Content Security Policy with `style-src 'unsafe-inline'` may be required, or a nonce-based CSP strategy must be adopted. Evaluate CSP impact during Phase 1 deployment.
- ⚠️ **Dependency scanning**: shadcn/ui components are copied into the repository but still depend on Radix UI npm packages as runtime dependencies. These must be included in the SBOM and scanned for CVEs in CI, consistent with `06-security-compliance.md` requirements.

### Revisit Criteria

- shadcn/ui abandons Radix UI as its accessibility foundation — re-evaluate primitive layer
- React 20+ introduces built-in form primitives that obsolete React Hook Form
- A headless component library emerges with significantly better RSC support or accessibility coverage
- TanStack Table v9 introduces breaking API changes — evaluate migration cost vs alternatives
- Bundle size analysis at Phase 2 reveals unexpected bloat from the component stack

---

