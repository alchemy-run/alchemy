# Builds and tests blockd on Linux: Rust, libclang for libublk's bindings,
# and the e2fsprogs/FUSE tools the attach modes use.
FROM rust:1.94-bookworm
RUN apt-get update -qq \
 && apt-get install -y -qq --no-install-recommends libclang-dev clang fuse2fs fuse3 e2fsprogs kmod \
 && rm -rf /var/lib/apt/lists/*
