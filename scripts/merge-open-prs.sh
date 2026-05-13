#!/usr/bin/env bash
# =============================================================================
# merge-open-prs.sh — Merge PR #361 then #366, fixing the migration conflict.
#
# Policy: rebase and merge (--rebase), as per repo convention.
# Run from the repo root after authenticating with `gh auth login`.
#
# Usage: bash scripts/merge-open-prs.sh
# =============================================================================
set -euo pipefail

REPO="purposestack/givernance"

echo ""
echo "╔══════════════════════════════════════════════════════════════╗"
echo "║  Givernance — Merge open PRs (#361 then #366)               ║"
echo "╚══════════════════════════════════════════════════════════════╝"
echo ""

# ─── Step 1: Merge PR #361 (Swiss QR bill camt.053) ─────────────────────────
echo "▶ 1/4  Merging PR #361 (camt.053 reconciliation) via rebase …"
gh pr merge 361 --repo "$REPO" --rebase --delete-branch
echo "       ✅ PR #361 merged."

# ─── Step 2: Fetch updated main ─────────────────────────────────────────────
echo ""
echo "▶ 2/4  Fetching updated main …"
git fetch origin main
echo "       ✅ main up to date."

# ─── Step 3: Rebase PR #366 branch + fix migration conflict ─────────────────
echo ""
echo "▶ 3/4  Rebasing feat/issue-365-feature-flags-phase2 onto main …"
git checkout feat/issue-365-feature-flags-phase2
git fetch origin feat/issue-365-feature-flags-phase2
git reset --hard origin/feat/issue-365-feature-flags-phase2

# Rebase — will conflict on the 0051 migration
set +e
git rebase origin/main
REBASE_EXIT=$?
set -e

if [ $REBASE_EXIT -ne 0 ]; then
  echo ""
  echo "  ℹ️  Conflict detected on migration 0051 (expected). Resolving …"

  # Rename 0051_feature_flags_phase2 → 0053_feature_flags_phase2
  MIGRATION_SRC="packages/api/migrations/0051_feature_flags_phase2.sql"
  MIGRATION_DST="packages/api/migrations/0053_feature_flags_phase2.sql"

  if [ -f "$MIGRATION_SRC" ]; then
    git mv "$MIGRATION_SRC" "$MIGRATION_DST"
    echo "     Renamed: $MIGRATION_SRC → $MIGRATION_DST"
  else
    echo "     ⚠️  Source migration not found at $MIGRATION_SRC — check conflicts manually."
    echo "     Run: git status  to inspect."
    exit 1
  fi

  # Update _journal.json: idx 51 → 53, tag updated accordingly
  JOURNAL="packages/api/migrations/meta/_journal.json"
  python3 - <<'PYEOF'
import json, sys

with open("packages/api/migrations/meta/_journal.json", "r") as f:
    j = json.load(f)

for entry in j["entries"]:
    if entry.get("tag") == "0051_feature_flags_phase2":
        entry["idx"] = 53
        entry["tag"] = "0053_feature_flags_phase2"
        break

with open("packages/api/migrations/meta/_journal.json", "w") as f:
    json.dump(j, f, indent=2)
    f.write("\n")

print("     Updated _journal.json: 0051_feature_flags_phase2 → 0053_feature_flags_phase2")
PYEOF

  git add "$MIGRATION_DST" "$JOURNAL"
  # Stage any other conflict resolutions if needed
  git rebase --continue
  echo "       ✅ Conflict resolved, rebase complete."
else
  echo "       ✅ Rebase completed without conflicts."
fi

# Push the rebased branch
echo ""
echo "       Pushing rebased branch …"
git push --force-with-lease origin feat/issue-365-feature-flags-phase2
echo "       ✅ Branch pushed."

# ─── Step 4: Merge PR #366 (Feature Flags Phase 2) ──────────────────────────
echo ""
echo "▶ 4/4  Merging PR #366 (Feature Flags Phase 2) via rebase …"
gh pr merge 366 --repo "$REPO" --rebase --delete-branch
echo "       ✅ PR #366 merged."

echo ""
echo "══════════════════════════════════════════════════════════════"
echo "  Done! Both PRs are merged onto main."
echo "  PR #297 (Donations UX draft) remains open — needs more work."
echo "══════════════════════════════════════════════════════════════"
echo ""
