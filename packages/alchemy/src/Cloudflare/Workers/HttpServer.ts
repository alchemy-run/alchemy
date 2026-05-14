import type * as cf from "@cloudflare/workers-types";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import type { Scope } from "effect/Scope";
import * as EffectHttp from "effect/unstable/http/HttpEffect";
import { ClientAbort } from "effect/unstable/http/HttpServerError";
import * as HttpServerRequest from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import * as Http from "../../Http.ts";
import { Request } from "./Request.ts";
import { isWorkerEvent, type WorkerServices } from "./Worker.ts";

export type HttpEffect = Http.HttpEffect<WorkerServices>;

export const workersHttpHandler = <Req = never>(
  handler: Http.HttpEffect<Req> | Effect.Effect<Http.HttpEffect<Req>>,
) => {
  return (event: any) => {
    if (isWorkerEvent(event) && event.type === "fetch") {
      const webRequest = event.input;
      return serveWebRequest(webRequest, handler, {
        remoteAddress: webRequest.headers.get("cf-connecting-ip") ?? undefined,
      });
    }
  };
};

export const serveWebRequest = <Req = never>(
  webRequest: cf.Request,
  handler: Http.HttpEffect<Req> | Effect.Effect<Http.HttpEffect<Req>>,
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
    const context =
      yield* Effect.context<
        Exclude<Req, HttpServerRequest.HttpServerRequest | Scope>
      >();
    const request = HttpServerRequest.fromWeb(
      webRequest as any as globalThis.Request,
    ).modify({
      remoteAddress: Option.fromUndefinedOr(options.remoteAddress),
    });

    Object.defineProperty(request, "raw", {
      get: () =>
        Object.assign(request.stream, {
          raw: webRequest.body,
        }),
    });

    // Centralized error handling: every cause is caught, logged, and
    // rendered as a structured 500. Every entry into this function — the
    // Worker fetch path, the Durable Object fetch path in `Rpc.ts`, etc —
    // gets identical failure semantics, regardless of how the caller
    // produced `handler`.
    const safeHandler = Http.safeHttpEffect(handler);

    const resolveSymbol = Symbol.for("@effect/platform/HttpApp/resolve");
    const httpApp = EffectHttp.toHandled(safeHandler, (request, response) => {
      response = EffectHttp.scopeTransferToStream(response);
      (request as any)[resolveSymbol](
        HttpServerResponse.toWeb(response, {
          withoutBody: request.method === "HEAD",
          context,
        }),
      );
      return Effect.void;
    });

    return yield* Effect.promise(() => {
      return new Promise<Response>((resolve) => {
        const contextMap = new Map<string, any>(context.mapUnsafe);
        contextMap.set(HttpServerRequest.HttpServerRequest.key, request);
        contextMap.set(Request.key, webRequest);
        (request as any)[resolveSymbol] = resolve;
        const fiber = Effect.runForkWith(Context.makeUnsafe(contextMap))(
          httpApp as any,
        );
        webRequest.signal?.addEventListener(
          "abort",
          () => {
            fiber.interruptUnsafe(undefined, ClientAbort.annotation);
          },
          { once: true },
        );
      });
    });
  }) as any;
