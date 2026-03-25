import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import type { Scope } from "effect/Scope";
import * as ServiceMap from "effect/ServiceMap";
import type { HttpBodyError } from "effect/unstable/http/HttpBody";
import type { HttpServerError } from "effect/unstable/http/HttpServerError";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";

export type HttpEffect<Req = never> = Effect.Effect<
  HttpServerResponse.HttpServerResponse,
  HttpServerError | HttpBodyError,
  HttpServerRequest | Scope | Req
>;

export const serve = <Req = never>(
  handler: Effect.Effect<
    HttpServerResponse.HttpServerResponse,
    HttpServerError | HttpBodyError,
    HttpServerRequest | Scope | Req
  >,
) =>
  Effect.serviceOption(HttpServer).pipe(
    Effect.map(Option.getOrUndefined),
    Effect.tap((http) => Effect.logInfo("http", http)),
    Effect.flatMap((http) => (http ? http.serve(handler) : Effect.void)),
  );

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
    serve: (handler) => http.serve(serveSafe(handler)),
  });

export const serveSafe = <Req = never>(handler: HttpEffect<Req>) =>
  Effect.catchCause(handler, (cause) => {
    const message = Option.match(Cause.findErrorOption(cause), {
      onNone: () => "Internal Server Error",
      onSome: (error) => error.message ?? "Internal Server Error",
    });
    return Effect.map(Effect.logDebug(message), () =>
      HttpServerResponse.text(message, {
        status: 500,
        statusText: message,
      }),
    );
  });
