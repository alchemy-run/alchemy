import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import type { Scope } from "effect/Scope";
import * as ServiceMap from "effect/ServiceMap";
import type { HttpBodyError } from "effect/unstable/http/HttpBody";
import type { HttpServerError } from "effect/unstable/http/HttpServerError";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";

export const serve = <Req = never>(
  handler: Effect.Effect<
    HttpServerResponse.HttpServerResponse,
    HttpServerError | HttpBodyError,
    HttpServerRequest | Scope | Req
  >,
) => HttpServer.use((http) => http.serve(handler));

export class HttpServer extends ServiceMap.Service<
  HttpServer,
  {
    serve: <Req = never>(
      handler: Effect.Effect<
        HttpServerResponse.HttpServerResponse,
        HttpServerError | HttpBodyError,
        Req
      >,
    ) => Effect.Effect<void, never, Exclude<Req, HttpServerRequest | Scope>>;
  }
>()("HttpServer") {}

export const server = (http: {
  serve: <Req = never>(
    handler: Effect.Effect<HttpServerResponse.HttpServerResponse, never, Req>,
  ) => Effect.Effect<void, never, Exclude<Req, HttpServerRequest | Scope>>;
}) =>
  HttpServer.of({
    serve: (handler) =>
      http.serve(
        Effect.catchCause(handler, (cause) => {
          const message = Option.match(Cause.findErrorOption(cause), {
            onNone: () => "Internal Server Error",
            onSome: (error) => error.message ?? "Internal Server Error",
          });

          return Effect.succeed(
            HttpServerResponse.text(message, {
              status: 500,
              statusText: message,
            }),
          );
        }),
      ),
  });
