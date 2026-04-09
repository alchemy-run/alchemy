import type * as cf from "@cloudflare/workers-types";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import type { Scope } from "effect/Scope";
import type { HttpBodyError } from "effect/unstable/http/HttpBody";
import * as HttpServerError from "effect/unstable/http/HttpServerError";
import * as HttpServerRequest from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import * as Socket from "effect/unstable/socket/Socket";
import * as util from "node:util";
import * as Http from "../../Http.ts";
import { Request } from "./Request.ts";
import { isWorkerEvent, type WorkerServices } from "./Worker.ts";

export type HttpEffect = Http.HttpEffect<WorkerServices>;

export const workersHttpHandler = <Req = never>(
  handler: Http.HttpEffect<Req>,
) => {
  const safeHandler = Http.safeHttpEffect(handler);
  return (event: any) => {
    if (isWorkerEvent(event) && event.type === "fetch") {
      const webRequest = event.input;
      return serveWebRequest(webRequest, safeHandler, {
        remoteAddress: webRequest.headers.get("cf-connecting-ip") ?? undefined,
      });
    }
  };
};

export const serveWebRequest = <Req = never>(
  webRequest: cf.Request,
  handler: Effect.Effect<
    HttpServerResponse.HttpServerResponse,
    HttpServerError.HttpServerError | HttpBodyError,
    Req
  >,
  options: {
    // Preserve transport metadata when this helper is adapting a request
    // that originated from another runtime surface.
    remoteAddress?: string;
    // Durable Objects need to register the accepted socket on object state
    // instead of calling `server.accept()` directly.
    acceptWebSocket?: (socket: cf.WebSocket) => void;
  } = {},
): Effect.Effect<
  Response,
  never,
  Exclude<Req, HttpServerRequest.HttpServerRequest | Scope>
> =>
  Effect.gen(function* () {
    // `request.upgrade` and the eventual `101` response are two halves of the
    // same operation, so we keep them in closure state shared by all modified
    // views of this request.
    let upgradedSocket: Socket.Socket | undefined;
    let upgradeResponse: Response | undefined;
    const make = (
      base = HttpServerRequest.fromWeb(
        webRequest as any as globalThis.Request,
      ).modify({
        remoteAddress: Option.fromUndefinedOr(options.remoteAddress),
      }),
    ): HttpServerRequest.HttpServerRequest => {
      const request = Object.create(
        base,
      ) as HttpServerRequest.HttpServerRequest;

      // Effect handlers are allowed to call `request.modify(...)`. We need those
      // derived requests to preserve the same upgrade bookkeeping, otherwise a
      // handler could upgrade one view of the request and return another.
      Object.defineProperty(request, "modify", {
        value: (
          next: Parameters<HttpServerRequest.HttpServerRequest["modify"]>[0],
        ) => make(base.modify(next)),
      });

      // The generic `fromWeb(...)` request cannot implement server-side
      // websocket upgrade on its own, so Cloudflare injects the runtime-specific
      // behavior here.
      Object.defineProperty(request, "upgrade", {
        get: () => {
          if (upgradedSocket) {
            return Effect.succeed(upgradedSocket);
          }

          if (
            webRequest.method !== "GET" ||
            webRequest.headers.get("upgrade")?.toLowerCase() !== "websocket"
          ) {
            return Effect.fail(
              new HttpServerError.HttpServerError({
                reason: new HttpServerError.RequestParseError({
                  request,
                  description: "Not an upgradeable ServerRequest",
                }),
              }),
            );
          }

          const pair: [cf.WebSocket, cf.WebSocket] = new WebSocketPair();
          const client = pair[0];
          const server = pair[1];

          if (options.acceptWebSocket) {
            options.acceptWebSocket(server);
          } else {
            server.accept();
          }

          // Cloudflare completes the handshake by returning the client half in a
          // `101` response, while Effect code continues talking to the server
          // half through the `Socket` abstraction.
          upgradeResponse = new Response(null, {
            status: 101,
            webSocket: client,
          } as ResponseInit);
          upgradedSocket = Effect.runSync(
            Socket.fromWebSocket(
              Effect.acquireRelease(
                Effect.succeed(server as any as WebSocket),
                (ws) => Effect.sync(() => ws.close(1000)),
              ),
            ),
          );
          return Effect.succeed(upgradedSocket);
        },
      });

      return request;
    };

    const request = make();
    const response = yield* handler.pipe(
      Effect.provideService(HttpServerRequest.HttpServerRequest, request),
      Effect.provideService(Request, webRequest as any),
      Effect.catchCause((cause) => {
        console.error(
          "[serveWebRequest] handler error:",
          util.inspect(cause, { depth: null }),
          typeof cause,
        );
        const message = Option.match(Cause.findErrorOption(cause), {
          onNone: () => "Internal Server Error",
          onSome: (error) =>
            error instanceof Error && error.message
              ? error.message
              : "Internal Server Error",
        });
        return Effect.succeed(
          HttpServerResponse.text(message, {
            status: 500,
            statusText: message,
          }),
        );
      }),
    );
    // If the handler upgraded the request, the native handshake response must
    // win over the ordinary Effect response conversion path.
    if (upgradeResponse) return upgradeResponse;
    const services = yield* Effect.services();
    return HttpServerResponse.toWeb(response, { services });
  }) as any;
