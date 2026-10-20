import { contextTarget } from "alchemy/Image/Context";
import type { ImageLayer } from "alchemy/Image/Layer";
/**
 * Where the static blockd binaries for sandbox images are (`blockd-x86_64`,
 * `blockd-aarch64`): `$ALCHEMY_BLOCKD_DIR`, or the repository's
 * `target/blockd` built by `crates/blockd/build.sh`.
 *
 * NOT exported from `index.ts`.
 */
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { VolumeImageError } from "./VolumeImage.ts";

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
  return yield* new VolumeImageError({
    message:
      "No blockd binaries found: run crates/blockd/build.sh (or set ALCHEMY_BLOCKD_DIR to a directory with blockd-x86_64 and blockd-aarch64).",
  });
});

/** The image layer that installs blockd and the tools its attach modes use. */
export const blockdLayer = Effect.map(blockdBinaries, (source): ImageLayer => {
  const target = contextTarget("blockd");
  return {
    id: "blockd",
    stage: "setup",
    context: [{ kind: "directory", target, source }],
    instructions: [
      `COPY ${target} /opt/blockd`,
      'RUN install -m 0755 "/opt/blockd/blockd-$(uname -m)" /usr/local/bin/blockd && rm -rf /opt/blockd \\',
      " && if command -v apt-get >/dev/null 2>&1; then apt-get update && apt-get install -y --no-install-recommends ca-certificates e2fsprogs fuse2fs fuse3 && rm -rf /var/lib/apt/lists/*; \\",
      "  elif command -v apk >/dev/null 2>&1; then apk add --no-cache ca-certificates e2fsprogs e2fsprogs-extra fuse3; \\",
      "  elif command -v dnf >/dev/null 2>&1; then dnf install -y ca-certificates e2fsprogs fuse3 && dnf clean all; fi",
    ].join("\n"),
  };
});
