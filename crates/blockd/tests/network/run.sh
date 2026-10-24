#!/usr/bin/env bash
# End-to-end test of commands' networks: a namespace of their own on a bridge,
# NAT out, the host's egress policy, allowlists, and ports reached from the host.
# Usage: crates/blockd/tests/network/run.sh [container gvisor]
set -euo pipefail
repo="$(cd "$(dirname "$0")/../../../.." && pwd)"
image="$("$repo/crates/blockd/tests/image.sh")"
runtimes=("$@")
[ ${#runtimes[@]} -eq 0 ] && runtimes=(container gvisor)
# The daemon (glibc, every attach mode) and a static blockd for containers' init.
docker run --rm \
  -v "$repo":/work -w /work \
  -v blockd-cargo-registry:/usr/local/cargo/registry \
  -v blockd-target:/target -e CARGO_TARGET_DIR=/target \
  "$image" bash -c 'cargo build --release -p blockd \
    && cargo zigbuild --release -p blockd --no-default-features --features object,fuse --target "$(uname -m)-unknown-linux-musl"'
docker run --rm --privileged \
  -v "$repo":/work -w /work \
  -v blockd-target:/target \
  "$image" bash crates/blockd/tests/network/test.sh /target/release/blockd "/target/$(docker run --rm "$image" uname -m)-unknown-linux-musl/release/blockd" "${runtimes[@]}"
