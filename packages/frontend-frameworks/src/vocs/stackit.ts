import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import type { FrameworkBuildOptions } from "../core/Framework.ts";
import { makeStackitTarget } from "../core/StackitServe.ts";
import { make as makeNode, makeNodeTarget, type VocsNodeFrameworkOptions } from "./node.ts";

/** Vocs's Node server on a STACKIT Function behind the CDN. */
export const target = (config?: Parameters<typeof makeNodeTarget>[0]) =>
  makeStackitTarget(makeNodeTarget(config));
export default target;

/** Native Vocs development, with the production build above. */
export const make = Effect.fn(function* (options: VocsNodeFrameworkOptions = {}) {
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
        return yield* target().build!({
          root,
          framework: "vocs",
          env: buildOptions?.env,
        });
      }).pipe(Effect.provide(services)),
  };
});
