/**
 * Builds (and caches) the Live Lambda bridge bundle — the code deployed to
 * AWS Lambda in place of the user's handler under `alchemy dev`.
 */
import * as Effect from "effect/Effect";
import { fileURLToPath } from "node:url";
import * as Bundle from "../../../Bundle/Bundle.ts";
import { zipCode } from "../../../Util/zip.ts";
import { sha256 } from "../../../Util/sha256.ts";
import type { FunctionCodeBundle } from "../Function.ts";

const BRIDGE_ENTRY_URL = import.meta.resolve(
  import.meta.url.endsWith(".ts") ? "./Bridge.ts" : "./Bridge.js",
  import.meta.url,
);

let cached:
  | { identityHash: string; archive: Uint8Array<ArrayBufferLike> }
  | undefined;

/**
 * The bridge's {@link FunctionCodeBundle}. Identical for every function —
 * per-function wiring travels via environment variables — so the build and
 * zip are memoized per process.
 */
export const bridgeCodeBundle: Effect.Effect<
  FunctionCodeBundle,
  Bundle.BundleError
> = Effect.gen(function* () {
  if (!cached) {
    const output = yield* Bundle.build(
      {
        input: fileURLToPath(BRIDGE_ENTRY_URL),
        platform: "node",
      },
      {
        format: "esm",
        entryFileNames: "index.js",
        sourcemap: false,
        minify: false,
        codeSplitting: false,
      },
    );
    const mainFile = output.files[0];
    const code =
      typeof mainFile.content === "string"
        ? new TextEncoder().encode(mainFile.content)
        : mainFile.content;
    const archive = yield* zipCode(code);
    const archiveHash = yield* sha256(archive);
    cached = { identityHash: archiveHash, archive };
  }
  const { identityHash, archive } = cached;
  return {
    identityHash,
    buildArchive: Effect.succeed({ archive, archiveHash: identityHash }),
  };
});
