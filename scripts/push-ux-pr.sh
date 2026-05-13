#!/usr/bin/env bash
# =============================================================================
# push-ux-pr.sh — Commit + push the UX polish branch and open the PR.
#
# Run from the repo root: bash scripts/push-ux-pr.sh
# Requires: gh CLI authenticated, pnpm available
# =============================================================================
set -euo pipefail

BRANCH="feat/ux-mvp-polish"
REPO="purposestack/givernance"

echo ""
echo "╔══════════════════════════════════════════════════════════════╗"
echo "║  Givernance — Push UX polish branch + create PR             ║"
echo "╚══════════════════════════════════════════════════════════════╝"

# ─── Step 1: Ensure we're on the right branch ────────────────────────────────
echo ""
echo "▶ 1/5  Checking out UX branch …"
git checkout feat/ux-mvp-polish 2>/dev/null || git checkout -b feat/ux-mvp-polish origin/main
echo "       ✅ On branch feat/ux-mvp-polish"

# ─── Step 2: Lint + format ───────────────────────────────────────────────────
echo ""
echo "▶ 2/5  Running format + lint …"
pnpm run format
pnpm run lint
echo "       ✅ Format + lint clean."

# ─── Step 3: Typecheck ───────────────────────────────────────────────────────
echo ""
echo "▶ 3/5  TypeScript check …"
pnpm typecheck
echo "       ✅ TypeScript clean."

# ─── Step 4: Commit ──────────────────────────────────────────────────────────
echo ""
echo "▶ 4/5  Committing …"
git add \
  packages/web/src/lib/format.ts \
  packages/web/src/app/globals.css \
  packages/web/src/components/ui/button.tsx \
  packages/web/src/components/ui/toast.tsx \
  packages/web/src/components/ui/data-table.tsx \
  packages/web/src/components/layout/topbar.tsx \
  packages/web/src/components/layout/sidebar.tsx \
  "packages/web/src/app/(app)/dashboard/page.tsx" \
  scripts/merge-open-prs.sh \
  scripts/push-ux-pr.sh

git commit -m "feat(ux): MVP polish — rounded KPIs, hover tokens, focus rings, toast position

Dashboard
- formatCurrencyRounded() helper (0 decimals) for KPI stat cards and
  campaign mini-cards (Total Raised: '€12 345' not '€12 345,00')
- Grant-deadline stat card: colour token neutral → amber (warning intent)

Interaction affordances
- button: hover:opacity-90 → hover:bg-primary-hover / hover:bg-error-hover
- transition-opacity → transition-colors on button base class
- New tokens: --color-primary-hover (#075436), --color-error-hover (#8c1414)

Focus-ring consistency (ADR-012 §4)
- topbar search, bell, avatar trigger → focus-visible:shadow-ring
- sidebar workspace-switcher → focus-visible:shadow-ring
- data-table sort button → focus-visible:shadow-ring

Toast
- Position top-right → bottom-right (avoids topbar collision)
- Duration 4s → 5s

Avatar initials fallback
- sidebar + topbar: '?' → email[0].toUpperCase() when name absent

Scripts
- scripts/merge-open-prs.sh — rebase-and-merge helper for PR #361 → #366"

echo "       ✅ Committed."

# ─── Step 5: Push + open PR ──────────────────────────────────────────────────
echo ""
echo "▶ 5/5  Pushing + creating PR …"
git push -u origin feat/ux-mvp-polish

gh pr create \
  --repo "$REPO" \
  --base main \
  --head feat/ux-mvp-polish \
  --title "feat(ux): MVP polish — rounded KPIs, hover tokens, focus rings, toast" \
  --body "## Summary

Visual polish pass ahead of the MVP. All changes are non-breaking component-level tweaks — no API, no schema, no migrations.

## What changed

### Dashboard KPIs — no decimals
- Added \`formatCurrencyRounded()\` helper (0 decimal places) in \`packages/web/src/lib/format.ts\`
- Total Raised KPI now shows \`€12 345\` instead of \`€12 345,00\` (user feedback)
- Campaign mini-card raised / goal amounts also use rounded formatting
- Grant deadline stat card: colour token \`neutral\` → \`amber\` for correct warning semantics

### Button hover states
- Replaced \`hover:opacity-90\` with concrete colour tokens on primary + destructive variants
- New tokens: \`--color-primary-hover: #075436\`, \`--color-error-hover: #8c1414\`
- Switched \`transition-opacity\` → \`transition-colors\` on base class

### Focus-ring unification (ADR-012 §4)
Every interactive element now uses the system \`focus-visible:shadow-ring\` token:
- Topbar: search input, notification bell, avatar trigger
- Sidebar: workspace-switcher trigger
- DataTable: sort-column buttons

### Toast
- Default position \`top-right\` → \`bottom-right\` (prevents overlap with topbar + avatar menu)
- Default duration 4 s → 5 s (destructive confirmations readable before dismiss)

### Avatar initials fallback
- Topbar + sidebar: fallback chain is now \`first+last → first only → email[0] → '?'\`
- Users with no name set see their email initial instead of '?'

### Merge helper script
- \`scripts/merge-open-prs.sh\` — merges PR #361 then #366 (rebase policy), auto-renames
  migration \`0051_feature_flags_phase2 → 0053_feature_flags_phase2\` after #361 lands

## Test checklist
- [ ] Dashboard: Total Raised shows no decimals (\`€12 345\` not \`€12 345,00\`)
- [ ] Dashboard: Grant deadline card has amber icon background (not grey)
- [ ] Primary button hover: visible colour darkening (not just opacity fade)
- [ ] Destructive button hover: visible darker red
- [ ] Toast: appears bottom-right, stays for 5 s
- [ ] Avatar with no name: shows email initial (not '?')
- [ ] Tab through the topbar: focus ring is consistent on search / bell / avatar
- [ ] Table sort button: consistent focus ring on keyboard navigation

**Do not merge — for review + testing only.**

🤖 Generated with Claude (Cowork mode)"

echo ""
echo "══════════════════════════════════════════════════════════════"
echo "  ✅ PR created! Open it in your browser to review + test."
echo "══════════════════════════════════════════════════════════════"
