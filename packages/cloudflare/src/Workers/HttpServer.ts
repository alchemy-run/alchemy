import type * as cf from "@cloudflare/workers-types";
import * as Http from "alchemy/Http";
import { RuntimeContext } from "alchemy/RuntimeContext";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import type * as Exit from "effect/Exit";
import * as EffectHttp from "effect/http/HttpEffect";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Scope from "effect/Scope";
import { DurableObjectState } from "./DurableObjectState.ts";
import { Request } from "./Request.ts";
import type { WorkerServices } from "./Worker.ts";
import { isWorkerEvent, WorkerExecutionContext } from "./WorkerRuntime.ts";

export type HttpEffect = Http.HttpEffect<WorkerServices>;

export const makeRequestHandler =
  <Req = never>(handler: Http.HttpEffect<Req> | Effect.Effect<Http.HttpEffect<Req>>) =>
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
    const request = HttpServerRequest.fromWeb(webRequest as any as globalThis.Request).modify({
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
    // The event ends once the body closes, so the close runs in the event's
    // `waitUntil`: the flush neither holds back the body's EOF nor is cut off.
    // `getOrUndefined` skips the Worker reference's deferred default, so only
    // the bridge-provided context counts.
    const waitUntil =
      Context.getOrUndefined(context, WorkerExecutionContext)?.waitUntil ??
      Context.getOrUndefined(context, DurableObjectState)?.waitUntil;
    const runtimeContext = Context.getOrUndefined(context, RuntimeContext);
    const background =
      waitUntil === undefined || runtimeContext === undefined
        ? undefined
        : (effect: Effect.Effect<void>) =>
            waitUntil(effect).pipe(Effect.provideService(RuntimeContext, runtimeContext));
    let transferred = false;
    const owningEventScope = Option.isNone(eventScope)
      ? handler
      : Effect.gen(function* () {
          const requestScope = yield* Effect.scope;
          // Registered before the handler acquires anything, so it runs after
          // every finalizer the handler and its body attach to the request
          // scope: the exporter flushes after the stream's finalizer spans.
          yield* Scope.addFinalizerExit(requestScope, (exit) =>
            transferred
              ? closeEventScope(eventScope.value as Scope.Closeable, exit, background)
              : Effect.void,
          );
          return yield* handler;
        });

    yield* EffectHttp.toHandled(owningEventScope, (request, response) => {
      const withoutBody = request.method === "HEAD";
      if (!HttpServerResponse.omitsBody(response, withoutBody)) {
        if (response.body._tag === "Stream" && Option.isSome(eventScope)) {
          transferred = true;
          EffectHttp.scopeDisableClose(eventScope.value);
        }
        response = EffectHttp.scopeTransferToStream(response);
      }
      return Deferred.succeed(
        webResponse,
        HttpServerResponse.toWeb(response, { withoutBody, context }),
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
  scope: Scope.Closeable,
  exit: Exit.Exit<unknown, unknown>,
  background: ((effect: Effect.Effect<void>) => Effect.Effect<void>) | undefined,
): Effect.Effect<void> => {
  const close = Effect.callback<void>((resume) => {
    const handle = setTimeout(() => resume(Effect.void), 0);
    return Effect.sync(() => clearTimeout(handle));
  }).pipe(Effect.andThen(Scope.close(scope, exit)));
  return background === undefined ? close : background(close);
};

export { isScopeEjected } from "alchemy/Http";
