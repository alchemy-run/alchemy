#!/usr/bin/env bash
# Builds Linux blockd binaries into target/blockd/:
#   blockd-x86_64        blockd-aarch64        static (musl): sandbox images, and
#                                              a container's init (object storage,
#                                              NBD and loop modes)
#   blockd-host-x86_64   blockd-host-aarch64   glibc 2.35+, every attach mode with
#                                              ublk: the daemon on workspace hosts
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
    "$image" bash -c "rustup target add $arch-unknown-linux-gnu >/dev/null 2>&1; \
      cargo zigbuild --release -p blockd --no-default-features --features object,fuse --target $arch-unknown-linux-musl \
      && cp /target/$arch-unknown-linux-musl/release/blockd /work/target/blockd/blockd-$arch \
      && cargo zigbuild --release -p blockd --target $arch-unknown-linux-gnu.2.35 \
      && cp /target/$arch-unknown-linux-gnu/release/blockd /work/target/blockd/blockd-host-$arch"
  echo "$repo/target/blockd/blockd-$arch $repo/target/blockd/blockd-host-$arch"
done
