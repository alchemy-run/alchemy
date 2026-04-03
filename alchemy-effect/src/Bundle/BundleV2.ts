import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Queue from "effect/Queue";
import * as Result from "effect/Result";
import * as Stream from "effect/Stream";
import * as rolldown from "rolldown";
import { sha256 } from "../Util/sha256.ts";

export interface BundleOutput {
  /**
   * The files in the bundle.
   * The first file is the entry.
   */
  readonly files: [BundleFile, ...BundleFile[]];
  /**
   * The SHA-256 hash of all files in the bundle.
   */
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
      const bundle = await rolldown.rolldown({
        ...inputOptions,
        optimization: inputOptions.optimization ?? {
          inlineConst: {
            mode: "smart",
            pass: 3,
          },
        },
      });
      const result = await bundle.write(outputOptions);
      await bundle.close();
      return result.output;
    },
    catch: bundleErrorFromUnknown,
  }).pipe(
    Effect.flatMap(Effect.forEach(bundleFileFromOutputChunk)),
    Effect.flatMap(bundleOutputFromFiles),
  );

/**
 * Watch for changes in the bundle and return a stream of bundle output.
 * @param inputOptions - The input options for the bundle.
 * @param outputOptions - The output options for the bundle.
 * @returns A stream of Result instances containing either the bundle output or an error.
 */
export const watch = (
  inputOptions: rolldown.InputOptions,
  outputOptions?: rolldown.OutputOptions,
): Stream.Stream<
  Result.Result<BundleOutput, BundleError>,
  never,
  FileSystem.FileSystem
> =>
  Stream.callback<
    Extract<rolldown.RolldownWatcherEvent, { code: "BUNDLE_END" | "ERROR" }>
  >((queue) =>
    Effect.acquireRelease(
      Effect.sync(() => {
        const watcher = rolldown.watch({
          ...inputOptions,
          output: outputOptions,
        });
        watcher.on("event", (event) => {
          if (event.code === "BUNDLE_END" || event.code === "ERROR") {
            Queue.offerUnsafe(queue, event);
            event.result.close().catch(() => {});
          } else if (event.code === "END") {
            Queue.endUnsafe(queue);
          }
        });
        return watcher;
      }),
      (watcher) => Effect.promise(() => watcher.close()),
    ),
  ).pipe(
    Stream.flatMap((event) => {
      if (event.code === "ERROR") {
        return Stream.succeed(Result.fail(bundleErrorFromUnknown(event.error)));
      }
      if (event.output.length === 0) {
        return Stream.succeed(
          Result.fail(
            new BundleError({
              message: "No output files",
            }),
          ),
        );
      }
      return Stream.fromEffect(
        Effect.forEach(
          event.output as [string, ...string[]],
          bundleFileFromPath,
        ).pipe(
          Effect.flatMap(bundleOutputFromFiles),
          Effect.map(Result.succeed),
          Effect.catchTag("BundleError", (error) =>
            Effect.succeed(Result.fail(error)),
          ),
        ),
      );
    }),
    // TODO(john): is this necessary?
    // Stream.changesWith((left, right) => {
    //   if (left._tag === "Failure" && right._tag === "Failure") {
    //     return left.failure.message === right.failure.message;
    //   }
    //   if (left._tag === "Success" && right._tag === "Success") {
    //     return left.success.hash === right.success.hash;
    //   }
    //   return false;
    // }),
  );

function bundleErrorFromUnknown(error: unknown): BundleError {
  const message = error instanceof Error ? error.message : String(error);
  return new BundleError({
    message,
    cause: error,
  });
}

function bundleOutputFromFiles(
  files: [BundleFile, ...BundleFile[]],
): Effect.Effect<BundleOutput> {
  return Effect.map(
    sha256(
      JSON.stringify(
        files.map((file) => ({
          path: file.path,
          hash: file.hash,
        })),
      ),
    ),
    (hash) => ({ files, hash }),
  );
}

function bundleFileFromPath(
  path: string,
): Effect.Effect<BundleFile, BundleError, FileSystem.FileSystem> {
  return FileSystem.FileSystem.use((fs) => fs.readFile(path)).pipe(
    Effect.flatMap((content) =>
      Effect.map(sha256(content), (hash) => ({
        path,
        content,
        hash,
      })),
    ),
    Effect.mapError(
      (error) =>
        new BundleError({
          message: `Failed to read bundle file ${path}: ${error.message}`,
          cause: error,
        }),
    ),
  );
}

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
