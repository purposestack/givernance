#!/usr/bin/env bash
# Validate that pinned image versions of compliance-anchored dependencies
# don't exceed the ceiling declared in infra/compliance-versions.yml, and
# that no `image:` / `FROM` reference for those deps lives outside the
# manifest's `pinned_in:` allowlist (default-deny — issue #284).
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

if ! git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  echo "not inside a git work tree (required for the default-deny scan)" >&2
  exit 2
fi

violations=0
checked=0

# `yq -r` strips quotes; `keys[]` walks the dependency map keys.
deps=$(yq -r '.dependencies | keys[]' "$MANIFEST")

# Match either:
#   `image: <dep>:<MAJOR>...` — YAML key form (compose / GH-Actions services).
#     Leading whitespace allowed; tolerates quoted scalars (`'`/`"`) which
#     are valid YAML and which Dependabot can emit.
#   `FROM <dep>:<MAJOR>...` — Dockerfile directive at column 0.
# Captures the major into group 2 (group 1 is the matched prefix variant).
match_regex_for() {
  local dep="$1"
  printf '^[[:space:]]*image:[[:space:]]*['\''"]?%s:[0-9]+|^FROM[[:space:]]+%s:[0-9]+' "$dep" "$dep"
}

for dep in $deps; do
  ceiling=$(yq -r ".dependencies.\"$dep\".max_major" "$MANIFEST")
  provider=$(yq -r ".dependencies.\"$dep\".provider" "$MANIFEST")
  pinned_files=$(yq -r ".dependencies.\"$dep\".pinned_in[]" "$MANIFEST")
  regex=$(match_regex_for "$dep")

  # ── Pass 1: ceiling check on each declared `pinned_in:` file. ─────────────
  # Both `image:` and `FROM` forms are accepted, so a Dockerfile legitimately
  # listed in `pinned_in:` gets the same major-version enforcement as a
  # compose pin.
  for file in $pinned_files; do
    if [ ! -f "$file" ]; then
      # Missing file = silently-disabled enforcement for that dep. Treat
      # as a hard error so a typo in `pinned_in:` or a renamed/moved file
      # surfaces immediately rather than letting the gate quietly pass.
      echo "::error ::compliance manifest references missing file: $file (dep=$dep)"
      violations=$((violations + 1))
      continue
    fi

    while IFS= read -r match; do
      [ -z "$match" ] && continue
      lineno=$(echo "$match" | cut -d: -f1)
      # Strip the `<lineno>:` prefix grep adds, then peel off whichever
      # form matched (image: '"'"'…'"'"' OR FROM …) to leave the major.
      version=$(echo "$match" | sed -E "s|^[0-9]+:[[:space:]]*image:[[:space:]]*['\"]?${dep}:([0-9]+).*|\1|; s|^[0-9]+:FROM[[:space:]]+${dep}:([0-9]+).*|\1|")

      if [ "$version" -gt "$ceiling" ]; then
        echo "::error file=$file,line=$lineno::$dep:$version exceeds compliance ceiling $ceiling (provider: $provider). Bump infra/compliance-versions.yml first, after the provider publishes support. See ADR-026."
        violations=$((violations + 1))
      fi
      checked=$((checked + 1))
    done < <(grep -nE "$regex" "$file" || true)
  done

  # ── Pass 2: default-deny scan across the whole tracked tree. ──────────────
  # Any `image: <dep>:` or `FROM <dep>:` match in a file NOT declared in
  # `pinned_in:` is a violation. Closes the gap that a stray Dockerfile or
  # an accidentally-added compose override could otherwise drive through
  # (issue #284). `git ls-files` naturally excludes `.git`, gitignored
  # paths (node_modules, dist, .next, .turbo, …), and untracked scratch
  # files — so adding a file to the index makes the gate notice it.
  while IFS= read -r match; do
    [ -z "$match" ] && continue
    file=$(echo "$match" | cut -d: -f1)
    lineno=$(echo "$match" | cut -d: -f2)

    # Skip files already declared in `pinned_in:` for this dep — Pass 1
    # already enforced the ceiling on them.
    declared=0
    for pinned_file in $pinned_files; do
      if [ "$file" = "$pinned_file" ]; then
        declared=1
        break
      fi
    done
    [ "$declared" -eq 1 ] && continue

    echo "::error file=$file,line=$lineno::$dep image reference in undeclared file. Either add '$file' to dependencies.$dep.pinned_in in $MANIFEST (after confirming the version is at or below the $ceiling ceiling), or remove the reference. See ADR-026."
    violations=$((violations + 1))
  done < <(git ls-files -z | xargs -0 grep -nHE "$regex" 2>/dev/null || true)
done

if [ "$violations" -gt 0 ]; then
  echo "" >&2
  echo "$violations compliance violation(s) found across $checked declared pin(s)." >&2
  echo "Resolution:" >&2
  echo "  1) Ceiling exceeded: wait for the provider, bump infra/compliance-versions.yml, then merge; OR revert the offending pin." >&2
  echo "  2) Undeclared reference: add the file to the dep's pinned_in list (or remove the reference)." >&2
  exit 1
fi

echo "Compliance ceilings OK: $checked pin(s) checked across $(echo "$deps" | wc -w | tr -d ' ') dependencies; default-deny scan clean."
