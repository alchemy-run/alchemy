#!/usr/bin/env bash
# End-to-end test of kernel attach over NBD: builds blockd for Linux and runs
# tests/nbd/test.sh in a privileged container (the kernel must have NBD;
# Docker Desktop's does). Usage: crates/blockd/tests/nbd/run.sh
set -euo pipefail
repo="$(cd "$(dirname "$0")/../../../.." && pwd)"
image="$("$repo/crates/blockd/tests/image.sh")"
docker run --rm \
  -v "$repo":/work -w /work \
  -v blockd-cargo-registry:/usr/local/cargo/registry \
  -v blockd-target:/target -e CARGO_TARGET_DIR=/target \
  "$image" cargo build --release -p blockd
docker run --rm --privileged \
  -v "$repo":/work -w /work \
  -v blockd-target:/target \
  "$image" bash crates/blockd/tests/nbd/test.sh /target/release/blockd
