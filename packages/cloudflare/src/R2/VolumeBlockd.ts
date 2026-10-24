import { blockdBinaries } from "@alchemy.run/sandbox/Blockd";
import { contextTarget } from "alchemy/Image/Context";
import type { ImageLayer } from "alchemy/Image/Layer";
import * as Effect from "effect/Effect";

export { blockdBinaries };

/**
 * The image layer that installs blockd and the tools its attach modes use:
 * `mount` and `losetup` (util-linux) for loop mode, e2fsprogs to check a disk.
 */
export const blockdLayer = Effect.map(blockdBinaries, (source): ImageLayer => {
  const target = contextTarget("blockd");
  return {
    id: "blockd",
    stage: "setup",
    context: [{ kind: "directory", target, source }],
    instructions: [
      `COPY ${target} /opt/blockd`,
      'RUN install -m 0755 "/opt/blockd/blockd-$(uname -m)" /usr/local/bin/blockd && rm -rf /opt/blockd \\',
      " && if command -v apt-get >/dev/null 2>&1; then apt-get update && apt-get install -y --no-install-recommends ca-certificates e2fsprogs mount fuse3 && rm -rf /var/lib/apt/lists/*; \\",
      "  elif command -v apk >/dev/null 2>&1; then apk add --no-cache ca-certificates e2fsprogs util-linux fuse3; \\",
      "  elif command -v dnf >/dev/null 2>&1; then dnf install -y ca-certificates e2fsprogs util-linux fuse3 && dnf clean all; fi",
    ].join("\n"),
  };
});
