# Design Prompt Template — Givernance NPO Platform

This locked style anchor MUST be prepended to every UI screen generation prompt.
Agents generating mockup images must use this exact template for visual consistency.

---

## LOCKED STYLE ANCHOR (copy-paste at start of every prompt)

```
STYLE LOCKED — Givernance NPO Platform UI. Strict visual consistency required:
- LEFT SIDEBAR: 240px wide, solid deep forest green background (#2E7D5E), white icon + white label on each nav item, active item has left white 3px accent bar + slightly lighter green bg (#3A9070), bottom has org name + user avatar. Nav items: Dashboard, Constituants, Dons & Campagnes, Subventions, Programmes, Bénévoles, Impact, Communications, Rapports, Paramètres.
- TOP BAR: white (#FAFAF8), 56px tall, breadcrumb in slate gray on left, search bar center, notification bell + user avatar on right.
- PAGE BACKGROUND: warm off-white (#FAFAF8), content area starts at left edge of main content (right of sidebar).
- CARDS: white background, 8px border-radius, subtle shadow (0 1px 4px rgba(0,0,0,0.08)), 24px padding, linen (#F2F0EC) section dividers.
- TYPOGRAPHY: Serif font (Instrument Serif style) for section headings, Inter-style sans-serif for all body text and labels. Body text in Ink (#1C1B19). Secondary text in Slate (#6B6760).
- BUTTONS: Primary = solid forest green (#2E7D5E) with white text, 6px radius. Secondary = white with stone border. Destructive = indigo (#5B4FD4).
- BADGES/TAGS: small pill shape, 4px radius, color-coded: green for active/success (with checkmark icon), amber for warning (with exclamation icon), indigo for error (with X icon), sky blue for info.
- DATA TABLES: alternating white/linen rows, left-aligned text, right-aligned numbers, sticky header in stone (#E4E0D9), 48px row height comfortable mode.
- CHARTS: line/area in sage green (#4CAF82) with forest green fill, bar charts in forest green, accent data in amber, no red.
- AI SUGGESTION CARD: compact 280px wide card, linen background, forest green left border 3px, small brain icon, one-line reasoning text, two small buttons: "✓ Appliquer" (green) and "✕ Ignorer" (stone).
- OVERALL FEEL: calm, professional, warm European civic aesthetic. Not startup-flashy. Not cold corporate.
```

---

## Screen-specific additions

After the style anchor, add the screen-specific description. Example:

```
[STYLE ANCHOR here]

SCREEN: Dashboard principal — Vue admin NPO.
[Your specific content description...]
```

---

## Anti-patterns for image generation

- Never describe "a dark theme" — always light mode
- Never use red — use indigo (#5B4FD4) for errors
- Never describe a top navigation — always left sidebar
- Never describe full-width content — max 1280px centered
- Always specify EUR currency and French/European names for realistic data
- Always include a visible active nav item in the sidebar
