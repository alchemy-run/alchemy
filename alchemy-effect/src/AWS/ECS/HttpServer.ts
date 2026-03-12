import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as HttpServerRequest from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import * as Config from "effect/Config";
import * as Http from "../../Http.ts";
import { Task } from "./Task.ts";

export const HttpServer = Layer.effect(
  Http.HttpServer,
  Effect.gen(function* () {
    const task = yield* Task.Runtime;

    return Http.server({
      serve: (handler) =>
        (task.run(
          (Effect.gen(function* () {
            const port = yield* Config.number("PORT").pipe(
              Config.withDefault(3000),
            );

            const server = Bun.serve({
              port,
              fetch: (request) =>
                handler.pipe(
                  Effect.provideService(
                    HttpServerRequest.HttpServerRequest,
                    HttpServerRequest.fromWeb(request),
                  ),
                  Effect.flatMap((response) =>
                    Effect.gen(function* () {
                      const services = yield* Effect.services();
                      return HttpServerResponse.toWeb(response, { services });
                    }),
                  ),
                  (effect) => Effect.runPromise(effect as any),
                ),
            });

            yield* Effect.addFinalizer(() => Effect.sync(() => server.stop(true)));
            yield* Effect.never;
          }) as Effect.Effect<void, never, any>),
        ) as any),
    });
  }),
);
