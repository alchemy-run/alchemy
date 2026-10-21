# Builds and tests blockd on Linux: Rust, libclang for libublk's bindings,
# zig + cargo-zigbuild for static cross builds, and the e2fsprogs/FUSE tools
# the attach modes use, and btrfs-progs (6.11+, for mkfs --subvol).
FROM rust:1.94-trixie
RUN apt-get update -qq \
 && apt-get install -y -qq --no-install-recommends libclang-dev clang fuse3 e2fsprogs btrfs-progs kmod xz-utils util-linux \
 && rm -rf /var/lib/apt/lists/*
ARG ZIG=0.14.1
RUN arch=$(uname -m) && curl -fsSL "https://ziglang.org/download/${ZIG}/zig-${arch}-linux-${ZIG}.tar.xz" | tar -xJ -C /opt \
 && ln -s /opt/zig-${arch}-linux-${ZIG}/zig /usr/local/bin/zig \
 && cargo install --locked cargo-zigbuild \
 && rustup target add x86_64-unknown-linux-musl aarch64-unknown-linux-musl \
 && rustup component add clippy
