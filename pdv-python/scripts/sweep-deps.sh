#!/usr/bin/env bash
# pdv-python/scripts/sweep-deps.sh — local dependency-resolution sweep.
#
# For each (Python version, extras combo, resolution strategy) cell:
#   - create a fresh uv venv on the target Python
#   - install pdv-python with the given extras and resolution strategy
#   - install pytest separately (so 'lowest-direct' doesn't floor pytest itself
#     to its earliest PyPI release)
#   - run the test suite, capture pass/fail/skip counts and duration
#
# Boundary Python versions (oldest + newest supported) get the full
#   extras x resolution sweep; mid versions get one [dev]+highest smoke run.
#
# Writes per-cell logs and a results.csv summary to a workspace dir under
#   ${PDV_SWEEP_WORKDIR:-/tmp/pdv-dep-sweep}.
#
# Requires: uv (>= 0.4 for --resolution=lowest-direct), and either cached or
# downloadable CPython builds for the matrix Python versions.

set -u

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd -- "$SCRIPT_DIR/.." && pwd)"
WORKDIR="${PDV_SWEEP_WORKDIR:-/tmp/pdv-dep-sweep}"
RESULTS="$WORKDIR/results.csv"
LOGDIR="$WORKDIR/logs"

# Boundary Python versions get full sweep; mid versions get smoke runs.
BOUNDARY_PYTHONS=(3.10 3.14)
SMOKE_PYTHONS=(3.11 3.12 3.13)
EXTRAS_LIST=("" "data" "copy" "dev")
RESOLUTIONS=(highest lowest-direct)

if ! command -v uv >/dev/null 2>&1; then
    echo "error: uv not found on PATH" >&2
    exit 2
fi

rm -rf "$WORKDIR/venvs" "$LOGDIR" "$RESULTS"
mkdir -p "$LOGDIR"
echo "python,extras,resolution,install_ok,pytest_rc,passed,failed,errors,skipped,duration_s,resolved_pkgs" > "$RESULTS"

run_cell() {
    local py="$1" extras="$2" res="$3"
    local label="py${py}_${extras//[\[\],]/_}_${res}"
    local venv="$WORKDIR/venvs/$label"
    local log="$LOGDIR/${label}.log"

    echo "=============================================="
    echo "RUN: python=$py extras=$extras resolution=$res"
    echo "log: $log"
    echo "=============================================="

    rm -rf "$venv"
    {
        echo "### uv venv --python $py"
        uv venv --python "$py" "$venv" 2>&1 || { echo "VENV_FAIL"; return; }

        local target="$PROJECT_DIR"
        if [ -n "$extras" ]; then
            target="${PROJECT_DIR}[${extras}]"
        fi
        local res_flag=""
        if [ "$res" = "lowest-direct" ]; then
            res_flag="--resolution=lowest-direct"
        fi

        echo "### uv pip install $res_flag $target  (package only)"
        VIRTUAL_ENV="$venv" uv pip install $res_flag "$target" 2>&1
        local pkg_rc=$?
        if [ $pkg_rc -ne 0 ]; then
            echo "PACKAGE_INSTALL_FAILED rc=$pkg_rc"
        else
            echo "### uv pip install pytest pytest-asyncio  (default resolution)"
            VIRTUAL_ENV="$venv" uv pip install "pytest>=8" "pytest-asyncio>=0.23" 2>&1
        fi
    } > "$log" 2>&1

    if grep -q "PACKAGE_INSTALL_FAILED" "$log"; then
        echo "$py,$extras,$res,no,,,,,,," >> "$RESULTS"
        echo "  -> package install FAILED (see $log)"
        return
    fi
    if [ ! -x "$venv/bin/python" ]; then
        echo "$py,$extras,$res,no,,,,,,," >> "$RESULTS"
        echo "  -> venv missing (see $log)"
        return
    fi

    local resolved
    resolved=$(VIRTUAL_ENV="$venv" uv pip list --format=freeze 2>/dev/null | tr '\n' '|')

    echo "### pytest" >> "$log"
    local start end dur
    start=$(date +%s)
    VIRTUAL_ENV="$venv" "$venv/bin/python" -m pytest "$PROJECT_DIR/tests" -q --no-header \
        --tb=line -o cache_dir="$WORKDIR/.pcache" \
        >> "$log" 2>&1
    local pytest_rc=$?
    end=$(date +%s)
    dur=$((end - start))

    # Pytest summary line: e.g. "1 failed, 413 passed, 44 skipped in 1.99s"
    local summary
    summary=$(grep -E "^[0-9]+ (passed|failed|error|skipped)" "$log" | tail -1)
    local passed failed errors skipped
    passed=$(echo "$summary" | grep -oE "[0-9]+ passed"  | grep -oE "[0-9]+" || echo 0)
    failed=$(echo "$summary" | grep -oE "[0-9]+ failed"  | grep -oE "[0-9]+" || echo 0)
    errors=$(echo "$summary" | grep -oE "[0-9]+ error"   | grep -oE "[0-9]+" || echo 0)
    skipped=$(echo "$summary" | grep -oE "[0-9]+ skipped" | grep -oE "[0-9]+" || echo 0)
    passed=${passed:-0}; failed=${failed:-0}; errors=${errors:-0}; skipped=${skipped:-0}

    echo "$py,$extras,$res,yes,$pytest_rc,$passed,$failed,$errors,$skipped,$dur,\"$resolved\"" >> "$RESULTS"
    echo "  -> rc=$pytest_rc passed=$passed failed=$failed errors=$errors skipped=$skipped dur=${dur}s"
}

for py in "${BOUNDARY_PYTHONS[@]}"; do
    for extras in "${EXTRAS_LIST[@]}"; do
        for res in "${RESOLUTIONS[@]}"; do
            run_cell "$py" "$extras" "$res"
        done
    done
done
for py in "${SMOKE_PYTHONS[@]}"; do
    run_cell "$py" "dev" "highest"
done

echo
echo "=========== RESULTS ==========="
awk -F, 'NR==1{print; next} {printf "%s,%s,%s,%s,%s,%s,%s,%s,%s,%s\n", $1,$2,$3,$4,$5,$6,$7,$8,$9,$10}' "$RESULTS" | column -t -s,
echo
echo "Logs:    $LOGDIR"
echo "CSV:     $RESULTS"
echo
echo "Exit non-zero if any cell failed (install or test):"
if awk -F, 'NR>1 && ($4=="no" || ($5!="" && $5!="0"))' "$RESULTS" | grep -q .; then
    echo "  SWEEP FAILURES PRESENT"
    exit 1
fi
echo "  all green"
