import type { RspackOptions, Stats } from "@rspack/core";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import * as crypto from "node:crypto";
import { DotAlchemy } from "../Config.ts";
import {
  BundleError,
  Bundler,
  type BundleOptions,
  type BundleOutput,
  type StdinOptions,
  type WatchOutput,
} from "./Bundler.ts";

type RspackRuntime = (typeof import("@rspack/core"))["rspack"];

export const rspack = () =>
  Layer.effect(
    Bundler,
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const pathService = yield* Path.Path;
      const dotAlchemy = yield* DotAlchemy;

      const resolveStdin = (options: BundleOptions) =>
        Effect.gen(function* () {
          if (!options.stdin) {
            return { options, cleanup: Effect.void };
          }

          const ext = getLoaderExtension(options.stdin.loader);
          const hash = crypto
            .createHash("sha256")
            .update(options.stdin.contents)
            .digest("hex")
            .slice(0, 8);
          const resolveDir = options.stdin.resolveDir ?? process.cwd();
          const tempDir = pathService.join(
            resolveDir,
            pathService.basename(dotAlchemy),
            "tmp",
          );
          const tempFile = pathService.join(tempDir, `stdin-${hash}${ext}`);

          yield* fs
            .makeDirectory(tempDir, { recursive: true })
            .pipe(Effect.orDie);
          yield* fs
            .writeFileString(tempFile, options.stdin.contents)
            .pipe(Effect.orDie);

          return {
            options: { ...options, entry: tempFile, stdin: undefined },
            cleanup: fs.remove(tempFile).pipe(Effect.ignore),
          };
        });

      return {
        build: (options) =>
          Effect.gen(function* () {
            const { options: resolved, cleanup } = yield* resolveStdin(options);
            const rspack = yield* loadRspack();
            const stats = yield* Effect.tryPromise({
              try: () =>
                new Promise<Stats>((resolve, reject) => {
                  const compiler = rspack(toRspackOptions(resolved, rspack));
                  compiler.run((err, stats) => {
                    compiler.close(() => {});
                    if (err) {
                      reject(err);
                    } else if (stats?.hasErrors()) {
                      const errors = stats.compilation.errors.map((e) => ({
                        message: e.message,
                      }));
                      reject(
                        new BundleError({
                          message: errors[0]?.message ?? "Build failed",
                          errors,
                        }),
                      );
                    } else {
                      resolve(stats!);
                    }
                  });
                }),
              catch: (error) =>
                error instanceof BundleError ? error : fromRspackError(error),
            });
            yield* cleanup;
            return fromRspackStats(stats);
          }),

        watch: (options) =>
          Effect.gen(function* () {
            const queue = yield* Queue.unbounded<WatchOutput>();
            const { options: resolved, cleanup } = yield* resolveStdin(options);
            const rspack = yield* loadRspack();
            const compiler = rspack(toRspackOptions(resolved, rspack));

            const watching = compiler.watch({}, (err, stats) => {
              if (err) return;
              if (stats && !stats.hasErrors()) {
                Queue.offerUnsafe(queue, fromRspackStats(stats));
              }
            });

            yield* Effect.addFinalizer(() =>
              Effect.andThen(
                cleanup,
                Effect.promise(
                  () =>
                    new Promise<void>((resolve) => {
                      watching.close(() => {
                        compiler.close(() => {
                          resolve();
                        });
                      });
                    }),
                ),
              ),
            );

            return { queue };
          }),
      };
    }),
  );

function toRspackOptions(
  options: BundleOptions,
  rspack: RspackRuntime,
): RspackOptions {
  const entry =
    typeof options.entry === "string"
      ? options.entry
      : Array.isArray(options.entry)
        ? options.entry
        : options.entry;

  const treeshake = options.treeshake !== false;

  return {
    entry,
    output: {
      path: options.outdir,
      filename: options.outfile ? options.outfile.split("/").pop() : undefined,
      library: options.format === "esm" ? { type: "module" } : undefined,
      clean: true,
    },
    mode: options.minify ? "production" : "development",
    devtool: options.sourcemap
      ? options.sourcemap === "inline"
        ? "inline-source-map"
        : "source-map"
      : false,
    externals: options.external,
    externalsType: options.format === "esm" ? "module" : undefined,
    target: options.platform === "node" ? "node" : "web",
    experiments: options.format === "esm" ? { outputModule: true } : undefined,
    resolve: {
      extensions: [".ts", ".js", ".mjs"],
      conditionNames: ["bun", "import", "module", "default"],
    },
    module: {
      rules: [
        {
          test: /\.ts$/,
          use: {
            loader: "builtin:swc-loader",
            options: {
              jsc: {
                parser: { syntax: "typescript" },
                target: "es2022",
              },
            },
          },
        },
      ],
    },
    optimization: {
      minimize: options.minify,
      minimizer: options.minify
        ? [
            new rspack.SwcJsMinimizerRspackPlugin({
              minimizerOptions: {
                compress: {
                  passes: 0,
                  pure_getters: true,
                  toplevel: true,
                  reduce_funcs: true,
                  hoist_props: true,
                },
                mangle: { toplevel: true },
                module: true,
                ecma: 2022,
              },
            }),
          ]
        : [],
      usedExports: treeshake,
      sideEffects: treeshake,
      providedExports: treeshake,
      innerGraph: treeshake,
      concatenateModules: treeshake,
      mangleExports: treeshake ? "size" : false,
      avoidEntryIife: true,
    },
  };
}

const loadRspack = () =>
  Effect.tryPromise({
    try: () => import("@rspack/core").then((module) => module.rspack),
    catch: fromRspackError,
  });

function fromRspackStats(stats: Stats): BundleOutput {
  const json = stats.toJson({ assets: true });
  return {
    outputs:
      json.assets?.map((asset) => ({
        path: asset.name,
        size: asset.size,
      })) ?? [],
    duration:
      stats.endTime && stats.startTime
        ? stats.endTime - stats.startTime
        : undefined,
  };
}

function fromRspackError(error: unknown): BundleError {
  if (error instanceof Error) {
    return new BundleError({
      message: error.message,
      errors: [{ message: error.message }],
      cause: error,
    });
  }
  return new BundleError({
    message: String(error),
    errors: [{ message: String(error) }],
    cause: error,
  });
}

function getLoaderExtension(loader?: StdinOptions["loader"]): string {
  switch (loader) {
    case "ts":
      return ".ts";
    case "tsx":
      return ".tsx";
    case "jsx":
      return ".jsx";
    case "json":
      return ".json";
    case "css":
      return ".css";
    case "text":
      return ".txt";
    default:
      return ".js";
  }
}
