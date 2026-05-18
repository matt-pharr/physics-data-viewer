#!/usr/bin/env bash
# scripts/bump-version.sh <new-version> — bump the PDV version everywhere.
#
# Reads the current version from electron/package.json, replaces it with
# <new-version> at every parity-checked site, then runs the parity check
# to confirm. Site list mirrors scripts/check-version-parity.sh — keep
# them in sync if you add a new file.
#
# Usage:
#   scripts/bump-version.sh 0.1.2
#   scripts/bump-version.sh 0.2.0-rc1
#
# Does NOT git-add, commit, or push. After it runs, review with
# `git diff` and commit yourself.

set -eu

if [ $# -ne 1 ]; then
    echo "Usage: $0 <new-version>" >&2
    echo "Example: $0 0.1.2" >&2
    exit 2
fi

NEW="$1"
if ! printf '%s' "$NEW" | grep -qE '^[0-9]+\.[0-9]+\.[0-9]+([.-][A-Za-z0-9.-]+)?$'; then
    echo "error: '$NEW' does not look like a version (expected M.m.p[.suffix])" >&2
    exit 2
fi

REPO_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

OLD=$(sed -nE 's/^[[:space:]]*"version":[[:space:]]*"([^"]+)".*/\1/p' \
          electron/package.json | head -1)
if [ -z "$OLD" ]; then
    echo "error: could not read current version from electron/package.json" >&2
    exit 1
fi

if [ "$OLD" = "$NEW" ]; then
    echo "Already at $NEW. Nothing to do."
    exit 0
fi

echo "Bumping $OLD -> $NEW"
echo

# Cross-platform in-place sed. We pass -E so extended-regex constructs
# (`[[:space:]]+`, `()` grouping, `\1` backref) work the same way on
# GNU sed (Linux/CI) and BSD sed (macOS). GNU needs '-i'; BSD needs an
# empty extension argument after '-i'.
if sed --version >/dev/null 2>&1; then
    SED_INPLACE=(sed -i -E)
else
    SED_INPLACE=(sed -i '' -E)
fi
sed_i() { "${SED_INPLACE[@]}" "$@"; }

# Escape periods in $OLD so it stays a literal in the sed pattern.
# (e.g. "0.1.0" -> "0\.1\.0")
OLD_RE=$(printf '%s' "$OLD" | sed 's/\./\\./g')

# A single replace_in_file helper. We pass the FULL match pattern to ensure
# we only edit the expected occurrence — never a bare version string that
# could clash with unrelated content.
replace_in_file() {
    # replace_in_file <file> <sed-pattern-using-OLD_RE> <sed-replacement-using-NEW>
    local file="$1" pat="$2" rep="$3"
    if [ ! -f "$file" ]; then
        echo "  ! $file: missing — skipping"
        return
    fi
    if ! grep -qE -- "$pat" "$file"; then
        echo "  ! $file: pattern not found (already bumped?)"
        return
    fi
    sed_i "s|$pat|$rep|g" "$file"
    echo "  ✓ $file"
}

# --- Sites (mirror scripts/check-version-parity.sh) ---

# Canonical build manifests (only top-level version key)
replace_in_file pdv-python/pyproject.toml \
    "^version = \"$OLD_RE\"" \
    "version = \"$NEW\""

replace_in_file electron/package.json \
    "^([[:space:]]+)\"version\": \"$OLD_RE\"," \
    "\\1\"version\": \"$NEW\","

# Docs
replace_in_file README.md \
    "\`v$OLD_RE\`" \
    "\`v$NEW\`"

# ARCHITECTURE.md has multiple version-example occurrences. They all bump
# in lockstep (matches the prior bump's behavior).
replace_in_file ARCHITECTURE.md \
    "$OLD_RE" \
    "$NEW"

# Release-notes script (comment example)
replace_in_file .github/scripts/generate-release-notes.sh \
    "e\\.g\\. v$OLD_RE" \
    "e.g. v$NEW"

# Example modules: only pdv_min, NOT the module's own "version" field.
replace_in_file examples/modules/N-pendulum/pdv-module.json \
    "\"pdv_min\": \"$OLD_RE\"" \
    "\"pdv_min\": \"$NEW\""
replace_in_file examples/modules/N-pendulum-julia/pdv-module.json \
    "\"pdv_min\": \"$OLD_RE\"" \
    "\"pdv_min\": \"$NEW\""

# Test fixtures no longer need a per-site replacement: they derive the
# version at runtime from electron/package.json via TEST_PDV_VERSION
# (see issue #235).

echo
echo "Edits applied. Verifying parity..."
echo
"$REPO_ROOT/scripts/check-version-parity.sh"
echo
echo "Review the diff with: git diff"
