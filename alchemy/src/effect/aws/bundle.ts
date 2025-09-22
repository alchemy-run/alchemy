import * as Effect from "effect/Effect";
import esbuild from "esbuild";

export const bundle = Effect.fn(function* (props: esbuild.BuildOptions) {
  console.log("bundling", props);
  return yield* Effect.tryPromise({
    try: () => esbuild.build(props),
    catch: (error) => Effect.fail(error),
  });
});
