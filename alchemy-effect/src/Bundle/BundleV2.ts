import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as rolldown from "rolldown";
import { sha256 } from "../Util/sha256.ts";

export interface BundleOutput {
  readonly files: [BundleFile, ...BundleFile[]];
  readonly hash: string;
}

export interface BundleFile {
  readonly path: string;
  readonly content: string | Uint8Array<ArrayBufferLike>;
  readonly hash: string;
}

export class BundleError extends Data.TaggedError("BundleError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

/**
 * Build a bundle using rolldown from the given input options and output options.
 * @param inputOptions - The input options for the bundle.
 * @param outputOptions - The output options for the bundle.
 * @returns The bundle output.
 */
export const build = (
  inputOptions: rolldown.InputOptions,
  outputOptions?: rolldown.OutputOptions,
): Effect.Effect<BundleOutput, BundleError> =>
  Effect.tryPromise({
    try: async () => {
      const bundle = await rolldown.rolldown(inputOptions);
      const result = await bundle.write(outputOptions);
      await bundle.close();
      return result.output;
    },
    catch: (error) => {
      const message = error instanceof Error ? error.message : String(error);
      return new BundleError({
        message,
        cause: error,
      });
    },
  }).pipe(
    Effect.flatMap(Effect.forEach(bundleFileFromOutputChunk)),
    Effect.flatMap((files) =>
      Effect.map(
        sha256(
          JSON.stringify(
            files.map((file) => ({
              path: file.path,
              hash: file.hash,
            })),
          ),
        ),
        (hash) => ({ files, hash }),
      ),
    ),
  );

function bundleFileFromOutputChunk(
  chunk: rolldown.OutputChunk | rolldown.OutputAsset,
): Effect.Effect<BundleFile> {
  switch (chunk.type) {
    case "chunk":
      return Effect.map(sha256(chunk.code), (hash) => ({
        path: chunk.fileName,
        content: chunk.code,
        hash,
      }));
    case "asset":
      return Effect.map(sha256(chunk.source), (hash) => ({
        path: chunk.fileName,
        content: chunk.source,
        hash,
      }));
  }
}
