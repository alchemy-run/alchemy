#!/usr/bin/env bash
# Run the whole GCP test suite in batches of service directories.
#
# The test runner imports every file up front in one process, and the full
# GCP suite (~1,100 files) needs more memory than most machines have. This
# runs it in batches, each a separate runner process, and prints a summary.
#
#   pnpm test:gcp                      # profile alchemy-testing
#   pnpm test:gcp --fast               # extra flags go to every batch
#   GCP_TEST_BATCH=10 pnpm test:gcp    # smaller batches if memory is tight
set -uo pipefail

cd "$(dirname "$0")/../packages/alchemy"

BATCH="${GCP_TEST_BATCH:-25}"
PROFILE="${ALCHEMY_PROFILE:-alchemy-testing}"
mapfile -t DIRS < <(ls -d test/GCP/*/)
TOP=(test/GCP/*.test.ts)

total=${#DIRS[@]}
failed=()
for ((i = 0; i < total; i += BATCH)); do
  batch=("${DIRS[@]:i:BATCH}")
  (( i == 0 )) && batch+=("${TOP[@]}")
  echo "=== batch $((i / BATCH + 1)): ${batch[0]} … ${batch[-1]}"
  if ! bun alchemy-test "${batch[@]}" --profile "$PROFILE" "$@"; then
    failed+=("$((i / BATCH + 1))")
  fi
done

if (( ${#failed[@]} > 0 )); then
  echo "Failed batches: ${failed[*]} (full logs under packages/alchemy/.alchemy/log/test/)"
  exit 1
fi
echo "All GCP batches passed."
