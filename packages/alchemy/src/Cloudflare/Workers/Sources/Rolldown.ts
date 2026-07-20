import * as Effect from "effect/Effect";
import * as Artifacts from "../../../Artifacts.ts";
import type {
  SourceContext,
  SourceDevHandle,
  SourceProvider,
} from "../Source.ts";
import { WorkerBundle, type WorkerBundleOptions } from "../WorkerBundle.ts";

/**
 * The default source provider: bundle `props.main` with rolldown.
 *
 * `hash()` deliberately builds — recomputing "without building" is
 * impossible for rolldown without a source-tree memo hash, and today's
 * semantics accept that. The build routes through `Artifacts.cached`
 * under the same key as `build()`, so a diff that had to build shares
 * its output with the reconcile in the same run.
 */
export const makeRolldownSource = (options: {
  main: string;
}): SourceProvider => {
  const bundleOptions = (ctx: SourceContext): WorkerBundleOptions => ({
    id: ctx.id,
    main: options.main,
    compatibility: ctx.compatibility,
    entry: ctx.entry,
    stack: ctx.stack,
    extraOptions: ctx.extraOptions,
  });
  const build = (ctx: SourceContext) =>
    Effect.gen(function* () {
      const bundler = yield* WorkerBundle;
      return yield* bundler.build(bundleOptions(ctx));
    }).pipe(Artifacts.cached("build"));
  return {
    ownsAssets: false,
    build: (ctx) =>
      build(ctx).pipe(
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
    hash: (ctx) =>
      build(ctx).pipe(Effect.map((output) => ({ bundle: output.hash }))),
    dev: (ctx) =>
      Effect.gen(function* () {
        const bundler = yield* WorkerBundle;
        return {
          mode: "bundle",
          bundles: bundler.watch(bundleOptions(ctx)),
        } satisfies SourceDevHandle;
      }),
  };
};
