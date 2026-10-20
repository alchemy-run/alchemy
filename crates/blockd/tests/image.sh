#!/usr/bin/env bash
# Builds the test image once; prints its tag.
set -euo pipefail
dir="$(cd "$(dirname "$0")" && pwd)"
docker build -q -t blockd-test "$dir" >/dev/null
echo blockd-test
