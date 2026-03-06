import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as _esbuild from "esbuild";
import {
  BundleError,
  Bundler,
  type BundleOptions,
  type BundleOutput,
  type WatchOutput,
} from "./Bundler.ts";

export const esbuild = () =>
  Layer.succeed(Bundler, {
    build: (options) =>
      Effect.tryPromise({
        try: () => _esbuild.build(toESBuildOptions(options)),
        catch: (e) => fromESBuildError(e as _esbuild.BuildFailure),
      }).pipe(Effect.map(fromESBuildResult)),

    watch: (options) =>
      Effect.gen(function* () {
        const queue = yield* Queue.unbounded<WatchOutput>();
        const context = yield* Effect.tryPromise({
          try: () =>
            _esbuild.context({
              ...toESBuildOptions(options),
              plugins: [
                {
                  name: "bundler-queue",
                  setup: (build) => {
                    build.onEnd((result) => {
                      Queue.offerUnsafe(queue, fromESBuildResult(result));
                    });
                  },
                },
              ],
            }),
          catch: (e) => fromESBuildError(e as _esbuild.BuildFailure),
        });
        yield* Effect.addFinalizer(() =>
          Effect.promise(() => context.dispose()),
        );
        yield* Effect.tryPromise({
          try: () => context.watch(),
          catch: (e) => fromESBuildError(e as _esbuild.BuildFailure),
        });
        return { queue };
      }),
  });

const toESBuildOptions = (options: BundleOptions): _esbuild.BuildOptions => ({
  entryPoints: options.stdin
    ? undefined
    : typeof options.entry === "string"
      ? [options.entry]
      : options.entry,
  stdin: options.stdin
    ? {
        contents: options.stdin.contents,
        resolveDir: options.stdin.resolveDir,
        sourcefile: options.stdin.sourcefile,
        loader: options.stdin.loader,
      }
    : undefined,
  outdir: options.outdir,
  outfile: options.outfile,
  format: options.format,
  minify: options.minify,
  sourcemap: options.sourcemap,
  external: options.external,
  platform: options.platform,
  target: options.target,
  define: options.define,
  splitting: options.splitting,
  bundle: true,
  write: true,
  treeShaking: options.treeshake ?? true,
  legalComments: "none",
  drop: ["debugger"],
  mainFields: ["module", "main"],
});

const fromESBuildResult = (result: _esbuild.BuildResult): BundleOutput => ({
  outputs:
    result.outputFiles?.map((f) => ({
      path: f.path,
      code: f.text,
      size: f.contents.byteLength,
    })) ?? [],
});

const fromESBuildError = (error: _esbuild.BuildFailure): BundleError =>
  new BundleError({
    message: error.message,
    errors: error.errors.map((e) => ({
      message: e.text,
      file: e.location?.file,
      line: e.location?.line,
      column: e.location?.column,
    })),
    cause: error,
  });
