# Public donation page — competitive teardown & archetype shortlist

> Spike artifact for [Epic #362 — Public donation page · multiple style presets](https://github.com/purposestack/givernance/issues/362). Reviewed alongside [ADR-030](../adrs/adr-030-public-page-style-archetypes.md) and the reference mockup `docs/design/donations/public-foundation.html`.

---

## 0. Why this exists — at a glance

The Givernance public donation page today is one fixed layout. Two NPOs running campaigns on Givernance get visually-identical donor surfaces: same hero proportions, same amount-picker grid, same typography rhythm, same footer order. [Epic #286](https://github.com/purposestack/givernance/issues/286) swaps the logo and the primary colour — useful, but a donor scrolling between an environmental foundation and a grassroots activist appeal still feels they're on "the Givernance platform."

This document is the **research half** of the spike — competitive survey + the 10 archetypes we plan to ship — so a non-engineer (operator, designer, prospect) can read it and understand which page-personality belongs to which NPO and *why*. The **architecture half** lives in [ADR-030](../adrs/adr-030-public-page-style-archetypes.md).

The user can pick from 10 distinct visual archetypes. Branding tokens ([Epic #286](https://github.com/purposestack/givernance/issues/286)) compose on top — same archetype, different primary colour, different logo, different hero crop. **The archetype controls structure, typography, illustration motif, and motion; the brand controls colour and identity.** A clean split keeps the operator's mental model simple: "what voice?" vs. "what brand?"

---

## 1. Competitive teardown — what we surveyed and why each one mattered

We looked at the patterns rather than the brands. The interesting questions for a curated preset library are:

- **What is the dominant element above the fold?** A photograph, a quote, a number, a form, a logo?
- **How does the page treat the *amount*?** Big-number-first, gridded chips, slider, write-in, recurring-first?
- **What's the page's emotional posture?** Restrained, urgent, hopeful, joyful, civic, intimate?
- **How does it scale on mobile?** Stacks gracefully, hides the hero, switches to a sticky CTA?
- **Where does social proof sit?** Donor list, counter, testimonials, none?

### 1.1 Surveyed surfaces

| Platform | What we noticed | Useful for |
|---|---|---|
| **Stripe Payment Links** | Single column, no hero. Amount picker is *the* surface. Typography is restrained (Stripe's "Sohne"-feel sans). Mobile-first by construction. | The "Minimal Checkout" archetype — when a donor already trusts the org and you don't need a pitch. |
| **Donorbox** | Embeddable widget, conservative. Amount chips + recurring toggle as twin first-class controls. Conservative photography. | The "Foundation" archetype — institutional default, doesn't fight the host site. |
| **Givebutter** | Storytelling-first. Hero photo, supporter feed, live donation ticker, friendly tone. | The "Activist" archetype — when emotional energy matters. |
| **JustGiving** | Long-form scroll. Heavy on testimonial photography and beneficiary stories. | The "Editorial Story" archetype — beneficiary-driven pitches. |
| **GoFundMe** | Hero photo + giant counter. Strong colour saturation. The counter *is* the hero. | The "Emergency Appeal" archetype — disasters, urgent fundraisers. |
| **HelloAsso** (EU/FR) | Civic, neutral colour palette, French-administration-adjacent. Strong on transparency / receipt copy. | The "Civic Modern" archetype — French NPOs adjacent to public-sector partners. |
| **WWF / Médecins Sans Frontières landing pages** | Editorial typography, large photo essays, restrained palette dominated by one brand colour. | Reference for the photo-driven archetypes. |
| **joinritmo.com** (referenced by product) | Big editorial type, soft pastel washes, animated gradient hero, single dominant CTA. | The "Calm Wellness" archetype — for mental-health, ecology, mindfulness-adjacent orgs. |
| **awwwards.com / dribbble modern-website** | Currently fashionable: brutalist mono type, deliberate misalignments, oversized numerals, hyper-saturated gradients, scroll-driven motion. | The "Neo-Brutalist" and "Cosmic Gradient" archetypes — younger / arts-adjacent orgs comfortable taking visual risks. |

### 1.2 Cross-cutting observations

1. **Amount picker dominates conversion.** Every platform we looked at gives the donation amount more visual real estate than the campaign description. A theme that buries the amount loses the donor. → Every archetype must surface 3–5 preset amounts and a write-in within the first viewport.
2. **The recurring toggle is contested real estate.** Donorbox and Givebutter give it twin-pill prominence next to one-time. JustGiving hides it inside a secondary screen. Stripe Payment Links require it to be configured by the operator and never expose it to the donor. → We expose it for every archetype but two (`Minimal Checkout` and `Foundation Default`) place it inline; others (`Activist`, `Emergency Appeal`) make it a deliberate second step so the urgency framing isn't undermined.
3. **Mobile is not "desktop, smaller."** GoFundMe's mobile experience is essentially a different page — the photo is cropped tight, the counter is the entire hero, and the form sticks to the bottom. → Each archetype gets a designed mobile breakpoint, not a CSS shrink.
4. **Photography is the most expensive variable.** Archetypes that depend on a single dominant photograph (`Editorial Story`, `Emergency Appeal`) fall apart when the NPO doesn't have one. → Photo-dependent archetypes degrade gracefully to a CSS-art "scene" when no hero image is configured. This is one of the reasons we did NOT make this Epic also ship per-campaign hero images — that's [Epic #286](https://github.com/purposestack/givernance/issues/286)'s territory, and we want to ship the picker before the photo pipeline.
5. **Typography is the cheapest differentiator.** Swapping a serif display face for a mono display, or pairing a humanist sans with a heavy slab, transforms the page far more than colour does. → Each archetype's typography pairing is its **identity contract** — bigger lever than the colour palette.

---

## 2. The 10 archetypes — shortlist

We ended up at 10 (the Epic asked for 3–5; the product directive asked for 10 — and the headroom is justified because each archetype lives in a different emotional quadrant, not a different colour palette). Each archetype below has a one-paragraph **brief** that an operator can read in the style picker to know whether it's right for them.

> Naming is deliberate. The picker labels each archetype by **what the NPO is doing**, not by Givernance-internal codename — operators don't want to pick `archetype_3b`, they want to pick "I run an emergency appeal."

| # | Key | Operator-facing label | Voice / posture | Typography | Hero treatment | Amount picker | Best for |
|---|---|---|---|---|---|---|---|
| 1 | `foundation` | **Foundation** *(default)* | Institutional, restrained, trustworthy. The "your grandmother's lawyer wrote the headline" archetype. | Serif display + humanist sans body (Source Serif + Inter). | Logo top-left, headline, mission sentence, soft gradient. Today's page. | Inline chips + write-in. | Long-running NPOs, foundations, board-driven orgs. |
| 2 | `activist` | **Activist** | Urgent, vivid, emotionally direct. Big colour, big type. | Display sans (bold cut) + same sans body. | Oversized headline as the hero. Optional photo behind. Saturated brand colour wash. | Grid of 4 oversized chips, recurring as a second screen. | Climate, social-justice, mobilisation orgs. |
| 3 | `editorial-story` | **Editorial Story** | Long-form, photo-essay, beneficiary-driven. The "magazine feature" archetype. | Editorial serif (Spectral) + humanist sans body. | Full-bleed photo, byline-style attribution, drop cap on the description. | Sits below the story; reveals after scroll. | Humanitarian orgs with strong photography (MSF, Oxfam-adjacent). |
| 4 | `minimal-checkout` | **Minimal Checkout** | Stripe-Payment-Link-grade. No pitch — the donor already trusts you. | Single sans throughout (Inter). | No hero. Logo small in the corner, headline as a label. | The page **is** the amount picker. | Repeat-donor campaigns, member-only appeals. |
| 5 | `emergency-appeal` | **Emergency Appeal** | Urgent, counter-led, action-now. The GoFundMe disaster-page archetype. | Bold sans display + condensed mono for the counter. | Counter is the hero. Date stamp, time-since-launch line, optional banner. | Below the counter, single column. | Disasters, time-bound appeals, matching-day campaigns. |
| 6 | `neo-brutalist` | **Neo-Brutalist** | Confident, type-driven, deliberate visual roughness. Black borders, hard shadows, mono numerals. | All-mono throughout (JetBrains Mono) with one display serif accent. | Concrete-block grid, oversized chevrons, manual misalignments. | Square chips, hard borders, hover-on-shift. | Arts orgs, design-collective NPOs, indie civic-tech. |
| 7 | `calm-wellness` | **Calm Wellness** | Soft, hopeful, breath-paced. Pastel washes, gentle motion. | Display sans with rounded terminals (Quicksand) + the same family for body. | Animated soft gradient (low-amplitude SVG morphing). Headline in lowercase. | Pill chips, generous whitespace, animated focus state. | Mental-health, mindfulness, ecology-meditation orgs. |
| 8 | `civic-modern` | **Civic Modern** | Public-sector adjacent. French-administration neutral. Strong transparency framing. | Geometric sans (IBM Plex Sans) throughout, with mono for figures. | Two-column: headline + a transparency-stat block ("82 % programmes, 11 % support, 7 % fundraising"). | Inline chips + recurring + an explicit "where does it go?" expander. | French-NPO sector, civic-tech, public-partnership NPOs. |
| 9 | `retro-print` | **Retro Print** | Riso-printed-poster energy. Off-register colour, paper grain, vintage feel. | Slab serif display + a thin humanist for body. | Two-colour duotone treatment of the logo. Subtle paper-grain background. | Stamped-postcard chips. | Vintage-feeling orgs: heritage, local museums, alumni associations. |
| 10 | `cosmic-gradient` | **Cosmic Gradient** | Optimistic, ambitious, future-facing. Big animated gradient mesh, large display type. | Display sans (Geist) + humanist sans body. | Animated CSS gradient mesh as the hero background; headline floats. | Glassmorphism chips on the gradient. | Climate-tech, space, future-of-X NPOs, tech-adjacent orgs. |

### 2.1 Why ten, not five

A 5-archetype set covers the obvious axes: institutional / urgent / story / minimal / civic. The remaining 5 (`Neo-Brutalist`, `Calm Wellness`, `Retro Print`, `Cosmic Gradient`, and the Activist/Foundation split) are deliberate **personality** archetypes for NPOs whose donor base doesn't respond to corporate restraint. We expect them to be picked by maybe 25 % of tenants combined — but for those tenants they are the difference between "this feels like our website" and "this feels like a generic donation widget."

We considered going further (12, 15) and stopped at 10 because:
- Beyond ~10 the picker stops being a curated catalogue and becomes a marketplace, and the picker UX collapses (preview thumbnails in a 4×3 grid is still scannable; a 5×3 grid isn't).
- Each new archetype has a long maintenance tail: visual-regression tests, a11y audit, mobile pass, mockup file, Lighthouse pass. Beyond 10 the doubling of test surface stops paying back.
- The 10 we picked already span all four corners of the *(restrained ↔ expressive)* × *(institutional ↔ grassroots)* matrix. Adding more would mostly be variations on a corner already covered.

### 2.2 Easter eggs

Per the product directive, a subset of archetypes carry a hidden interaction the operator can discover (or be told about by their CSM). Easter eggs are **never** visible by default, never affect the donor's experience, and never carry behaviour the operator cares about beyond "make the team smile." We commit to one per archetype where the visual identity supports it, and intentionally leave the institutional / civic / minimal archetypes egg-less so they remain credibly restrained.

| Archetype | Easter egg trigger | What happens |
|---|---|---|
| `activist` | Konami code (↑↑↓↓←→←→ B A) | Confetti rain in the brand colour for 4 s. |
| `calm-wellness` | Click the headline 5 times | Falling-leaves / falling-snow animation (season-dependent in the user's locale). |
| `neo-brutalist` | Hover and hold any chip for 2 s | RGB-channel glitch on the headline for 600 ms. |
| `retro-print` | Triple-click the logo | The page flickers and the duotone briefly mis-registers, like a Riso paper-jam. |
| `cosmic-gradient` | Click the counter | A particle burst spawns from the click point and drifts upward. |
| `emergency-appeal` | (no egg — emergency campaigns should never have a "fun" moment) | — |
| `foundation`, `editorial-story`, `minimal-checkout`, `civic-modern` | (no egg — preserves credibility) | — |

All easter eggs are pure-frontend, respect `prefers-reduced-motion` (they no-op when the user has asked for less motion), and are seed-able for screenshot tests so they don't cause flake.

---

## 3. Mockup commitment

Per the Epic's spike acceptance criteria, this PR ships the **first** archetype's HTML mockup — `Foundation` — at `docs/design/donations/public-foundation.html`. It is the closest to the existing live page so we can validate the chosen architecture doesn't break what's already shipped. The other 9 mockups land in [Phase 4 (PR-4)](../../README.md#phases) along with their implementation.

---

## 4. What's explicitly out of scope here

- **A WYSIWYG editor / drag-and-drop builder.** Forever out of scope for this Epic; covered by the explicit scope-statement in the Epic itself.
- **Per-section style mixing.** The picker is "pick one archetype," not "compose your own."
- **Donor-uploaded photography or video.** Photos belong to the operator's branding ([Epic #286](https://github.com/purposestack/givernance/issues/286)).
- **A/B testing.** The operator picks one archetype; we don't ship a multi-variant runner.
- **AI-generated style suggestions** ("pick an archetype based on your mission"). Tempting; deferred until we have shipped data on which archetypes correlate with which donor outcomes.

---

## 5. References

- [Epic #362](https://github.com/purposestack/givernance/issues/362) — this work
- [Epic #286](https://github.com/purposestack/givernance/issues/286) — organisation branding (logo, primary colour) — composes with archetypes
- [Issue #39](https://github.com/purposestack/givernance/issues/39) / [PR #197](https://github.com/purposestack/givernance/pull/197) — the existing public donation page
- [`docs/11-design-identity.md`](../11-design-identity.md) — design-token system the archetypes must respect
- [`docs/24-branding-assets.md`](../24-branding-assets.md) — branding stack archetypes compose with
- [ADR-030](../adrs/adr-030-public-page-style-archetypes.md) — architecture decision for archetypes (hybrid shell + slot components)
