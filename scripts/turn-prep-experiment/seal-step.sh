#!/usr/bin/env bash
# Turn Prep Experiment — one step of the ordered re-seal.
# Usage: seal-step.sh <applyChapter|-> <promptChapter|-> [campaign]
# Applies <applyChapter>'s output (if given), then writes <promptChapter>'s prompt (if given).
set -euo pipefail
cd "$(dirname "$0")/../.."
CAMPAIGN="${3:-exp-c1-rebuilt}"
run() {
    EXP_CAMPAIGN="$CAMPAIGN" EXP_MODE="$1" EXP_CHAPTER="$2" \
        npx vitest run --config scripts/turn-prep-experiment/vitest.experiment.config.ts --reporter=verbose --silent=false 2>&1 \
        | grep -E "\[seal-harness\]|Error|failed" || true
}
[ "$1" != "-" ] && run apply "$1"
[ "$2" != "-" ] && run prompt "$2"
exit 0
