import * as BunHttpServerPlatform from "@effect/platform-bun/BunHttpServer";
import * as NodeHttpServerPlatform from "@effect/platform-node/NodeHttpServer";
import * as Cause from "effect/Cause";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import type { Scope } from "effect/Scope";
import * as ServiceMap from "effect/ServiceMap";
import type { HttpBodyError } from "effect/unstable/http/HttpBody";
import type { HttpServerError } from "effect/unstable/http/HttpServerError";
import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import * as NodeHttp from "node:http";

// TODO(sam): move to this https://github.com/Effect-TS/effect/blob/main/packages/platform/README.md#http-server
// import * as HttpServer from "effect/unstable/http/HttpServer";

// Effect.gen(function* () {
//   yield* HttpServer.serve()()
// });

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
      options?: {
        port?: number;
      },
    ) => Effect.Effect<void, never, Exclude<Req, HttpServerRequest> | Scope>;
  }
>()("HttpServer") {}

export const safeHttpEffect = <Req = never>(handler: HttpEffect<Req>) =>
  Effect.catchCause(handler, (cause) => {
    const message = Option.match(Cause.findErrorOption(cause), {
      onNone: () => "Internal Server Error",
      onSome: (error) => error.message ?? "Internal Server Error",
    });

    return Effect.map(
      Effect.all([Effect.logInfo(message), Effect.logInfo(cause)]),
      () =>
        HttpServerResponse.text(message, {
          status: 500,
          statusText: message,
        }),
    );
  });

const resolvePort = (options: { port?: number } | undefined) =>
  options?.port !== undefined
    ? Effect.succeed(options.port)
    : Config.number("PORT").pipe(Config.withDefault(3000)).asEffect();

/** Bun runtime (`Bun.serve`). */
export const BunHttpServer = () =>
  Layer.succeed(HttpServer, {
    serve: (handler, options) =>
      Effect.gen(function* () {
        const port = yield* resolvePort(options);
        const server = yield* BunHttpServerPlatform.make({ port });
        yield* server.serve(safeHttpEffect(handler));
      }).pipe(Effect.orDie),
  });

/** Node.js runtime (`node:http`). */
export const NodeHttpServer = () =>
  Layer.succeed(HttpServer, {
    serve: (handler, options) =>
      Effect.gen(function* () {
        const port = yield* resolvePort(options);
        const server = yield* NodeHttpServerPlatform.make(
          NodeHttp.createServer,
          {
            port,
          },
        );
        yield* server.serve(safeHttpEffect(handler));
      }).pipe(Effect.orDie),
  });
