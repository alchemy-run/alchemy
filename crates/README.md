# crates

Forkable block volumes for sandboxes: a session's disk lives in object storage, and machines attach it per command.

- [`volume`](volume): the format and the store. Extents, packs, manifests (snapshots) and heads; `BlobStore` and `MetaStore` with local, memory and S3/R2/GCS backends. Pure Rust.
- [`blockd`](blockd): attaches a volume head as a block device. Lazy reads into a local cache, writes back on flush, and forks through a control socket. Kernel attach over NBD today.

```sh
cargo test --workspace                 # volume and the block layer (any OS)
crates/blockd/tests/nbd/run.sh         # ext4 on /dev/nbd0 in a privileged Linux container
```
