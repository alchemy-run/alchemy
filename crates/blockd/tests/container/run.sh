#!/usr/bin/env bash
# End-to-end test of commands in containers: calls and a head's commands run
# under runc and under gVisor's runsc, with an image from the store.
# Usage: crates/blockd/tests/container/run.sh [container gvisor]
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
  "$image" bash crates/blockd/tests/container/test.sh /target/release/blockd "/target/$(docker run --rm "$image" uname -m)-unknown-linux-musl/release/blockd" "${runtimes[@]}"
