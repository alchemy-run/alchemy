#!/usr/bin/env bash
# Builds static Linux blockd binaries for sandbox images, into target/blockd/:
#   blockd-x86_64   blockd-aarch64
# (object storage, NBD and loop modes; ublk needs a native build).
# Usage: crates/blockd/build.sh [x86_64|aarch64 ...]
set -euo pipefail
repo="$(cd "$(dirname "$0")/../.." && pwd)"
arches=("${@:-x86_64 aarch64}")
image="$("$repo/crates/blockd/tests/image.sh")"
mkdir -p "$repo/target/blockd"
for arch in ${arches[@]}; do
  docker run --rm -v "$repo":/work -w /work \
    -v blockd-cargo-registry:/usr/local/cargo/registry \
    -v blockd-target:/target -e CARGO_TARGET_DIR=/target \
    "$image" bash -c "cargo zigbuild --release -p blockd --no-default-features --features object,fuse --target $arch-unknown-linux-musl \
      && cp /target/$arch-unknown-linux-musl/release/blockd /work/target/blockd/blockd-$arch"
  echo "$repo/target/blockd/blockd-$arch"
done
