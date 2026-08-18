/**
 * The shared `alchemy/Serve` runtime bridge CORE (DESIGN §3.3, §6.4) —
 * cloud-neutral by construction. Everything delicate about bridging lives
 * here, exactly once:
 *
 *   - one lazy, WeakMap-memoized instance-lifetime layer build per Website
 *     class per process, with failure healing (only success is memoized —
 *     a transient init failure resets the memo and heals on the next
 *     event) and in-flight-build pinning (workerd drops a promise's
 *     continuations if its origin request context has ended)
 *   - the instance-scope lifecycle: never closed on workerd (no teardown
 *     hook), drained by ONE process-level SIGTERM listener elsewhere
 *     (Lambda's Shutdown window, dev-server exits), and closeable per
 *     class via {@link BridgeCore.dispose} (dev-server hot swap)
 *   - the per-event request `Scope` and its settle strategy: registered
 *     with `waitUntil` when the event has one (workerd — the request's
 *     IoContext dies at response-return), settled inline before the
 *     response tail otherwise (Lambda semantics — request finalizers block
 *     the stream end), unless a streaming response ejected the scope to a
 *     new owner
 *   - route/world authority: the env-marker guard declines build-time
 *     prerender worlds without touching I/O, and within its routes the
 *     effect fetch is AUTHORITATIVE — every outcome, including a
 *     `RouteNotFound` failure rendered as the effect's own 404, is final;
 *     delegation to the framework is purely the mount's routing decision
 *     made by the caller BEFORE the effect fetch is invoked
 *
 * What varies per cloud is a {@link BridgeRecipe}: the service layers
 * (leaf tags only — this module must stay importable by every foreign
 * bundler on every cloud), the platform selection, the request-pipeline
 * adapter, per-event layers, and an optional init hook. The recipes live
 * with their clouds — `Cloudflare/Workers/ServeBridge.ts` and
 * `AWS/Lambda/ServeBridge.ts` — and are stamped on Website classes under
 * `SERVE_BRIDGE_KEY`, so each rides its site module's own import graph and
 * this core never imports either cloud.
 */

import * as Cause from "effect/Cause";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import { MinimumLogLevel } from "effect/References";
import * as Scope from "effect/Scope";
import { isScopeEjected } from "../Http.ts";
import { makeEntrypointLayer, reifyBoundConfigProvider } from "../Runtime.ts";
import type { BaseRuntimeContext } from "../RuntimeContext.ts";
import { Self } from "../Self.ts";
import { Stack } from "../Stack.ts";
import { buildEventTelemetry } from "../Telemetry.ts";
import type { SERVE_SENTINEL } from "./constants.ts";
import { envString, hasStackMarkers } from "./Env.ts";

// The wiring-handshake sentinel, written as a literal (type-checked against
// `constants.ts`) so the exact byte sequence provably survives bundling and
// minification into any foreign server bundle that imports a bridge — the
// deploy-time sentinel scan greps the built bundle for it. The global marker
// itself is inert (unlike `__ALCHEMY_RUNTIME__`, which is only stamped at
// bridge-construction time — see `markRuntime`).
const SENTINEL: typeof SERVE_SENTINEL = "__ALCHEMY_SERVE_v1__";
(globalThis as Record<string, any>)[SENTINEL] = true;

/**
 * Stamp the runtime flag. Called synchronously when a bridge is constructed
 * (`Serve.toHandler`, `makeWebsiteExports`, the framework adapters) — always
 * before any init Effect can run, so every
 * `if (!globalThis.__ALCHEMY_RUNTIME__)` bind guard is a no-op at runtime
 * even when the framework's bundler defined nothing.
 *
 * Deliberately NOT a module-evaluation side effect: `alchemy/Serve` is
 * imported by the user's `src/backend.ts`, which the engine also imports at
 * plan time — a module-eval flag would poison the plan world (DESIGN §5.3
 * world 1 requires the flag unset there).
 */
export const markRuntime = (): void => {
  globalThis.__ALCHEMY_RUNTIME__ = true;
};

export interface ServeOptions {
  /**
   * Explicit env when the framework hands it over (kit
   * `event.platform.env`, nitro `event.context.cloudflare.env`). Default
   * resolution is the recipe's env ladder.
   */
  env?: unknown;
  /**
   * Extend the event past the response (workerd `ctx.waitUntil`). Default:
   * the request scope is settled inline before the response returns.
   */
  waitUntil?: (promise: Promise<unknown>) => void;
}

/**
 * The instance-lifetime artifacts of one site build: the built service
 * Context, a thunk for the user's impl shape (populated once `serve` has
 * run during init), and the telemetry Layer override registered during
 * init.
 */
export interface SiteRuntime {
  readonly context: Context.Context<any>;
  readonly shape: () => Record<string, any> | undefined;
  readonly telemetry: () => Layer.Layer<never, any, any> | undefined;
}

export interface SiteFetchOptions {
  waitUntil?: (promise: Promise<unknown>) => void;
  /** The live per-event workerd ExecutionContext, when the caller has one. */
  executionContext?: unknown;
}

/**
 * A cloud-specific serve bridge a Website class carries under
 * `SERVE_BRIDGE_KEY`: the runtime half `mount` dispatches matched
 * requests to. Lives HERE (not `Serve.ts`) so graphs that only need
 * dispatch — the value-form `createClient` (`Client/Server.ts`) — stay
 * on the leanest slice of the Serve graph.
 */
export interface ServeBridge {
  match(
    site: object,
    request: Request,
    options?: ServeOptions,
  ): Promise<Response | undefined>;
  /** Tear down the bridge's per-class runtime for `site`. */
  dispose(site: object): Promise<void>;
  /**
   * Build (memoized per class) the site's instance runtime against a
   * resolved env — the `BridgeCore.getRuntime` seam for `alchemy/Client`.
   */
  runtime(site: object, env: Record<string, unknown>): Promise<SiteRuntime>;
}

export const bridgeOf = (site: object): ServeBridge | undefined =>
  (site as Record<string, unknown>)["~alchemy/Serve/bridge"] as
    | ServeBridge
    | undefined;

/**
 * The cloud-specific half of a serve bridge. Kept deliberately thin — a
 * recipe supplies layers and adapters, never lifecycle logic. Every recipe
 * module must obey the leaf-import discipline: only leaf tag modules and
 * request-pipeline adapters, no engine modules, no `node:*` at module
 * scope — recipes are compiled by foreign bundlers into workerd and Lambda
 * server bundles alike.
 */
export interface BridgeRecipe {
  /**
   * Resolve the env for this world: the explicit override from the mount,
   * else the cloud's ladder (workerd importable env / framework globals /
   * `process.env`). Returning an env WITHOUT stack markers declines the
   * world (the core checks — build-time prerender/SSG).
   */
  resolveEnv(
    explicit?: unknown,
  ):
    | Promise<Record<string, unknown> | undefined>
    | Record<string, unknown>
    | undefined;
  /**
   * The cloud's service layers over the shared entry recipe: leaf tags
   * only (e.g. `WorkerEnvironment` + deferred `ExecutionContext` +
   * `CloudflareEnvironment`, or `Credentials.fromChain()` +
   * `Region.fromEnv()`).
   */
  layers(env: Record<string, unknown>): Layer.Layer<any, any, any>;
  /**
   * World-selected platform layer. Async so a Node-world recipe can
   * dynamic-import `platform-node` — a static import is fatal in
   * foreign-bundled workerd server bundles.
   */
  platform(): Layer.Layer<any, any, any> | Promise<Layer.Layer<any, any, any>>;
  /**
   * Adapt one request + fetch handler into the cloud's production request
   * pipeline effect (stream-preserving).
   */
  requestEffect(
    request: Request,
    handler: Effect.Effect<any, any, any>,
  ): Effect.Effect<any, any, any>;
  /**
   * Per-event layers that must shadow the instance build (e.g. the real —
   * or synthesized — workerd ExecutionContext). Default: none.
   */
  eventLayers?(options: SiteFetchOptions): Layer.Layer<any, any, any>;
  /**
   * Awaited before every build and dispatch (e.g. the Lambda internal
   * extension registration that buys the SIGTERM Shutdown window).
   */
  init?(): Promise<unknown>;
}

/**
 * Every live instance-lifetime scope in this process, drained by ONE
 * process-level SIGTERM listener (registered on the first build, never on
 * workerd). One listener — not one per build — so a dev server hot-swapping
 * site classes (a fresh class per edit, each with its own layer build)
 * never accumulates listeners toward `MaxListenersExceededWarning`.
 */
const instanceScopes = new Set<Scope.Closeable>();
let sigtermRegistered = false;

const registerInstanceScope = (scope: Scope.Closeable): void => {
  instanceScopes.add(scope);
  if (
    (globalThis as { navigator?: { userAgent?: string } }).navigator
      ?.userAgent === "Cloudflare-Workers"
  ) {
    // No isolate-teardown hook on workerd; the scope deliberately never
    // closes there.
    return;
  }
  const proc = (globalThis as { process?: any }).process;
  if (sigtermRegistered || typeof proc?.on !== "function") {
    return;
  }
  sigtermRegistered = true;
  proc.on("SIGTERM", () => {
    for (const live of instanceScopes) {
      void Effect.runPromise(Scope.close(live, Exit.void)).catch(() => {});
    }
    instanceScopes.clear();
  });
};

const noopPin = (): void => {};

/** The per-recipe bridge machinery — see the module doc. */
export interface BridgeCore {
  /**
   * The lazily-built, memoized instance runtime for a site class (the
   * value-form `createClient` seam reuses this so backend methods resolve
   * the same layer stack as the fetch path).
   */
  getRuntime(
    site: object,
    env: Record<string, unknown>,
    pin?: (promise: Promise<unknown>) => unknown,
  ): Promise<SiteRuntime>;
  /**
   * Run one fetch event against a built site. Resolves the web `Response`,
   * or `undefined` only when the site exposes no fetch handler.
   */
  runFetch(
    runtime: SiteRuntime,
    request: Request,
    options?: SiteFetchOptions,
  ): Promise<Response | undefined>;
  /**
   * The full match: resolve env, apply the world guard, lazily build, run
   * the fetch. Resolves `undefined` on decline (no env markers or no fetch
   * handler) so the caller falls through to the framework. Route gating
   * happens in the caller — a request that reaches `match` is inside the
   * effect's claim, and the effect's answer (404s included) is final.
   */
  match(
    site: object,
    request: Request,
    options?: ServeOptions,
  ): Promise<Response | undefined>;
  /**
   * Tear down the per-class runtime built for `site`: evict the memo and
   * close the instance-lifetime scope (init-level finalizers run).
   * Idempotent; a never-dispatched class resolves immediately.
   *
   * This is the invalidation half of effect-handler hot reload in dev
   * servers: a cache-busted re-import produces a fresh class identity
   * whose first matched request lazily builds a fresh stack — but the OLD
   * generation's build, scope, and SIGTERM registration would otherwise be
   * retained for the process lifetime (node's module registry pins every
   * re-imported namespace, so `WeakMap` entries keyed by old classes are
   * never reclaimed).
   */
  dispose(site: object): Promise<void>;
}

export const makeBridgeCore = (recipe: BridgeRecipe): BridgeCore => {
  /**
   * One instance-lifetime layer build per Website class, lazily created on
   * the first matched request and shared by every subsequent event. Only
   * success is memoized — a transient init failure resets the memo and
   * heals on the next event. The env captured by the first successful
   * build wins for the lifetime of the process (env objects are stable per
   * instance on every supported host).
   *
   * The constraint this WeakMap key implies: never import the site class
   * via inconsistent specifiers within one framework graph — two module
   * ids mean two keys and two layer stacks.
   */
  const siteBuilds = new WeakMap<
    object,
    (pin: (promise: Promise<unknown>) => unknown) => Promise<SiteRuntime>
  >();

  /**
   * The instance-lifetime scope of each site's build, for {@link dispose}.
   * Registered as soon as the build starts so a dispose during a failing
   * build still closes the scope.
   */
  const siteScopes = new WeakMap<object, Scope.Closeable>();

  const buildSiteRuntime = async (
    site: object,
    env: Record<string, unknown>,
  ): Promise<SiteRuntime> => {
    const tag = Self as any as Context.Service<
      never,
      { RuntimeContext: BaseRuntimeContext }
    >;

    const layer = makeEntrypointLayer(tag, site);
    const platform = await recipe.platform();

    const entryLayer = layer.pipe(
      Layer.provideMerge(
        Layer.succeed(Stack, {
          name: envString(env.ALCHEMY_STACK_NAME) ?? "",
          stage: envString(env.ALCHEMY_STAGE) ?? "",
          bindings: {},
          resources: {},
          actions: {},
        }),
      ),
      Layer.provideMerge(recipe.layers(env)),
      Layer.provideMerge(platform),
      Layer.provideMerge(
        Layer.succeed(
          ConfigProvider.ConfigProvider,
          ConfigProvider.orElse(
            ConfigProvider.fromUnknown({ ALCHEMY_PHASE: "runtime" }),
            // Auto-bound `Config` values arrive in `env` as
            // `{"_tag":"Redacted","value":...}` markers; reify them so a
            // `Config` re-read inside a request handler decodes the raw
            // source value instead of the marker JSON.
            reifyBoundConfigProvider(ConfigProvider.fromUnknown(env), env),
          ),
        ),
      ),
      Layer.provideMerge(
        Layer.succeed(MinimumLogLevel, env.DEBUG ? "Debug" : "Info"),
      ),
    );

    // Instance-lifetime scope for the layer build: never closed on workerd
    // (no teardown hook), best-effort SIGTERM close elsewhere, and
    // closeable per class via `dispose`.
    const instanceScope = Scope.makeUnsafe();
    registerInstanceScope(instanceScope);
    siteScopes.set(site, instanceScope);
    const memoMap = Layer.makeMemoMapUnsafe();

    return Effect.runPromise(
      (
        Layer.buildWithMemoMap(
          entryLayer,
          memoMap,
          instanceScope,
        ) as Effect.Effect<Context.Context<any>>
      ).pipe(
        // Strip the build's memo map from the exposed context so a Layer
        // the user `Effect.provide`s inside a handler builds per event
        // instead of sharing one instance across concurrent events.
        Effect.map(Context.omit(Layer.CurrentMemoMap)),
        Effect.flatMap((context) =>
          tag.pipe(
            Effect.map((instance): SiteRuntime => {
              const runtimeContext = instance.RuntimeContext;
              return {
                context,
                shape: () =>
                  runtimeContext.shape?.() as Record<string, any> | undefined,
                telemetry: () => runtimeContext.telemetry,
              };
            }),
            Effect.provideContext(context),
          ),
        ),
      ),
    );
  };

  const getRuntime = (
    site: object,
    env: Record<string, unknown>,
    pin: (promise: Promise<unknown>) => unknown = noopPin,
  ): Promise<SiteRuntime> => {
    let shared = siteBuilds.get(site);
    if (shared === undefined) {
      let built: Promise<SiteRuntime> | undefined;
      shared = (pin) => {
        const promise = (built ??= buildSiteRuntime(site, env).catch(
          (error) => {
            built = undefined;
            throw error;
          },
        ));
        // Every awaiting event must pin the in-flight build: workerd drops
        // a promise's continuations if its origin request context has
        // ended.
        pin(promise.catch(() => {}));
        return promise;
      };
      siteBuilds.set(site, shared);
    }
    return shared(pin);
  };

  const runHandler = async (
    runtime: SiteRuntime,
    request: Request,
    handler: Effect.Effect<any, any, any>,
    options?: SiteFetchOptions,
  ): Promise<Response | undefined> => {
    const scope = Scope.makeUnsafe();

    const exit = await recipe.requestEffect(request, handler).pipe(
      // Per-event services take precedence over the built instance
      // context: the recipe's event layers (e.g. the real or synthesized
      // ExecutionContext) shadow their init-phase stand-ins, and the fresh
      // request `Scope` is what `Effect.addFinalizer` in a handler
      // attaches to.
      Effect.provide(
        Layer.mergeAll(
          recipe.eventLayers?.(options ?? {}) ?? Layer.empty,
          Layer.succeed(Scope.Scope, scope),
          Layer.effectContext(
            buildEventTelemetry(runtime.context, scope, runtime.telemetry()),
          ),
        ).pipe(Layer.provideMerge(Layer.succeedContext(runtime.context))),
      ),
      Effect.runPromiseExit,
    );

    // Settle the request scope — unless a streaming response ejected it,
    // in which case its new owner closes it when the stream finishes. With
    // a waitUntil the close rides past the response; otherwise it settles
    // inline before returning (Lambda semantics — request finalizers block
    // the response tail).
    if (!isScopeEjected(scope)) {
      const close = new Promise((resolve) => setTimeout(resolve, 0)).then(() =>
        Effect.runPromise(Scope.close(scope, Exit.void)),
      );
      const waitUntil =
        options?.waitUntil ??
        (
          options?.executionContext as
            | { waitUntil?: (promise: Promise<unknown>) => void }
            | undefined
        )?.waitUntil?.bind(options?.executionContext);
      if (waitUntil !== undefined) {
        waitUntil(close);
      } else {
        await close.catch(() => {});
      }
    }

    if (exit._tag !== "Success") {
      throw Cause.squash(exit.cause);
    }
    return exit.value as Response;
  };

  const runFetch = (
    runtime: SiteRuntime,
    request: Request,
    options?: SiteFetchOptions,
  ): Promise<Response | undefined> => {
    const fetchHandler = runtime.shape()?.fetch;
    if (fetchHandler === undefined) {
      return Promise.resolve(undefined);
    }
    return runHandler(runtime, request, fetchHandler, options);
  };

  const match = async (
    site: object,
    request: Request,
    options?: ServeOptions,
  ): Promise<Response | undefined> => {
    markRuntime();
    const env = await recipe.resolveEnv(options?.env);
    // The four-worlds guard (DESIGN §5.3): no stack markers means a
    // build-time prerender/SSG world — decline without building layers.
    if (!hasStackMarkers(env)) {
      return undefined;
    }
    await recipe.init?.();
    const runtime = await getRuntime(site, env!, options?.waitUntil);
    return runFetch(runtime, request, {
      waitUntil: options?.waitUntil,
    });
  };

  const dispose = async (site: object): Promise<void> => {
    const build = siteBuilds.get(site);
    siteBuilds.delete(site);
    if (build !== undefined) {
      // Settle the in-flight build first so the scope close below observes
      // every registered finalizer (a failed build already cleared
      // itself).
      await build(noopPin).catch(() => undefined);
    }
    const scope = siteScopes.get(site);
    if (scope !== undefined) {
      siteScopes.delete(site);
      instanceScopes.delete(scope);
      await Effect.runPromise(Scope.close(scope, Exit.void)).catch(() => {});
    }
  };

  return { getRuntime, runFetch, match, dispose };
};
