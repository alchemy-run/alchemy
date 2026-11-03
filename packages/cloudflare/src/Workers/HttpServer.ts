import type * as cf from "@cloudflare/workers-types";
import * as Http from "alchemy/Http";
import { RuntimeContext } from "alchemy/RuntimeContext";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import type * as Exit from "effect/Exit";
import * as HttpBody from "effect/http/HttpBody";
import * as EffectHttp from "effect/http/HttpEffect";
import { ClientAbort } from "effect/http/HttpServerError";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import { DurableObjectState } from "./DurableObjectState.ts";
import { Request } from "./Request.ts";
import type { WorkerServices } from "./Worker.ts";
import { isWorkerEvent, WorkerExecutionContext } from "./WorkerRuntime.ts";

export type HttpEffect = Http.HttpEffect<WorkerServices>;

export const makeRequestHandler =
  <Req = never>(handler: Http.HttpEffect<Req> | Effect.Effect<Http.HttpEffect<Req>>) =>
  (event: any) =>
    isWorkerEvent(event) && event.type === "fetch"
      ? makeRequestEffect(event.input, handler, event.context)
      : undefined;

export const makeRequestEffect = <Req = never>(
  webRequest: cf.Request,
  handler: Http.HttpEffect<Req> | Effect.Effect<Http.HttpEffect<Req>>,
  /** A Worker fetch's context. With it, a client abort interrupts the handler. */
  ctx?: cf.ExecutionContext,
) => {
  const signal = ctx && (webRequest as any as globalThis.Request).signal;
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

    // `toHandled` runs the request uninterruptibly; the handler opts back in,
    // as `HttpRouter` routes do, so a client abort reaches it.
    return yield* toHandledWebResponse(
      signal ? Effect.interruptible(safeHandler) : safeHandler,
    ).pipe(
      Effect.provide([
        Layer.succeed(HttpServerRequest.HttpServerRequest, request),
        Layer.succeed(Request, webRequest as any),
      ]),
    );
  }).pipe(interruptOnClientAbort(signal, ctx)) as any;
};

/**
 * Interrupts the request fiber when the client disconnects, as Effect's
 * `HttpEffect.toWebHandler` does, annotated with `ClientAbort` so
 * `causeResponse` answers 499. The signal only fires under the
 * `enable_request_signal` compatibility flag.
 *
 * workerd cancels the event's pending I/O once the client is gone, so the
 * abort also registers the fiber with `waitUntil`, letting the handler's
 * finalizers finish.
 */
const interruptOnClientAbort =
  (signal: AbortSignal | undefined, ctx: cf.ExecutionContext | undefined) =>
  <A, E, R>(self: Effect.Effect<A, E, R>) =>
    signal === undefined || ctx === undefined
      ? self
      : Effect.withFiber((fiber) => {
          const onAbort = () => {
            ctx.waitUntil(new Promise<void>((resolve) => fiber.addObserver(() => resolve())));
            fiber.interruptUnsafe(undefined, ClientAbort.annotation);
          };
          if (signal.aborted) {
            onAbort();
          } else {
            signal.addEventListener("abort", onAbort, { once: true });
            fiber.addObserver(() => signal.removeEventListener("abort", onAbort));
          }
          return self;
        });

const toHandledWebResponse = <Req>(
  handler: Effect.Effect<HttpServerResponse.HttpServerResponse, never, Req>,
) =>
  Effect.gen(function* () {
    // `toHandled` exposes the final response through this callback, not its
    // return value. Keep the assignment isolated here so callers get Response.
    const context = yield* Effect.context();
    const webResponse = yield* Deferred.make<Response>();
    // The bridge's per-event scope, which holds the telemetry flush
    // finalizers. `toHandled` opens a request scope of its own, unrelated to
    // it; the handler runs on the event scope instead, so the event has one
    // scope and the bridge owns it. Effect's request scope stays empty.
    const eventScope = Option.getOrUndefined(Context.getOption(context, Scope.Scope)) as
      | Scope.Closeable
      | undefined;
    // `getOrUndefined` skips the Worker reference's deferred default, so only
    // the bridge-provided context counts.
    const eventContext =
      Context.getOrUndefined(context, WorkerExecutionContext) ??
      Context.getOrUndefined(context, DurableObjectState);
    const runtimeContext = Context.getOrUndefined(context, RuntimeContext);
    const background =
      eventContext === undefined || runtimeContext === undefined
        ? undefined
        : (effect: Effect.Effect<void>) =>
            eventContext
              .waitUntil(effect)
              .pipe(Effect.provideService(RuntimeContext, runtimeContext));

    yield* EffectHttp.toHandled(
      eventScope === undefined ? handler : Effect.provideService(handler, Scope.Scope, eventScope),
      (request, response) => {
        const withoutBody = request.method === "HEAD";
        if (!HttpServerResponse.omitsBody(response, withoutBody)) {
          response =
            eventScope === undefined
              ? EffectHttp.scopeTransferToStream(response)
              : transferEventScopeToStream(response, eventScope, background);
        }
        return Deferred.succeed(
          webResponse,
          HttpServerResponse.toWeb(response, { withoutBody, context }),
        );
      },
    );
    return yield* Deferred.await(webResponse);
  });

/**
 * A streamed body outlives the handler's return, so it takes the event scope:
 * the bridge skips its close-on-return for an ejected scope, and the body
 * closes it once it settles. The close runs in the event's `waitUntil`, so
 * the telemetry flush neither holds back the body's EOF nor is cut off.
 */
const transferEventScopeToStream = (
  response: HttpServerResponse.HttpServerResponse,
  scope: Scope.Closeable,
  background: ((effect: Effect.Effect<void>) => Effect.Effect<void>) | undefined,
): HttpServerResponse.HttpServerResponse => {
  if (response.body._tag !== "Stream") return response;
  EffectHttp.scopeDisableClose(scope);
  return HttpServerResponse.setBody(
    response,
    HttpBody.stream(
      Stream.onExit(response.body.stream, (exit) => closeEventScope(scope, exit, background)),
      response.body.contentType,
      response.body.contentLength,
    ),
  );
};

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
