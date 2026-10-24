/**
 * Where blockd's Linux binaries are at deploy, for the hosts that install
 * them: `$ALCHEMY_BLOCKD_DIR`, or the repository's `target/blockd`, built by
 * `crates/blockd/build.sh`:
 *
 * - `blockd-<arch>`: static (musl); sandbox images, and a container's init;
 * - `blockd-host-<arch>`: glibc 2.35+, every attach mode with ublk: the
 *   daemon on workspace hosts.
 */
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

export class BlockdNotFound extends Data.TaggedError("BlockdNotFound")<{
  readonly message: string;
}> {}

/** The directory holding blockd's binaries. */
export const blockdBinaries = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const fromEnv = yield* Effect.sync(() => process.env.ALCHEMY_BLOCKD_DIR);
  const candidates = fromEnv ? [fromEnv] : [];
  let dir = path.dirname(yield* path.fromFileUrl(new URL(import.meta.url)));
  for (let i = 0; i < 8; i++) {
    candidates.push(path.join(dir, "target", "blockd"));
    dir = path.dirname(dir);
  }
  for (const candidate of candidates) {
    if (yield* fs.exists(path.join(candidate, "blockd-x86_64"))) return candidate;
  }
  return yield* new BlockdNotFound({
    message:
      "No blockd binaries found: run crates/blockd/build.sh (or set ALCHEMY_BLOCKD_DIR to a directory with blockd-x86_64 and blockd-aarch64).",
  });
});
