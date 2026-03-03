import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as HttpServerRequest from "effect/unstable/http/HttpServerRequest";
import * as Http from "../../Http.ts";
import { Worker } from "./Worker.ts";

export const HttpServer = Layer.effect(
  Http.HttpServer,
  Effect.gen(function* () {
    const worker = yield* Worker.ExecutionContext;
    return Http.HttpServer.of({
      // @ts-expect-error
      serve: Effect.fn(function* (handler) {
        yield* worker.listen(
          Effect.fn(function* (event) {
            if (event instanceof Request) {
              return yield* handler.pipe(
                Effect.provideService(
                  HttpServerRequest.HttpServerRequest,
                  HttpServerRequest.fromWeb(event),
                ),
                Effect.orDie,
              );
            }
          }),
        );
      }),
    });
  }),
);
