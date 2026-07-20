import * as Effect from "effect/Effect";
import * as Artifacts from "../../../Artifacts.ts";
import {
  readPythonWorkerBundle,
  watchPythonWorkerBundle,
} from "../PythonWorkerBundle.ts";
import type {
  SourceContext,
  SourceDevHandle,
  SourceProvider,
} from "../Source.ts";

/**
 * Source provider for Python workers (`.py` entry): no bundling — the
 * entry plus sibling `.py` files upload as Python modules with
 * dependencies vendored via uv. The read is cached per run under the
 * shared `"build"` artifact key so diff and reconcile vendor once.
 */
export const makePythonSource = (main: string): SourceProvider => {
  const pythonOptions = (ctx: SourceContext) => ({
    id: ctx.id,
    main,
    compatibility: ctx.compatibility,
  });
  const build = (ctx: SourceContext) =>
    readPythonWorkerBundle(pythonOptions(ctx)).pipe(Artifacts.cached("build"));
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
      Effect.succeed({
        mode: "bundle",
        bundles: watchPythonWorkerBundle(pythonOptions(ctx)),
      } satisfies SourceDevHandle),
  };
};
