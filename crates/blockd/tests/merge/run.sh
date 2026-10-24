#!/usr/bin/env bash
# End-to-end test of calls and merges: a command on an ephemeral fork makes
# a patch, a mounted head applies it, checkpoints report what the head
# changed on its own, and a diff of two snapshots. Runs on ext4 and btrfs.
# Usage: crates/blockd/tests/merge/run.sh [ext4 btrfs]
set -euo pipefail
repo="$(cd "$(dirname "$0")/../../../.." && pwd)"
image="$("$repo/crates/blockd/tests/image.sh")"
filesystems=("$@")
[ ${#filesystems[@]} -eq 0 ] && filesystems=(ext4 btrfs)
docker run --rm \
  -v "$repo":/work -w /work \
  -v blockd-cargo-registry:/usr/local/cargo/registry \
  -v blockd-target:/target -e CARGO_TARGET_DIR=/target \
  "$image" cargo build --release -p blockd
docker run --rm --privileged \
  -v "$repo":/work -w /work \
  -v blockd-target:/target \
  "$image" bash crates/blockd/tests/merge/test.sh /target/release/blockd "${filesystems[@]}"
