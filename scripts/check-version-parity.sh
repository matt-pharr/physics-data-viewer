#!/usr/bin/env bash
# scripts/check-version-parity.sh — verify all PDV version sites agree.
#
# The canonical version lives in electron/package.json. Every other site
# listed below must hold the same value. Run by CI on every PR and called
# from scripts/bump-version.sh after a bump. Exits non-zero on drift, with
# a list of mismatched sites.
#
# When you add a new file that must hold the PDV version, add a matching
# entry to the SITES array below and update scripts/bump-version.sh.

set -u

REPO_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

# Extract canonical version from electron/package.json without depending on
# Node being installed (the script runs in minimal CI images too).
CANONICAL=$(sed -nE 's/^[[:space:]]*"version":[[:space:]]*"([^"]+)".*/\1/p' \
                electron/package.json | head -1)
if [ -z "$CANONICAL" ]; then
    echo "error: could not read canonical version from electron/package.json" >&2
    exit 1
fi

echo "Canonical version: $CANONICAL"
echo

# Each entry: "file|grep-ERE that must match with $CANONICAL substituted"
# The pattern must match exactly once and only when the file holds the
# correct value. Avoid patterns that could accidentally match unrelated
# version strings (e.g. test fixture module versions, dependency floors).
SITES=(
    "pdv-python/pyproject.toml|^version = \"$CANONICAL\"\$"
    "electron/package.json|^[[:space:]]+\"version\": \"$CANONICAL\","
    "README.md|\`v$CANONICAL\`"
    "ARCHITECTURE.md|^\*\*Version\*\*: $CANONICAL\$"
    ".github/scripts/generate-release-notes.sh|e\.g\. v$CANONICAL"
    "examples/modules/N-pendulum/pdv-module.json|\"pdv_min\": \"$CANONICAL\""
    "examples/modules/N-pendulum-julia/pdv-module.json|\"pdv_min\": \"$CANONICAL\""
    # Test fixtures used to be listed here. They now derive at runtime from
    # electron/package.json via TEST_PDV_VERSION — see issue #235.
)

bad=0
for entry in "${SITES[@]}"; do
    file="${entry%%|*}"
    pat="${entry#*|}"
    if [ ! -f "$file" ]; then
        echo "  ✗ $file: file does not exist"
        bad=1
        continue
    fi
    if grep -qE -- "$pat" "$file"; then
        echo "  ✓ $file"
    else
        # Find what version IS there for a useful error message.
        found=$(grep -oE '[0-9]+\.[0-9]+\.[0-9]+([.-][A-Za-z0-9]+)?' "$file" | sort -u | tr '\n' ' ')
        echo "  ✗ $file: pattern not found; versions present: ${found:-none}"
        bad=1
    fi
done

echo
if [ $bad -ne 0 ]; then
    echo "Version parity check FAILED."
    echo "Fix: run scripts/bump-version.sh $CANONICAL to align all sites,"
    echo "     or update the SITES array if a file legitimately diverges."
    exit 1
fi
echo "Version parity check passed."
