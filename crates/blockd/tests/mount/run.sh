#!/usr/bin/env bash
# End-to-end test of `blockd mount`: one mount serving many commands, fsync
# surviving a killed blockd, and detach making one snapshot. Loop mode needs
# /dev/fuse, loop devices and the right to mount; nbd mode needs the nbd
# module loaded on the Docker host.
# Usage: crates/blockd/tests/mount/run.sh [loop nbd ublk]
set -euo pipefail
repo="$(cd "$(dirname "$0")/../../../.." && pwd)"
image="$("$repo/crates/blockd/tests/image.sh")"
modes=("$@")
[ ${#modes[@]} -eq 0 ] && modes=(loop)
docker run --rm \
  -v "$repo":/work -w /work \
  -v blockd-cargo-registry:/usr/local/cargo/registry \
  -v blockd-target:/target -e CARGO_TARGET_DIR=/target \
  "$image" cargo build --release -p blockd
docker run --rm --privileged \
  -v "$repo":/work -w /work \
  -v blockd-target:/target \
  "$image" bash crates/blockd/tests/mount/test.sh /target/release/blockd "${modes[@]}"
