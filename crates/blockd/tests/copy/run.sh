#!/usr/bin/env bash
# End-to-end test of copy mode: an unprivileged container with no block
# devices and no FUSE, like a Lambda MicroVM.
set -euo pipefail
repo="$(cd "$(dirname "$0")/../../../.." && pwd)"
image="$("$repo/crates/blockd/tests/image.sh")"
docker run --rm \
  -v "$repo":/work -w /work \
  -v blockd-cargo-registry:/usr/local/cargo/registry \
  -v blockd-target:/target -e CARGO_TARGET_DIR=/target \
  "$image" cargo build --release -p blockd
docker run --rm --cap-drop ALL --cap-add CHOWN --cap-add DAC_OVERRIDE --cap-add FOWNER --cap-add FSETID \
  -v "$repo":/work:ro -w /work \
  -v blockd-target:/target:ro \
  "$image" bash crates/blockd/tests/copy/test.sh /target/release/blockd
