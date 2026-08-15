import type * as cf from "@cloudflare/workers-types";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Scope from "effect/Scope";
import * as EffectHttp from "effect/unstable/http/HttpEffect";
import * as HttpServerRequest from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import * as Http from "../../Http.ts";
import { Request } from "./Request.ts";
import { isWorkerEvent, type WorkerServices } from "./Worker.ts";

export type HttpEffect = Http.HttpEffect<WorkerServices>;

export const makeRequestHandler =
  <Req = never>(
    handler: Http.HttpEffect<Req> | Effect.Effect<Http.HttpEffect<Req>>,
  ) =>
  (event: any) =>
    isWorkerEvent(event) && event.type === "fetch"
      ? makeRequestEffect(event.input, handler)
      : undefined;

export const makeRequestEffect = <Req = never>(
  webRequest: cf.Request,
  handler: Http.HttpEffect<Req> | Effect.Effect<Http.HttpEffect<Req>>,
) => {
  const safeHandler = Http.safeHttpEffect(handler);
  return Effect.gen(function* () {
    // The bridge-provided per-event scope (WorkerBridge.processEvent /
    // DurableObjectBridge.#execute) — handed to toHandledWebResponse so the
    // handler's finalizers settle post-response with it via ctx.waitUntil.
    const requestScope = yield* Effect.scope;
    const request = HttpServerRequest.fromWeb(
      webRequest as any as globalThis.Request,
    ).modify({
      remoteAddress: Option.fromUndefinedOr(
        webRequest.headers.get("cf-connecting-ip") ?? undefined,
      ),
    });

    Object.defineProperty(request, "raw", {
      get: () =>
        Object.assign(request.stream, {
          raw: webRequest.body,
        }),
    });

    return yield* toHandledWebResponse(safeHandler, requestScope).pipe(
      Effect.provide([
        Layer.succeed(HttpServerRequest.HttpServerRequest, request),
        Layer.succeed(Request, webRequest as any),
      ]),
    );
  }) as any;
};

const toHandledWebResponse = <Req>(
  handler: Effect.Effect<HttpServerResponse.HttpServerResponse, never, Req>,
  requestScope: Scope.Scope,
) =>
  Effect.gen(function* () {
    // `toHandled` exposes the final response through this callback, not its
    // return value. Keep the assignment isolated here so callers get Response.
    const context = yield* Effect.context();
    const webResponse = yield* Deferred.make<Response>();

    yield* EffectHttp.toHandled(handler, (request, response) =>
      Effect.flatMap(Effect.scope, (handlerScope) =>
        Effect.gen(function* () {
          // `toHandled` runs the handler under its OWN internal scope
          // (shadowing the bridge's per-event scope) and closes it INLINE
          // right after this callback — a handler's `Effect.addFinalizer`
          // would delay the response by the finalizer's full duration.
          // Eject it and settle it with the bridge's request scope instead,
          // which the bridge closes post-response via `ctx.waitUntil` —
          // honoring the documented contract that request finalizers run
          // after the response. Streaming bodies keep effect's native
          // transfer: `scopeTransferToStream` ejects the scope itself and
          // closes it when the body stream ends. (Mirrors the Vercel
          // FunctionBridge's toHandledWebResponse.)
          if (response.body._tag !== "Stream") {
            EffectHttp.scopeDisableClose(handlerScope);
            yield* Scope.addFinalizerExit(requestScope, (exit) =>
              Scope.close(handlerScope, exit),
            );
          }
          yield* Deferred.succeed(
            webResponse,
            // Conversion to web response with options matches
            // `EffectHttp.toWebHandler`'s callback.
            HttpServerResponse.toWeb(
              EffectHttp.scopeTransferToStream(response),
              {
                withoutBody: request.method === "HEAD",
                context,
              },
            ),
          );
        }),
      ),
    );
    return yield* Deferred.await(webResponse);
  });

export { isScopeEjected } from "../../Http.ts";
