#!/usr/bin/env bash
# Validate that pinned image versions of compliance-anchored dependencies
# don't exceed the ceiling declared in infra/compliance-versions.yml.
#
# Run as a CI step (`compliance-versions-gate` in .github/workflows/ci.yml)
# and locally as part of `pnpm run check` if developers want a pre-push
# safety net. Exits non-zero on any violation; emits GitHub Actions
# `::error` annotations so CI surfaces the offending file:line directly
# in the PR Files-changed view.
#
# Pattern + rationale: ADR-026.

set -euo pipefail

MANIFEST="${MANIFEST:-infra/compliance-versions.yml}"

if [ ! -f "$MANIFEST" ]; then
  echo "compliance manifest not found: $MANIFEST" >&2
  exit 2
fi

if ! command -v yq >/dev/null 2>&1; then
  echo "yq not found on PATH (required to parse $MANIFEST)" >&2
  exit 2
fi

violations=0
checked=0

# `yq -r` strips quotes; `keys[]` walks the dependency map keys.
deps=$(yq -r '.dependencies | keys[]' "$MANIFEST")

for dep in $deps; do
  ceiling=$(yq -r ".dependencies.\"$dep\".max_major" "$MANIFEST")
  provider=$(yq -r ".dependencies.\"$dep\".provider" "$MANIFEST")
  files=$(yq -r ".dependencies.\"$dep\".pinned_in[]" "$MANIFEST")

  for file in $files; do
    if [ ! -f "$file" ]; then
      # Missing file = silently-disabled enforcement for that dep. Treat
      # as a hard error so a typo in `pinned_in:` or a renamed/moved file
      # surfaces immediately rather than letting the gate quietly pass.
      echo "::error ::compliance manifest references missing file: $file (dep=$dep)"
      violations=$((violations + 1))
      continue
    fi

    # Match `image: <dep>:<MAJOR>...` only when `image:` is the YAML key
    # (leading whitespace allowed, no `#` before — that would be a comment).
    # Tolerates quoted forms (`image: "postgres:17"`, `image: 'postgres:17'`)
    # which are valid YAML scalars and which Dependabot can emit.
    # Captures the first numeric component as the major.
    while IFS= read -r match; do
      [ -z "$match" ] && continue
      lineno=$(echo "$match" | cut -d: -f1)
      version=$(echo "$match" | sed -E "s|^[[:space:]]*[0-9]+:[[:space:]]*image:[[:space:]]*['\"]?${dep}:([0-9]+).*|\1|")

      if [ "$version" -gt "$ceiling" ]; then
        echo "::error file=$file,line=$lineno::$dep:$version exceeds compliance ceiling $ceiling (provider: $provider). Bump infra/compliance-versions.yml first, after the provider publishes support. See ADR-026."
        violations=$((violations + 1))
      fi
      checked=$((checked + 1))
    done < <(grep -nE "^[[:space:]]*image:[[:space:]]*['\"]?${dep}:[0-9]+" "$file" || true)
  done
done

if [ "$violations" -gt 0 ]; then
  echo "" >&2
  echo "$violations compliance-ceiling violation(s) found across $checked pin(s)." >&2
  echo "Resolution:" >&2
  echo "  1) Wait for the provider to add support, bump infra/compliance-versions.yml, then merge; OR" >&2
  echo "  2) Revert the offending pin(s) to the current ceiling." >&2
  exit 1
fi

echo "Compliance ceilings OK: $checked pin(s) checked across $(echo "$deps" | wc -w | tr -d ' ') dependencies."
