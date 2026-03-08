import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import type {
  InputOptions,
  OutputOptions,
  RolldownOutput,
  WatchOptions as RolldownWatchOptions,
} from "rolldown";
import * as _rolldown from "rolldown";
import {
  BundleError,
  Bundler,
  type BundleOptions,
  type BundleOutput,
  type WatchOutput,
} from "./Bundler.ts";

export const rolldown = () =>
  Layer.effect(
    Bundler,
    Effect.succeed({
      build: (options) =>
        Effect.tryPromise({
          try: async () => {
            const { input, output } = toRolldownOptions(options);
            const bundle = await _rolldown.rolldown(input);
            const result = await bundle.write(output);
            await bundle.close();
            return fromRolldownOutput(result);
          },
          catch: fromRolldownError,
        }),

      watch: (options) =>
        Effect.gen(function* () {
          const queue = yield* Queue.unbounded<WatchOutput>();
          const watcher = _rolldown.watch(toRolldownWatchOptions(options));

          watcher.on("event", (event) => {
            if (event.code === "BUNDLE_END") {
              Queue.offerUnsafe(queue, {
                outputs: event.output.map((p) => ({
                  path: p,
                  size: 0,
                })),
                duration: event.duration,
              });
              event.result.close().catch(() => {});
            }
          });

          yield* Effect.addFinalizer(() => Effect.promise(() => watcher.close()));

          return { queue };
        }),
    }),
  );

function toRolldownOptions(options: BundleOptions): {
  input: InputOptions;
  output: OutputOptions;
} {
  const platform = options.platform ?? "neutral";

  return {
    input: {
      platform,
      input:
        typeof options.entry === "string" ? [options.entry] : options.entry,
      external: options.external,
      treeshake:
        options.treeshake === false
          ? false
          : {
              moduleSideEffects: false,
              unknownGlobalSideEffects: false,
              propertyReadSideEffects: false,
              propertyWriteSideEffects: false,
            },
      optimization: {
        inlineConst: {
          mode: "all",
          pass: 3,
        },
      },
      experimental: {
        // Avoid eagerly expanding unused `export *` branches from package barrels.
        lazyBarrel: true,
      },
      resolve: {
        extensions: [".ts", ".js", ".mjs"],
        aliasFields: platform === "browser" ? [["browser"]] : [],
        conditionNames:
          platform === "node"
            ? ["bun", "import", "default"]
            : platform === "browser"
              ? ["bun", "browser", "import", "default"]
              : ["bun", "import", "default"],
        mainFields:
          platform === "node"
            ? ["module", "main"]
            : platform === "browser"
              ? ["browser", "module", "main"]
              : [],
      },
    },
    output: {
      dir: options.outdir,
      file: options.outfile,
      format: options.format === "iife" ? "iife" : options.format,
      sourcemap: options.sourcemap === "external" ? true : options.sourcemap,
      externalLiveBindings: false,
      minify: options.minify
        ? {
            compress: {
              target: "es2022",
              maxIterations: 10,
              treeshake: {
                propertyReadSideEffects: false,
                unknownGlobalSideEffects: false,
              },
            },
            mangle: { toplevel: true },
          }
        : false,
    },
  };
}

function toRolldownWatchOptions(options: BundleOptions): RolldownWatchOptions {
  const { input, output } = toRolldownOptions(options);
  return { ...input, output };
}

function fromRolldownOutput(result: RolldownOutput): BundleOutput {
  return {
    outputs: result.output.map((chunk) => ({
      path: "fileName" in chunk ? chunk.fileName : "",
      code: "code" in chunk ? chunk.code : undefined,
      map: "map" in chunk && chunk.map ? JSON.stringify(chunk.map) : undefined,
      size: "code" in chunk ? chunk.code.length : 0,
    })),
  };
}

function fromRolldownError(error: unknown): BundleError {
  const err = error as Error;
  return new BundleError({
    message: err.message ?? String(error),
    errors: [{ message: err.message ?? String(error) }],
    cause: error,
  });
}
