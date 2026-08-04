import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import * as crypto from "node:crypto";
import type * as Bundle from "../../../Bundle/Bundle.ts";
import type { SourceDevHandle, SourceProvider } from "../Source.ts";

/**
 * Source provider for `props.script` workers: the raw module source is
 * uploaded as a single ESM module (`main.js`), bypassing bundling
 * entirely. The bundle hash is `sha256(script)` — identical to the
 * pre-SourceProvider `hashScript` slot, so persisted state diffs cleanly
 * across the refactor.
 */
export const makeInlineScriptSource = (script: string): SourceProvider => {
  const bundle = Effect.sync(() =>
    crypto.createHash("sha256").update(script).digest("hex"),
  ).pipe(
    Effect.map(
      (hash): Bundle.BundleOutput => ({
        files: [{ path: "main.js", content: script, hash }],
        hash,
      }),
    ),
  );
  return {
    ownsAssets: false,
    build: () =>
      bundle.pipe(
        Effect.map((output) => ({
          bundle: output,
          assets: undefined,
          hash: {
            bundle: output.hash,
            assets: undefined,
            input: undefined,
            additionalWorkspaces: undefined,
          },
        })),
      ),
    hash: () => bundle.pipe(Effect.map((output) => ({ bundle: output.hash }))),
    // Local dev: a single-element stream — script changes arrive as new
    // props, which restart the instance via `structuralSignature`.
    dev: () =>
      bundle.pipe(
        Effect.map(
          (output): SourceDevHandle => ({
            mode: "bundle",
            bundles: Stream.make({
              _tag: "Success",
              output,
            } as Bundle.BundleWatchEvent),
          }),
        ),
      ),
  };
};
