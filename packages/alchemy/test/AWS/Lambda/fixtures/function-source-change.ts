import * as Lambda from "@/AWS/Lambda";
import * as Effect from "effect/Effect";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";

export class SourceChangeFunction extends Lambda.Function<Lambda.Function>()(
  "SourceChangeFunction",
) {}

export const SourceChangeFunctionLive = SourceChangeFunction.make(
  {
    main: import.meta.url,
    functionUrl: false,
    build: {
      external: (moduleId) =>
        moduleId.endsWith("function-source-change-dependency.ts"),
    },
  },
  Effect.gen(function* () {
    return {
      fetch: Effect.gen(function* () {
        const loadDependency = yield* Effect.sync(
          () => process.env.LOAD_SOURCE_CHANGE_DEPENDENCY === "true",
        );
        if (loadDependency) {
          yield* Effect.tryPromise(
            () => import("./function-source-change-dependency.ts"),
          ).pipe(Effect.orDie);
        }
        return HttpServerResponse.text("source-v1");
      }),
    };
  }),
);

export default SourceChangeFunctionLive;
