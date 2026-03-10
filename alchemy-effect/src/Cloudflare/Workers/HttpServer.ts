import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type { Scope } from "effect/Scope";
import * as HttpServerRequest from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import * as Http from "../../Http.ts";
import { isWorkerEvent, Worker } from "./Worker.ts";

export const HttpServer = Layer.effect(
  Http.HttpServer,
  Effect.gen(function* () {
    const worker = yield* Worker.Runtime;
    return Http.server({
      serve: (handler) =>
        worker.listen((event) => {
          if (isWorkerEvent(event) && event.type === "fetch") {
            const webRequest = toWebRequest(event.input);
            const request = HttpServerRequest.fromWeb(webRequest).modify({
              remoteAddress: webRequest.headers.get("cf-connecting-ip") ?? undefined,
            });
            return handler.pipe(
              Effect.provideService(
                HttpServerRequest.HttpServerRequest,
                request,
              ),
              Effect.flatMap(toWebResponse),
            ) as Effect.Effect<
              Response,
              never,
              Exclude<
                Effect.Services<typeof handler>,
                HttpServerRequest.HttpServerRequest | Scope
              >
            >;
          }
        }),
    });
  }),
);

const toWebResponse = (
  response: HttpServerResponse.HttpServerResponse,
): Effect.Effect<Response> =>
  Effect.gen(function* () {
    const services = yield* Effect.services();
    return HttpServerResponse.toWeb(response, { services });
  });

const toWebRequest = (request: unknown): Request => request as Request;
