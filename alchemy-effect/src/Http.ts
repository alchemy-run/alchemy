import * as Effect from "effect/Effect";
import type { Scope } from "effect/Scope";
import * as ServiceMap from "effect/ServiceMap";
import type { HttpServerError } from "effect/unstable/http/HttpServerError";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import {
  type HttpServerResponse,
  text,
} from "effect/unstable/http/HttpServerResponse";

export class HttpServer extends ServiceMap.Service<
  HttpServer,
  {
    serve: <Req = never>(
      handler: Effect.Effect<
        HttpServerResponse,
        HttpServerError,
        HttpServerRequest | Scope | Req
      >,
    ) => Effect.Effect<void, never, Req>;
  }
>()("HttpServer") {}

export const serve = (
  handler: Effect.Effect<
    HttpServerResponse,
    HttpServerError,
    HttpServerRequest | Scope
  >,
) =>
  HttpServer.use((http) =>
    http.serve(
      handler.pipe(
        Effect.catch((error) =>
          Effect.succeed(
            text(`Error: ${error.message}`, {
              status: 500,
            }),
          ),
        ),
      ),
    ),
  );
