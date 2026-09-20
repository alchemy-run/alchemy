import * as NodeServices from "@effect/platform-node/NodeServices";
import { waitUntil as nativeWaitUntil } from "@neon/functions";
import * as Config from "effect/Config";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Duration from "effect/Duration";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import * as EffectHttp from "effect/unstable/http/HttpEffect";
import * as HttpServerRequest from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import { safeHttpEffect } from "../Http.ts";
import { makeEntrypointLayer, reifyBoundConfigProvider } from "../Runtime.ts";
import { RuntimeContext } from "../RuntimeContext.ts";
import { Self } from "../Self.ts";
import { StackContext } from "../StackContext.ts";
import { FunctionEnvironment, FunctionRequest } from "./FunctionEnvironment.ts";
import type { FunctionRuntimeContext } from "./FunctionRuntimeContext.ts";
import { FunctionUpgradeSockets } from "./FunctionUpgrade.ts";

const closeRequestScope = (scope: Scope.Scope) => {
  nativeWaitUntil(
    Effect.runPromise(
      Scope.close(scope, Exit.void).pipe(
        Effect.timeout("15 seconds"),
        Effect.ignoreCause({ log: "Error" }),
      ),
    ),
  );
};

/**
 * Neon's host neither aborts `request.signal` nor cancels the response body
 * when the client disconnects mid-stream — it silently stops pulling, leaving
 * the handler suspended on backpressure forever (measured: zero pulls, no
 * cancel, no abort for 3+ minutes after a killed client). Detect that state
 * from inside: when the host has no read in flight and has not pulled for the
 * idle window, treat the client as gone — cancel the source (running stream
 * finalizers) and release the request scope. A pending read never counts as
 * idle, so slow-but-alive consumers are unaffected.
 */
const streamIdleTimeout = Config.Duration(
  "ALCHEMY_NEON_STREAM_IDLE_TIMEOUT",
).pipe(Config.withDefault(Duration.seconds(30)));

const withStreamIdleWatchdog = (
  web: Response,
  idleMs: number,
  onDisconnect: () => void,
): Response => {
  const body = web.body;
  if (!body || idleMs <= 0) return web;
  const reader = body.getReader();
  let lastSettled = Date.now();
  let pending = false;
  const timer = setInterval(
    () => {
      if (pending || Date.now() - lastSettled < idleMs) return;
      clearInterval(timer);
      void reader
        .cancel(new Error("client stopped consuming the response stream"))
        .catch(() => {});
      onDisconnect();
    },
    Math.max(1000, Math.min(idleMs, 5000)),
  );
  (timer as { unref?: () => void }).unref?.();
  return new Response(
    new ReadableStream<Uint8Array>({
      async pull(controller) {
        pending = true;
        try {
          const { done, value } = await reader.read();
          if (done) {
            clearInterval(timer);
            controller.close();
          } else {
            controller.enqueue(value);
          }
        } catch (error) {
          clearInterval(timer);
          controller.error(error);
        } finally {
          pending = false;
          lastSettled = Date.now();
        }
      },
      cancel(reason) {
        clearInterval(timer);
        return reader.cancel(reason);
      },
    }),
    { status: web.status, statusText: web.statusText, headers: web.headers },
  );
};

/** Build a Node-only Fetch bridge once per process, with a fresh scope for every request. */
export const makeFunctionBridge = (entrypoint: unknown) => {
  const instanceScope = Scope.makeUnsafe();
  const tag = Self as unknown as Context.Service<
    never,
    { RuntimeContext: FunctionRuntimeContext }
  >;
  const platform = Layer.mergeAll(
    NodeServices.layer,
    FetchHttpClient.layer,
    Layer.succeed(FunctionEnvironment, process.env),
    Layer.succeed(
      ConfigProvider.ConfigProvider,
      reifyBoundConfigProvider(
        ConfigProvider.orElse(
          ConfigProvider.fromUnknown({ ALCHEMY_PHASE: "runtime" }),
          ConfigProvider.fromEnv(),
        ),
        process.env,
      ),
    ),
    Layer.succeed(StackContext, {
      name: process.env.ALCHEMY_STACK_NAME ?? "NeonFunction",
      stage: process.env.ALCHEMY_STAGE ?? "runtime",
      bindings: {},
      resources: {},
      actions: {},
    }),
  );
  const build = Layer.buildWithScope(
    makeEntrypointLayer(tag, entrypoint).pipe(Layer.provideMerge(platform)),
    instanceScope,
  ).pipe(
    Effect.flatMap((context) =>
      tag.pipe(
        Effect.flatMap((host) =>
          host.RuntimeContext.handler.pipe(
            Effect.map((handler) => ({
              ...handler,
              runtime: host.RuntimeContext,
              built: context,
            })),
          ),
        ),
        Effect.provideContext(context),
      ),
    ),
    Effect.cachedWithTTL((exit) => (Exit.isSuccess(exit) ? Infinity : 0)),
    Effect.runSync,
  );
  const close = Scope.close(instanceScope, Exit.void).pipe(
    Effect.timeout("4 seconds"),
    Effect.ignoreCause({ log: "Error" }),
  );
  process.once("SIGINT", () => {
    Effect.runFork(close);
  });

  return {
    fetch: (request: Request) =>
      Effect.gen(function* () {
        const built = yield* build;
        const response = yield* Deferred.make<Response>();
        const services = Context.mergeAll(
          built.built,
          built.context,
          Context.make(RuntimeContext, built.runtime),
          Context.make(FunctionRequest, request),
          Context.make(
            HttpServerRequest.HttpServerRequest,
            HttpServerRequest.fromWeb(request),
          ),
        );
        const handler = Effect.gen(function* () {
          // toHandled owns the request scope; an outer scope cannot close its resources.
          const scope = yield* Effect.scope;
          const onAbort = () => {
            closeRequestScope(scope);
          };
          yield* Effect.addFinalizer(() =>
            Effect.sync(() =>
              request.signal.removeEventListener("abort", onAbort),
            ),
          );
          yield* Effect.sync(() => {
            request.signal.addEventListener("abort", onAbort, { once: true });
            if (request.signal.aborted) onAbort();
          });
          return yield* safeHttpEffect(
            built.dispatch(new URL(request.url).pathname),
          );
        }).pipe(Effect.interruptible);
        return yield* EffectHttp.toHandled(handler, (req, res) =>
          Effect.gen(function* () {
            const scope = yield* Effect.scope;
            const context = yield* Effect.context<never>();
            if (res.body._tag === "Raw" && res.body.body instanceof Response) {
              // Neon attaches upgrade metadata to this exact object.
              const socket = FunctionUpgradeSockets.get(res.body.body);
              if (socket && socket.readyState !== socket.CLOSED) {
                EffectHttp.scopeDisableClose(scope);
                socket.addEventListener(
                  "close",
                  () => {
                    closeRequestScope(scope);
                  },
                  { once: true },
                );
              }
              yield* Deferred.succeed(response, res.body.body);
              return;
            }
            const withoutBody = req.method === "HEAD";
            const transferred = HttpServerResponse.omitsBody(res, withoutBody)
              ? res
              : EffectHttp.scopeTransferToStream(res);
            const web = HttpServerResponse.toWeb(transferred, {
              withoutBody,
              context,
            });
            yield* Deferred.succeed(
              response,
              res.body._tag === "Stream" && !withoutBody
                ? withStreamIdleWatchdog(
                    web,
                    Duration.toMillis(yield* streamIdleTimeout),
                    () => closeRequestScope(scope),
                  )
                : web,
            );
          }),
        ).pipe(
          Effect.andThen(Deferred.await(response)),
          Effect.provideContext(services),
        );
      }).pipe((effect) =>
        Effect.runPromise(effect, { signal: request.signal }),
      ),
  };
};
