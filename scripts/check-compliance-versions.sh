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

# Match either:
#   `image: <dep>:<MAJOR>...` — YAML key form (compose / GH-Actions services).
#     Leading whitespace allowed; tolerates quoted scalars (`'`/`"`) which
#     are valid YAML and which Dependabot can emit.
#   `FROM <dep>:<MAJOR>...` — Dockerfile directive.
#     Case-insensitive (`from` is valid Dockerfile syntax — directives are
#     not case-sensitive per the Dockerfile reference). Leading whitespace
#     tolerated (Docker is lenient about indentation). Optional repeated
#     `--flag=value` between `FROM` and the image name (e.g.
#     `FROM --platform=linux/amd64 postgres:17`).
# Captures: group 1 = optional last `--flag=value` on FROM (unused);
# group 2 = major.
match_regex_for() {
  local dep="$1"
  printf '^[[:space:]]*image:[[:space:]]*['\''"]?%s:[0-9]+|^[[:space:]]*[Ff][Rr][Oo][Mm][[:space:]]+(--[A-Za-z][A-Za-z0-9-]*=[^[:space:]]+[[:space:]]+)*%s:[0-9]+' "$dep" "$dep"
}

# `yq -r` strips quotes; `keys[]` walks the dependency map keys.
# Read into a bash array via `while read` so a hostile manifest entry
# containing whitespace or shell glob characters can't word-split or
# expand against the CWD when iterated. (Avoids `mapfile`, which is
# bash 4+ only — macOS ships 3.2.)
deps=()
while IFS= read -r line; do
  [ -z "$line" ] && continue
  deps+=("$line")
done < <(yq -r '.dependencies | keys[]' "$MANIFEST")

for dep in "${deps[@]}"; do
  # Reject dep names that aren't simple identifiers — they would be
  # interpolated into a regex below, where metacharacters (`|`, `.`, `*`)
  # would silently change semantics. Today's deps (`postgres`, `redis`)
  # pass; expand the pattern when a future dep needs it.
  if ! printf '%s' "$dep" | grep -qE '^[a-z][a-z0-9-]*$'; then
    echo "::error ::compliance manifest contains a dep name with disallowed characters: $dep (allowed: ^[a-z][a-z0-9-]*\$)"
    violations=$((violations + 1))
    continue
  fi

  ceiling=$(yq -r ".dependencies.\"$dep\".max_major" "$MANIFEST")
  provider=$(yq -r ".dependencies.\"$dep\".provider" "$MANIFEST")
  pinned_files=()
  while IFS= read -r line; do
    [ -z "$line" ] && continue
    pinned_files+=("$line")
  done < <(yq -r ".dependencies.\"$dep\".pinned_in[]" "$MANIFEST")
  regex=$(match_regex_for "$dep")

  # ── Pass 1: ceiling check on each declared `pinned_in:` file. ─────────────
  # Both `image:` and `FROM` forms are accepted, so a Dockerfile legitimately
  # listed in `pinned_in:` gets the same major-version enforcement as a
  # compose pin.
  for file in "${pinned_files[@]}"; do
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
      lineno=$(printf '%s' "$match" | sed -E 's|^([0-9]+):.*|\1|')
      # Peel off whichever form matched to leave the major. Two sed
      # branches because the alternation has different shapes (image:
      # has no flag-prefix; FROM may have repeated `--flag=value` flags
      # between the directive and the image).
      version=$(printf '%s' "$match" | sed -E "
        s|^[0-9]+:[[:space:]]*image:[[:space:]]*['\"]?${dep}:([0-9]+).*|\1|
        s|^[0-9]+:[[:space:]]*[Ff][Rr][Oo][Mm][[:space:]]+(--[A-Za-z][A-Za-z0-9-]*=[^[:space:]]+[[:space:]]+)*${dep}:([0-9]+).*|\2|
      ")

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
  # (issue #284). The file list comes from `git ls-files -z` (NUL-separated,
  # so any legal POSIX filename — including `:` — round-trips intact); the
  # per-file `grep -nIE` then yields `<lineno>:<content>` where the first
  # `:` reliably separates lineno from content. `-I` skips binaries so we
  # don't risk a regex hit against random bytes. Untracked / gitignored
  # paths (node_modules, dist, .next, .turbo, scratch fixtures) are
  # excluded — a developer can experiment locally without failing CI;
  # staging the file makes the gate notice it.
  while IFS= read -r -d '' file; do
    [ -f "$file" ] || continue

    # Skip files already declared in `pinned_in:` for this dep — Pass 1
    # already enforced the ceiling on them.
    declared=0
    for pinned_file in "${pinned_files[@]}"; do
      if [ "$file" = "$pinned_file" ]; then
        declared=1
        break
      fi
    done
    [ "$declared" -eq 1 ] && continue

    while IFS= read -r match; do
      [ -z "$match" ] && continue
      lineno=${match%%:*}
      echo "::error file=$file,line=$lineno::$dep image reference in undeclared file. Either add '$file' to dependencies.$dep.pinned_in in $MANIFEST (after confirming the version is at or below the $ceiling ceiling), or remove the reference. See ADR-026."
      violations=$((violations + 1))
    done < <(grep -nIE "$regex" "$file" 2>/dev/null || true)
  done < <(git ls-files -z)
done

if [ "$violations" -gt 0 ]; then
  echo "" >&2
  echo "$violations compliance violation(s) found across $checked declared pin(s)." >&2
  echo "Resolution:" >&2
  echo "  1) Ceiling exceeded: wait for the provider, bump infra/compliance-versions.yml, then merge; OR revert the offending pin." >&2
  echo "  2) Undeclared reference: add the file to the dep's pinned_in list (or remove the reference)." >&2
  exit 1
fi

echo "Compliance ceilings OK: $checked pin(s) checked across ${#deps[@]} dependencies; default-deny scan clean."
