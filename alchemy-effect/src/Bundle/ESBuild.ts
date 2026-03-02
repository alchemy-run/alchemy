import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import type * as Scope from "effect/Scope";
import * as ServiceMap from "effect/ServiceMap";
import type esbuild from "esbuild";

export class ESBuild extends ServiceMap.Service<
  ESBuild,
  {
    build<T extends esbuild.BuildOptions>(
      options: esbuild.SameShape<esbuild.BuildOptions, T>,
    ): Effect.Effect<esbuild.BuildResult<T>, ESBuildError>;
    context<T extends esbuild.BuildOptions>(
      options: esbuild.SameShape<esbuild.BuildOptions, T>,
    ): Effect.Effect<
      {
        queue: Queue.Queue<esbuild.BuildResult<T>>;
        rebuild: () => Effect.Effect<
          esbuild.BuildResult<T>,
          ESBuildError,
          never
        >;
      },
      ESBuildError,
      Scope.Scope
    >;
  }
>()("ESBuild") {}

export const ESBuildLive = () =>
  Layer.effect(
    ESBuild,
    Effect.gen(function* () {
      const esbuild = yield* Effect.promise(() => import("esbuild"));
      return ESBuild.of({
        build: Effect.fnUntraced(function* (options) {
          return yield* Effect.tryPromise({
            try: () => esbuild.build(options),
            catch: ESBuildError.map,
          });
        }),
        context: Effect.fnUntraced(function* (options) {
          const queue = yield* Queue.unbounded<esbuild.BuildResult>();
          const context = yield* Effect.tryPromise({
            try: async () =>
              esbuild.context({
                ...options,
                plugins: [
                  ...(options.plugins ?? []),
                  {
                    name: "queue",
                    setup: (build) => {
                      build.onEnd((result) => {
                        // TODO(sam): why are we doing something unsafe here?
                        Queue.offerUnsafe(queue, result as esbuild.BuildResult);
                      });
                    },
                  },
                ],
              }),
            catch: ESBuildError.map,
          });
          yield* Effect.addFinalizer(() =>
            Effect.promise(() => context.dispose()),
          );
          yield* Effect.tryPromise({
            try: () => context.watch(),
            catch: ESBuildError.map,
          });
          return {
            queue,
            rebuild: Effect.fnUntraced(function* () {
              return yield* Effect.tryPromise({
                try: (): Promise<esbuild.BuildResult> => context.rebuild(),
                catch: ESBuildError.map,
              });
            }),
          };
        }),
      });
    }),
  );

export class ESBuildError extends Data.TaggedError("ESBuildError")<{
  message: string;
  errors: esbuild.Message[];
  messages: esbuild.Message[];
}> {
  static map(error: unknown): ESBuildError {
    const cause = error as esbuild.BuildFailure;
    return new ESBuildError({
      message: cause.message,
      errors: cause.errors,
      messages: cause.warnings,
    });
  }
}
