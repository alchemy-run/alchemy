#!/usr/bin/env bash
# End-to-end test of FUSE attach: blockd serves the volume as one file and
# fuse2fs mounts the ext4 in it. The container gets /dev/fuse and SYS_ADMIN
# only (no --privileged, no block devices), like a FUSE-capable sandbox host.
set -euo pipefail
repo="$(cd "$(dirname "$0")/../../../.." && pwd)"
image="$("$repo/crates/blockd/tests/image.sh")"
docker run --rm \
  -v "$repo":/work -w /work \
  -v blockd-cargo-registry:/usr/local/cargo/registry \
  -v blockd-target:/target -e CARGO_TARGET_DIR=/target \
  "$image" cargo build --release -p blockd
docker run --rm --device /dev/fuse --cap-add SYS_ADMIN --security-opt apparmor:unconfined \
  -v "$repo":/work -w /work \
  -v blockd-target:/target \
  "$image" bash crates/blockd/tests/fuse/test.sh /target/release/blockd
