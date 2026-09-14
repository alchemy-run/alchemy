import type * as cf from "@cloudflare/workers-types";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import type * as Exit from "effect/Exit";
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

    return yield* toHandledWebResponse(safeHandler).pipe(
      Effect.provide([
        Layer.succeed(HttpServerRequest.HttpServerRequest, request),
        Layer.succeed(Request, webRequest as any),
      ]),
    );
  }) as any;
};

const toHandledWebResponse = <Req>(
  handler: Effect.Effect<HttpServerResponse.HttpServerResponse, never, Req>,
) =>
  Effect.gen(function* () {
    // `toHandled` exposes the final response through this callback, not its
    // return value. Keep the assignment isolated here so callers get Response.
    const context = yield* Effect.context();
    const webResponse = yield* Deferred.make<Response>();
    // The bridge's per-event scope, which holds the telemetry flush
    // finalizers, is the ambient scope here; `toHandled` opens the request
    // scope beneath it. A streamed body outlives the handler's return, so it
    // takes ownership of both: the bridge skips its close-on-return for an
    // ejected event scope, and the request scope's oldest finalizer closes
    // the event scope once the body has settled.
    const eventScope = Context.getOption(context, Scope.Scope);
    let transferred = false;
    const owningEventScope = Option.isNone(eventScope)
      ? handler
      : Effect.gen(function* () {
          const requestScope = yield* Effect.scope;
          // Registered before the handler acquires anything, so it runs after
          // every finalizer the handler and its body attach to the request
          // scope: the exporter flushes after the stream's finalizer spans.
          yield* Scope.addFinalizerExit(requestScope, (exit) =>
            transferred ? closeEventScope(eventScope.value, exit) : Effect.void,
          );
          return yield* handler;
        });

    yield* EffectHttp.toHandled(owningEventScope, (request, response) => {
      if (request.method === "HEAD") {
        // A HEAD answer never runs its body. Drop it before the transfer
        // would eject a request scope that nothing closes; `toWeb` keeps the
        // GET's headers, content type and length included.
        return Deferred.succeed(
          webResponse,
          HttpServerResponse.toWeb(response, { withoutBody: true, context }),
        );
      }
      if (response.body._tag === "Stream" && Option.isSome(eventScope)) {
        transferred = true;
        EffectHttp.scopeDisableClose(eventScope.value);
      }
      return Deferred.succeed(
        webResponse,
        // Conversion to web response with options matches `EffectHttp.toWebHandler`'s callback.
        HttpServerResponse.toWeb(EffectHttp.scopeTransferToStream(response), {
          context,
        }),
      );
    });
    return yield* Deferred.await(webResponse);
  });

/**
 * The HttpMiddleware tracer ends the request's root span in a dispatcher
 * task scheduled after the handler effect resolves. A body that settles in
 * that same task must not flush ahead of the span: yield one macrotask
 * first, as the bridge's close-on-return path does.
 */
const closeEventScope = (
  scope: Scope.Scope,
  exit: Exit.Exit<unknown, unknown>,
) =>
  Effect.promise(
    () => new Promise<void>((resolve) => setTimeout(resolve, 0)),
  ).pipe(Effect.andThen(Scope.close(scope, exit)));

export { isScopeEjected } from "../../Http.ts";
