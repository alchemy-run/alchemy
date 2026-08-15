/**
 * The Vercel Function runtime bridge (Effect mode, DESIGN §6.4).
 *
 * The generated bundle entry wraps the user's `main` module:
 *
 * ```ts
 * import entrypoint from "<user main>";
 * import { makeVercelBridge } from "alchemy/Vercel";
 * export default makeVercelBridge(entrypoint, { stack: { name, stage } });
 * ```
 *
 * and emits a web-standard `{ fetch }` export that Vercel's Node launcher
 * accepts natively (streaming-capable — `supportsResponseStreaming` is set
 * by the provider).
 *
 * Contract:
 * - The layer stack is built ONCE per instance (Fluid keeps instances warm),
 *   lazily on the first request, with success-only memoization so a
 *   transient init failure heals on the next request.
 * - The bridge is RE-ENTRANT: Fluid runs concurrent requests against one
 *   instance — every request runs in its own Effect fiber with a fresh
 *   `Scope` and its own `HttpServerRequest`; there is zero per-instance
 *   mutable request state.
 * - Request finalizers settle post-response: the request scope is closed
 *   into Vercel's `waitUntil` (the `@vercel/request-context` contract that
 *   `@vercel/functions` wraps — honored exactly, live-verified), so
 *   `Effect.addFinalizer` in a handler never delays the response.
 * - Shutdown: Fluid delivers SIGTERM with a ~500ms grace window — a plain
 *   signal handler closes the instance scope so init-level finalizers run.
 * - Cron routes (`/_alchemy/cron/*`, registered by the `cron` event source)
 *   are dispatched BEFORE the user's `fetch`, guarded by a constant-time
 *   comparison of `Authorization: Bearer $CRON_SECRET` — the secret the
 *   provider auto-mints as a sensitive project env var, and the same value
 *   Vercel's cron invoker sends when `CRON_SECRET` is set.
 */
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Cause from "effect/Cause";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Option from "effect/Option";
import { MinimumLogLevel } from "effect/References";
import * as Scope from "effect/Scope";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import * as EffectHttp from "effect/unstable/http/HttpEffect";
import * as HttpServerRequest from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import { createHash, timingSafeEqual } from "node:crypto";
import * as Http from "../../Http.ts";
import { isScopeEjected } from "../../Http.ts";
import * as Output from "../../Output.ts";
import {
  makeEntrypointLayer,
  reifyBoundConfigProvider,
} from "../../Runtime.ts";
import {
  packEnvValueKeepRedacted,
  unpackEnvValue,
} from "../../RuntimeContext.ts";
import { Self } from "../../Self.ts";
import type * as Serverless from "../../Serverless/index.ts";
import { Stack } from "../../Stack.ts";
import { buildEventTelemetry } from "../../Telemetry.ts";
import {
  runQueueCallback,
  type QueueSubscriptionEntry,
} from "../Queues/QueueCallback.ts";
import type { Function } from "./Function.ts";

/**
 * The env var Vercel's cron invoker reads: when a project defines
 * `CRON_SECRET`, every platform cron request carries
 * `Authorization: Bearer $CRON_SECRET`. The Function provider auto-mints it
 * (sensitive, production+preview targets) whenever crons are registered.
 */
export const CRON_SECRET_ENV = "CRON_SECRET";

/**
 * The runtime environment of a deployed Vercel Function — `process.env`
 * (≙ Cloudflare's `WorkerEnvironment`). Resolved once at instance init and
 * closed over by runtime clients.
 */
export class FunctionEnvironment extends Context.Service<
  FunctionEnvironment,
  Record<string, string | undefined>
>()("Vercel.Functions.FunctionEnvironment") {}

/** The single event shape the Vercel bridge dispatches. */
export interface VercelFunctionEvent {
  readonly kind: "Vercel.Functions.FunctionEvent";
  readonly type: "fetch";
  readonly request: Request;
}

export const isVercelFunctionEvent = (
  event: unknown,
): event is VercelFunctionEvent =>
  typeof event === "object" &&
  event !== null &&
  (event as { kind?: unknown }).kind === "Vercel.Functions.FunctionEvent";

/**
 * A per-request dispatch produced by the context's `exports`: routes cron
 * paths first, then the user's `fetch`, returning the handler Effect plus
 * the init-captured services it must run against.
 */
export type VercelFetchDispatch = (
  request: Request,
) => readonly [
  Effect.Effect<Response, unknown, unknown>,
  Context.Context<never>,
];

export interface VercelFunctionContext extends Serverless.FunctionContext {
  /**
   * Register a cron handler under its stable route path. Called by the
   * `cron` event source at init in BOTH phases (plan and runtime) — the
   * bridge's dispatcher consults the registry before user `fetch`.
   */
  registerCron(
    path: string,
    handler: Effect.Effect<void, unknown, any>,
  ): Effect.Effect<void>;
  /**
   * Register a queue push subscription for a topic. Called by the
   * `subscribe` event source at init in BOTH phases (plan and runtime); the
   * queue-mode bridge (the separate consumer function, D9a) dispatches
   * incoming deliveries against this registry.
   */
  registerQueueSubscription(entry: QueueSubscriptionEntry): Effect.Effect<void>;
}

/**
 * Constant-time string comparison (per-char timing leaks closed by
 * comparing fixed-length sha256 digests; the trailing `===` guards the
 * astronomically-unlikely digest collision).
 */
const timingSafeStringEqual = (a: string, b: string): boolean => {
  const digestA = createHash("sha256").update(a).digest();
  const digestB = createHash("sha256").update(b).digest();
  return timingSafeEqual(digestA, digestB) && a === b;
};

/**
 * Hand a promise to Vercel's request context so it settles after the
 * response without being cut off — the same contract `@vercel/functions`'s
 * `waitUntil` wraps (probe-verified: honored with exact timing). When no
 * request context is present (local harnesses), the promise floats — Fluid
 * keeps the instance's event loop running.
 */
const vercelWaitUntil = (promise: Promise<unknown>): void => {
  const requestContext = (
    globalThis as Record<symbol, unknown> & typeof globalThis
  )[Symbol.for("@vercel/request-context")] as
    | { get?: () => { waitUntil?: (promise: Promise<unknown>) => void } }
    | undefined;
  const ctx = requestContext?.get?.();
  if (ctx?.waitUntil !== undefined) {
    ctx.waitUntil(promise);
  }
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
          // (shadowing the bridge's request scope) and closes it INLINE
          // right after this callback — a handler's `Effect.addFinalizer`
          // would delay the response. Eject it and settle it with the
          // bridge's request scope instead, which closes post-response via
          // waitUntil. Streaming bodies keep effect's native transfer:
          // `scopeTransferToStream` ejects the scope itself and closes it
          // when the body stream ends.
          if (response.body._tag !== "Stream") {
            EffectHttp.scopeDisableClose(handlerScope);
            yield* Scope.addFinalizerExit(requestScope, (exit) =>
              Scope.close(handlerScope, exit),
            );
          }
          yield* Deferred.succeed(
            webResponse,
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

/**
 * Wrap the user's `fetch` handler into a request Effect: builds an
 * `HttpServerRequest` from the incoming web `Request` and converts the
 * handler's `HttpServerResponse` back to a web `Response` (streaming bodies
 * transfer the request scope to the stream).
 */
export const makeVercelRequestEffect = <Req = never>(
  webRequest: Request,
  handler: Http.HttpEffect<Req> | Effect.Effect<Http.HttpEffect<Req>>,
) => {
  const safeHandler = Http.safeHttpEffect(handler);
  return Effect.gen(function* () {
    // The bridge-provided per-request scope — handed to toHandledWebResponse
    // so the handler's finalizers settle post-response with it.
    const requestScope = yield* Effect.scope;
    const request = HttpServerRequest.fromWeb(webRequest).modify({
      remoteAddress: Option.fromUndefinedOr(
        webRequest.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ??
          webRequest.headers.get("x-real-ip") ??
          undefined,
      ),
    });
    return yield* toHandledWebResponse(safeHandler, requestScope).pipe(
      Effect.provide([
        Layer.succeed(HttpServerRequest.HttpServerRequest, request),
      ]),
    );
    // Residual requirements (RuntimeContext, init services, the per-request
    // Scope) are provided by the bridge's dispatch — erased here so the
    // listener signature (`FunctionListener`) accepts the handler.
  }) as any as Effect.Effect<Response>;
};

const makeVercelRequestHandler =
  <Req = never>(
    handler: Http.HttpEffect<Req> | Effect.Effect<Http.HttpEffect<Req>>,
  ) =>
  (event: unknown) =>
    isVercelFunctionEvent(event) && event.type === "fetch"
      ? makeVercelRequestEffect(event.request, handler)
      : undefined;

/**
 * Verify + run a registered cron handler for an incoming platform cron
 * request. Runs BEFORE user `fetch`; a missing/wrong bearer is a 401
 * (constant-time comparison), a failing handler is a 500 so Vercel records
 * the invocation as failed.
 */
const runCronRequest = (
  request: Request,
  handler: Effect.Effect<void, unknown, any>,
): Effect.Effect<Response, unknown, unknown> =>
  Effect.gen(function* () {
    const authorized = yield* Effect.sync(() => {
      const secret = process.env[CRON_SECRET_ENV];
      if (secret === undefined || secret.length === 0) {
        return false;
      }
      const header = request.headers.get("authorization");
      return (
        header !== null && timingSafeStringEqual(header, `Bearer ${secret}`)
      );
    });
    if (!authorized) {
      return Response.json({ error: "Unauthorized" }, { status: 401 });
    }
    const succeeded = yield* (
      handler as Effect.Effect<void, unknown, never>
    ).pipe(
      Effect.as(true),
      Effect.catchCause((cause) =>
        Effect.logError("Vercel cron handler failed", cause).pipe(
          Effect.as(false),
        ),
      ),
    );
    return succeeded
      ? Response.json({ ok: true })
      : Response.json({ error: "cron handler failed" }, { status: 500 });
  });

const pathnameOf = (url: string): string => {
  try {
    return new globalThis.URL(url, "http://localhost").pathname;
  } catch {
    return url;
  }
};

/**
 * Build the Vercel Function's runtime context — the `createRuntimeContext`
 * hook of the `Vercel.Function` Platform. The SAME code runs at plan time
 * (registering bindings, collecting the export shape) and inside the
 * deployed bundle (where `exports` hands the bridge its dispatcher).
 */
export const makeVercelFunctionContext = (
  id: string,
): VercelFunctionContext => {
  const env: Record<string, any> = {};
  const listeners: Effect.Effect<Serverless.FunctionListener>[] = [];
  const cronHandlers = new Map<string, Effect.Effect<void, unknown, any>>();
  const queueSubscriptions = new Map<string, QueueSubscriptionEntry>();

  const ctx: VercelFunctionContext = {
    Type: "Vercel.Function",
    id,
    env,
    set: (key: string, output: Output.Output) =>
      Effect.sync(() => {
        // Marker-pack Redacted values so they survive the Output → env var
        // round-trip; the runtime `get` below unpacks them. The Redacted
        // wrapper is kept on the OUTSIDE of the packed string so the env
        // sync routes secrets (e.g. EdgeConfigToken connection strings)
        // as `sensitive` project env vars instead of plain ones (mirrors
        // the Cloudflare Container platform).
        env[key] = output.pipe(Output.map(packEnvValueKeepRedacted));
        return key;
      }),
    get: <T>(key: string) =>
      // Key is already canonical (see RuntimeContext.sanitizeKey). Read
      // straight from `process.env` — see `unpackEnvValue` for why this
      // must never resolve through `Config.string`.
      Effect.sync(() => unpackEnvValue<T>(process.env[key])),
    serve: <Req = never>(
      handler: Http.HttpEffect<Req> | Effect.Effect<Http.HttpEffect<Req>>,
    ) =>
      ctx.listen(makeVercelRequestHandler(handler)) as Effect.Effect<
        void,
        never,
        Req
      >,
    listen: ((
      handler:
        | Serverless.FunctionListener
        | Effect.Effect<Serverless.FunctionListener>,
    ) =>
      Effect.sync(() =>
        Effect.isEffect(handler)
          ? listeners.push(handler)
          : listeners.push(Effect.succeed(handler)),
      )) as any as Serverless.FunctionContext["listen"],
    registerCron: (path, handler) =>
      Effect.sync(() => {
        cronHandlers.set(path, handler);
      }),
    registerQueueSubscription: (entry) =>
      Effect.suspend(() => {
        if (queueSubscriptions.has(entry.topic.topicName)) {
          return Effect.die(
            new Error(
              `Vercel.subscribe: duplicate subscription for topic '${entry.topic.topicName}' — a Function may subscribe to a topic at most once`,
            ),
          );
        }
        queueSubscriptions.set(entry.topic.topicName, entry);
        return Effect.void;
      }),
    // Lets init code `yield* FunctionEnvironment` during plan; the real env
    // is provided by the bridge at runtime.
    planServices: Layer.succeed(FunctionEnvironment, {}),
    exports: Effect.gen(function* () {
      const handlers = yield* Effect.all(listeners, {
        concurrency: "unbounded",
      });
      // Instance-lifetime services captured at init. The build's memo map is
      // stripped so a Layer the user `Effect.provide`s inside a handler
      // builds per request instead of sharing one instance across
      // concurrent events (mirrors WorkerBridge / Lambda).
      const services = Context.omit(Layer.CurrentMemoMap)(
        yield* Effect.context<never>(),
      );

      const dispatch: VercelFetchDispatch = (request) => {
        // Cron routes are dispatched BEFORE user fetch.
        const cronHandler = cronHandlers.get(pathnameOf(request.url));
        if (cronHandler !== undefined) {
          return [runCronRequest(request, cronHandler), services] as const;
        }
        const event: VercelFunctionEvent = {
          kind: "Vercel.Functions.FunctionEvent",
          type: "fetch",
          request,
        };
        for (const handler of handlers) {
          const eff = handler(event);
          if (Effect.isEffect(eff)) {
            return [
              eff as Effect.Effect<Response, unknown, unknown>,
              services,
            ] as const;
          }
        }
        return [
          Effect.die(
            new Error(
              "No fetch handler registered — return a `fetch` handler from the Function's init Effect",
            ),
          ),
          services,
        ] as const;
      };

      // The queue-mode dispatch (used ONLY by the separate consumer
      // function's bridge, D9a): every incoming request is a platform queue
      // delivery, processed against the init-registered subscriptions.
      const queue: VercelFetchDispatch = (request) => [
        runQueueCallback(queueSubscriptions, request) as Effect.Effect<
          Response,
          unknown,
          unknown
        >,
        services,
      ];

      return { fetch: dispatch, queue };
    }),
  };
  return ctx;
};

interface FunctionBuild {
  readonly context: Context.Context<any>;
  readonly dispatch: VercelFetchDispatch;
  readonly telemetry: () => Layer.Layer<never, any, any> | undefined;
}

/**
 * Bridge the user's Effect-native entrypoint to Vercel's web-standard
 * `{ fetch }` export. See the module doc for the full contract.
 */
export const makeVercelBridge = (
  entrypoint: any,
  meta: {
    stack: { name: string; stage: string };
    /**
     * Which dispatch this bundle mounts: `"fetch"` (default) serves public
     * HTTP; `"queue"` is the dedicated consumer function (D9a) — every
     * request is a platform queue delivery dispatched to the registered
     * `subscribe` handlers.
     */
    mode?: "fetch" | "queue";
  },
): { fetch: (request: Request) => Promise<Response> } => {
  const tag = Self as any as Context.Service<
    never,
    Function & { RuntimeContext: VercelFunctionContext }
  >;

  const layer = makeEntrypointLayer(tag, entrypoint);

  const platform = Layer.mergeAll(
    NodeServices.layer,
    FetchHttpClient.layer,
    Logger.layer([Logger.consolePretty()]),
  );

  const entryLayer = layer.pipe(
    Layer.provideMerge(
      Layer.succeed(Stack, {
        name: meta.stack.name,
        stage: meta.stack.stage,
        bindings: {},
        resources: {},
        actions: {},
      }),
    ),
    Layer.provideMerge(platform),
    Layer.provideMerge(
      Layer.succeed(
        ConfigProvider.ConfigProvider,
        ConfigProvider.orElse(
          ConfigProvider.fromUnknown({ ALCHEMY_PHASE: "runtime" }),
          // Auto-bound `Config` values arrive in env as
          // `{"_tag":"Redacted","value":...}` markers; reify them so a
          // `Config` re-read inside a request handler decodes the raw
          // source value instead of the marker JSON.
          reifyBoundConfigProvider(
            ConfigProvider.fromEnv(),
            process.env as Record<string, unknown>,
          ),
        ),
      ),
    ),
    Layer.provideMerge(
      Layer.sync(
        FunctionEnvironment,
        () => process.env as Record<string, string | undefined>,
      ),
    ),
    Layer.provideMerge(
      Layer.succeed(MinimumLogLevel, process.env.DEBUG ? "Debug" : "Info"),
    ),
  );

  // Instance scope: the instance-lifetime layer build lives under it; the
  // SIGTERM handler below closes it inside Fluid's ~500ms grace window so
  // init-level finalizers run before the instance dies.
  const instanceScope = Scope.makeUnsafe();

  let built: Promise<FunctionBuild> | undefined;

  /**
   * Build the instance-lifetime layer stack exactly once (lazily, on the
   * first request); every request reuses the memoized build. Only success
   * is memoized — a transient init failure resets the memo and heals on
   * the next request.
   */
  const build = (): Promise<FunctionBuild> =>
    (built ??= Effect.runPromise(
      Layer.buildWithScope(entryLayer, instanceScope).pipe(
        Effect.flatMap((context) =>
          Effect.gen(function* () {
            const func = yield* tag;
            const runtimeContext = func.RuntimeContext;
            const exports = yield* runtimeContext.exports;
            return {
              context: Context.omit(Layer.CurrentMemoMap)(context),
              dispatch: (meta.mode === "queue"
                ? exports.queue
                : exports.fetch) as VercelFetchDispatch,
              telemetry: () => runtimeContext.telemetry,
            } satisfies FunctionBuild;
          }).pipe(Effect.provideContext(context)),
        ),
        Scope.provide(instanceScope),
      ),
    ).catch((error) => {
      built = undefined;
      throw error;
    }));

  // Fluid's Shutdown: SIGTERM + ~500ms — close the instance scope so
  // init-level finalizers run, then exit inside the budget. SIGKILL follows
  // if we overstay, so finalizers must be fast and best-effort.
  process.once("SIGTERM", () => {
    Effect.runPromise(Scope.close(instanceScope, Exit.void))
      .catch((error) =>
        console.error("[alchemy] shutdown finalizers failed", error),
      )
      .finally(() => process.exit(0));
  });

  const fetch = async (request: Request): Promise<Response> => {
    const build_ = await build();
    // Fresh request scope per event — `Effect.addFinalizer` in a handler
    // attaches here and settles post-response via waitUntil below. Each
    // request runs in its own fiber: the bridge is re-entrant under Fluid
    // concurrency.
    const scope = Scope.makeUnsafe();
    const [eff, services] = build_.dispatch(request);
    const exit = await (eff as Effect.Effect<Response, unknown, any>).pipe(
      Effect.provide(
        Layer.mergeAll(
          Layer.succeed(Scope.Scope, scope),
          // The configured telemetry exporters, attached to the request
          // scope by `buildEventTelemetry` so buffered spans/logs flush
          // when the scope settles below.
          Layer.effectContext(
            buildEventTelemetry(build_.context, scope, build_.telemetry()),
          ),
        ).pipe(
          Layer.provideMerge(Layer.succeedContext(services)),
          Layer.provideMerge(Layer.succeedContext(build_.context)),
        ),
      ),
      Effect.runPromiseExit,
    );
    if (!isScopeEjected(scope)) {
      // Close the request scope post-response: the HttpMiddleware tracer
      // ends the request's root span in a dispatcher task scheduled after
      // the handler resolves — yield one macrotask so it reaches the
      // exporter's buffer before the flush finalizer, then settle the scope
      // under Vercel's waitUntil so it never delays the response. An
      // ejected scope (streaming body) is closed by its new owner instead.
      vercelWaitUntil(
        new Promise((resolve) => setTimeout(resolve, 0)).then(() =>
          Effect.runPromise(
            Scope.close(scope, exit as Exit.Exit<unknown, unknown>),
          ).catch((error) =>
            console.error("[alchemy] request finalizers failed", error),
          ),
        ),
      );
    }
    if (Exit.isSuccess(exit)) {
      return exit.value;
    }
    throw Cause.squash(exit.cause);
  };

  return { fetch };
};
