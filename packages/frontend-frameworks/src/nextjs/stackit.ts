import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import type { FrameworkBuildOptions } from "../core/Framework.ts";
import { makeStackitTarget } from "../core/StackitServe.ts";
import { make as makeNode, makeNodeTarget, type NextjsNodeOptions } from "./node.ts";

/**
 * Next.js's production Node server on a STACKIT Function behind the CDN. `.next`
 * ships in the image and `next` is installed there, as on the other container
 * targets. This is not OpenNext.
 */
export const target = (config?: Parameters<typeof makeNodeTarget>[0]) =>
  makeStackitTarget(makeNodeTarget(config));
export default target;

/** Native Next.js development, with the production build above. */
export const make = Effect.fn(function* (options: NextjsNodeOptions = {}) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const node = yield* makeNode(options);
  const services = Layer.mergeAll(
    Layer.succeed(FileSystem.FileSystem)(fs),
    Layer.succeed(Path.Path)(path),
  );
  return {
    dev: node.dev,
    build: (buildOptions?: FrameworkBuildOptions) =>
      Effect.gen(function* () {
        const root = yield* Effect.sync(() =>
          path.resolve(buildOptions?.root ?? options.root ?? process.cwd()),
        );
        return yield* target({ root }).build!({
          root,
          framework: "nextjs",
          env: buildOptions?.env,
        });
      }).pipe(Effect.provide(services)),
  };
});
