import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type { Scope } from "effect/Scope";
import * as ServiceMap from "effect/ServiceMap";
import type { HttpServerError } from "effect/unstable/http/HttpServerError";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import {
  type HttpServerResponse,
  text,
} from "effect/unstable/http/HttpServerResponse";
import { ExecutionContext } from "./Executable.ts";

export const serve = Effect.fn(function* (
  handler: Effect.Effect<
    HttpServerResponse,
    HttpServerError,
    HttpServerRequest | Scope
  >,
) {
  const ctx = yield* ExecutionContext;

  const httpServer = yield* HttpServer;

  yield* httpServer.serve(
    handler.pipe(
      Effect.catch((error) =>
        Effect.succeed(
          text(`Error: ${error.message}`, {
            status: 500,
          }),
        ),
      ),
    ),
  );
});

export class HttpServer extends ServiceMap.Service<
  HttpServer,
  {
    serve: (
      handler: Effect.Effect<
        HttpServerResponse,
        HttpServerError,
        HttpServerRequest | Scope
      >,
    ) => Effect.Effect<void>;
  }
>()("HttpServer") {}

export const lambdaHttpServer = Layer.effect(
  HttpServer,
  Effect.gen(function* () {
    return {
      serve: serve,
    };
  }),
);

export const cloudflareHttpServer = Layer.effect(
  HttpServer,
  Effect.gen(function* () {
    const ctx = yield* ExecutionContext;

    return {
      serve: serve,
    };
  }),
);

export const nodeHttpServer = Layer.effect(
  HttpServer,
  Effect.gen(function* () {
    return {
      serve: serve,
    };
  }),
);

export const bunHttpServer = Layer.effect(
  HttpServer,
  Effect.gen(function* () {
    return {
      serve: serve,
    };
  }),
);
