/**
 * The shared `alchemy/Serve` runtime bridge core (DESIGN §3.3, §6.4).
 *
 * One lazy, WeakMap-memoized isolate-scope layer build per Website class per
 * process (mirroring `Cloudflare/Workers/WorkerBridge.ts`), and a fresh
 * request `Scope` per event settled via `waitUntil` when the call site has
 * one and inline before the response otherwise (Lambda semantics).
 *
 * Within its routes the effect fetch is AUTHORITATIVE: every outcome of the
 * effect — including a `RouteNotFound` failure, which the standard request
 * pipeline (`safeHttpEffect`'s `causeResponse`) renders as the effect's own
 * 404 response — is the final answer. Delegation to the framework is purely
 * a `server.routes` decision made by the caller (`Serve.make`, the wrapper
 * entries) BEFORE the effect fetch is invoked; there is no response-based
 * fallback protocol.
 *
 * Everything here runs *inside* the deployed function (or a dev server /
 * prerenderer importing the framework entry) — never in the engine's plan
 * process. Layer builds are guarded by the env-marker check in `Env.ts`, so
 * a build-time prerender world (no `ALCHEMY_STACK_NAME`) declines without
 * touching any I/O.
 */

import * as Cause from "effect/Cause";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import { MinimumLogLevel } from "effect/References";
import * as Scope from "effect/Scope";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
// Leaf tag modules, NOT the engine modules: `CloudflareEnvironment.ts`
// reaches the OAuth client (`node:http`) and `Stack.ts` reaches
// `Util/Node.ts` (`node:net`) — module-scope `node:*` externals are fatal
// in foreign-bundled workerd server bundles (see the platform note in
// `buildSiteRuntime`).
import { CloudflareEnvironment } from "../Cloudflare/CloudflareEnvironmentTag.ts";
import { makeRequestEffect } from "../Cloudflare/Workers/HttpServer.ts";
// The RuntimeEnvironment leaf, NOT Worker.ts: the bridge is compiled by
// foreign bundlers (Next/turbopack, nitro rollup), and Worker.ts's provider
// import graph reaches the workerd native binary through the local-runtime
// chain — unparseable there.
import {
  WorkerEnvironment,
  WorkerExecutionContext,
  deferredExecutionContext,
  fromExecutionContext,
} from "../Cloudflare/Workers/RuntimeEnvironment.ts";
import { isScopeEjected } from "../Http.ts";
import { makeEntrypointLayer, reifyBoundConfigProvider } from "../Runtime.ts";
import type { BaseRuntimeContext } from "../RuntimeContext.ts";
import { Self } from "../Self.ts";
import { StackTag as Stack } from "../StackTag.ts";
import { buildEventTelemetry } from "../Telemetry.ts";
import type { SERVE_SENTINEL } from "./constants.ts";
import { envString, hasStackMarkers, resolveServeEnv } from "./Env.ts";

// The wiring-handshake sentinel, written as a literal (type-checked against
// `constants.ts`) so the exact byte sequence provably survives bundling and
// minification into any foreign server bundle that imports the bridge — the
// deploy-time sentinel scan greps the built bundle for it. The global marker
// itself is inert (unlike `__ALCHEMY_RUNTIME__`, which is only stamped at
// bridge-construction time — see `markRuntime`).
const SENTINEL: typeof SERVE_SENTINEL = "__ALCHEMY_SERVE_v1__";
(globalThis as Record<string, any>)[SENTINEL] = true;

/**
 * Stamp the runtime flag. Called synchronously when a bridge is constructed
 * (`Serve.make`, `makeWebsiteExports`, the framework adapters) — always
 * before any init Effect can run, so every
 * `if (!globalThis.__ALCHEMY_RUNTIME__)` bind guard is a no-op at runtime
 * even when the framework's bundler defined nothing.
 *
 * Deliberately NOT a module-evaluation side effect: `alchemy/Serve` is
 * imported by the user's `src/backend.ts`, which the engine also imports at plan
 * time — a module-eval flag would poison the plan world (DESIGN §5.3 world
 * 1 requires the flag unset there).
 */
export const markRuntime = (): void => {
  globalThis.__ALCHEMY_RUNTIME__ = true;
};

export interface ServeOptions {
  /**
   * Explicit env when the framework hands it over (kit
   * `event.platform.env`, nitro `event.context.cloudflare.env`). Default
   * resolution: guarded `cloudflare:workers` env →
   * `getCloudflareContext()`-shaped globals → `process.env`.
   */
  env?: unknown;
  /**
   * Extend the event past the response (workerd `ctx.waitUntil`). Default:
   * the request scope is settled inline before the response returns.
   */
  waitUntil?: (promise: Promise<unknown>) => void;
}

/**
 * The isolate-lifetime artifacts of one site build: the built service
 * Context, a thunk for the user's impl shape (populated once `serve` has
 * run during init), and the telemetry Layer override registered during init.
 */
export interface SiteRuntime {
  readonly context: Context.Context<any>;
  readonly shape: () => Record<string, any> | undefined;
  readonly telemetry: () => Layer.Layer<never, any, any> | undefined;
}

/**
 * Close the isolate scope in Lambda's Shutdown window (SIGTERM + 500 ms) so
 * init-level finalizers run before the sandbox dies. Best-effort: where
 * alchemy owns the entry (`FunctionBundle`'s generated entry) the extension
 * registration guarantees the window; on explicit mounts inside a
 * framework-owned entry this `process.on` is all we can do. Never
 * registered on workerd — there is no isolate-teardown hook, and the scope
 * deliberately never closes there.
 */
const registerInstanceShutdown = (scope: Scope.Closeable): void => {
  if (
    (globalThis as { navigator?: { userAgent?: string } }).navigator
      ?.userAgent === "Cloudflare-Workers"
  ) {
    return;
  }
  const proc = (globalThis as { process?: any }).process;
  if (typeof proc?.on !== "function") {
    return;
  }
  proc.on("SIGTERM", () => {
    void Effect.runPromise(Scope.close(scope, Exit.void)).catch(() => {});
  });
};

/**
 * Build the isolate-lifetime layer stack for a Website class against a
 * resolved env — the same recipe `WorkerBridge.getSharedBuild` uses, with
 * the env injected from the resolution ladder instead of the
 * `cloudflare:workers` importable env (the bridge may be running in a
 * Lambda sandbox or a Node dev server).
 */
const buildSiteRuntime = async (
  site: object,
  env: Record<string, unknown>,
): Promise<SiteRuntime> => {
  const tag = Self as any as Context.Service<
    never,
    { RuntimeContext: BaseRuntimeContext }
  >;

  const layer = makeEntrypointLayer(tag, site);

  // Platform by world. On workerd the Node platform must stay OUT of the
  // graph entirely: the bridge rides the value-form `createClient` graph
  // into framework server bundles (Next/turbopack, nitro rollup), which
  // externalize `node:*` imports that OpenNext/nitro's runtime loaders
  // cannot satisfy — a static NodeServices import 500s every SSR dispatch
  // ("Failed to load external module node:process"). The dynamic import
  // below is only evaluated in Node worlds (framework dev servers,
  // prerenderers), where platform-node genuinely exists.
  const basePlatform = Layer.mergeAll(
    FetchHttpClient.layer,
    Logger.layer([Logger.consolePretty()]),
  );
  const platform =
    typeof navigator !== "undefined" &&
    navigator.userAgent === "Cloudflare-Workers"
      ? basePlatform
      : Layer.mergeAll(
          (await import("@effect/platform-node/NodeServices")).layer,
          basePlatform,
        );

  const globalContext = layer.pipe(
    Layer.provideMerge(
      Layer.succeed(Stack, {
        name: envString(env.ALCHEMY_STACK_NAME) ?? "",
        stage: envString(env.ALCHEMY_STAGE) ?? "",
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
          // Auto-bound `Config` values arrive in `env` as
          // `{"_tag":"Redacted","value":...}` markers; reify them so a
          // `Config` re-read inside a request handler decodes the raw
          // source value instead of the marker JSON.
          reifyBoundConfigProvider(ConfigProvider.fromUnknown(env), env),
        ),
      ),
    ),
    Layer.provideMerge(Layer.succeed(WorkerEnvironment, env)),
    // Init-phase ExecutionContext: yieldable from the site's top-level
    // closure; its RuntimeContext-colored methods defer to the real
    // per-event context provided in `runSiteFetch`.
    Layer.provideMerge(
      Layer.succeed(WorkerExecutionContext, deferredExecutionContext),
    ),
    Layer.provideMerge(
      Layer.succeed(
        CloudflareEnvironment,
        // @ts-expect-error - mirrors WorkerBridge: only this property is
        // needed and available at runtime
        Effect.succeed({
          account: env.ALCHEMY_CLOUDFLARE_ACCOUNT_ID,
        }),
      ),
    ),
    Layer.provideMerge(
      Layer.succeed(MinimumLogLevel, env.DEBUG ? "Debug" : "Info"),
    ),
  );

  // Isolate-lifetime scope for the layer build: never closed on workerd
  // (no teardown hook), best-effort SIGTERM close elsewhere.
  const instanceScope = Scope.makeUnsafe();
  registerInstanceShutdown(instanceScope);
  const memoMap = Layer.makeMemoMapUnsafe();

  return Effect.runPromise(
    Layer.buildWithMemoMap(globalContext, memoMap, instanceScope).pipe(
      // Strip the build's memo map from the exposed context so a Layer the
      // user `Effect.provide`s inside a handler builds per event instead of
      // sharing one instance across concurrent events.
      Effect.map(Context.omit(Layer.CurrentMemoMap)),
      Effect.flatMap((context) =>
        tag.pipe(
          Effect.map((instance): SiteRuntime => {
            const runtimeContext = instance.RuntimeContext;
            return {
              context,
              shape: () => {
                if (typeof runtimeContext.shape !== "function") {
                  throw new Error(
                    `alchemy/Serve: the ${runtimeContext.Type} platform does ` +
                      "not expose a runtime fetch surface yet — only " +
                      "Cloudflare Website/Worker classes are supported by " +
                      "this release (AWS Website support lands with the " +
                      "hybrid Function mode).",
                  );
                }
                return runtimeContext.shape() as
                  | Record<string, any>
                  | undefined;
              },
              telemetry: () => runtimeContext.telemetry,
            };
          }),
          Effect.provideContext(context),
        ),
      ),
    ),
  );
};

/**
 * One isolate-lifetime layer build per Website class, lazily created on the
 * first matched request and shared by every subsequent event. Only success
 * is memoized — a transient init failure resets the memo and heals on the
 * next event. The env captured by the first successful build wins for the
 * lifetime of the process (env objects are stable per instance on every
 * supported host).
 *
 * The constraint this WeakMap key implies: never import the site class via
 * inconsistent specifiers within one framework graph — two module ids mean
 * two keys and two layer stacks.
 */
const siteBuilds = new WeakMap<
  object,
  (pin: (promise: Promise<unknown>) => unknown) => Promise<SiteRuntime>
>();

export const getSiteRuntime = (
  site: object,
  env: Record<string, unknown>,
  pin: (promise: Promise<unknown>) => unknown,
): Promise<SiteRuntime> => {
  let shared = siteBuilds.get(site);
  if (shared === undefined) {
    let built: Promise<SiteRuntime> | undefined;
    shared = (pin) => {
      const promise = (built ??= buildSiteRuntime(site, env).catch((error) => {
        built = undefined;
        throw error;
      }));
      // Every awaiting event must pin the in-flight build: workerd drops a
      // promise's continuations if its origin request context has ended.
      pin(promise.catch(() => {}));
      return promise;
    };
    siteBuilds.set(site, shared);
  }
  return shared(pin);
};

export interface SiteFetchOptions {
  waitUntil?: (promise: Promise<unknown>) => void;
  /** The live per-event workerd ExecutionContext, when the caller has one. */
  executionContext?: unknown;
}

/**
 * Run one fetch event against a built site: fresh request `Scope`, the
 * production request pipeline (`makeRequestEffect`), and per-event
 * telemetry. The effect fetch is authoritative — a `RouteNotFound` failure
 * renders as the effect's own 404 response through the standard pipeline.
 * Resolves the web `Response`, or `undefined` only when the site exposes no
 * fetch handler.
 */
export const runSiteFetch = (
  runtime: SiteRuntime,
  request: Request,
  options?: SiteFetchOptions,
): Promise<Response | undefined> => {
  const fetchHandler = runtime.shape()?.fetch;
  if (fetchHandler === undefined) {
    return Promise.resolve(undefined);
  }
  return runSiteHandler(runtime, request, fetchHandler, options);
};

const runSiteHandler = async (
  runtime: SiteRuntime,
  request: Request,
  handler: Effect.Effect<any, any, any>,
  options?: SiteFetchOptions,
): Promise<Response | undefined> => {
  const scope = Scope.makeUnsafe();

  const executionContextLayer =
    options?.executionContext !== undefined
      ? Layer.succeed(
          WorkerExecutionContext,
          fromExecutionContext(options.executionContext as any),
        )
      : options?.waitUntil !== undefined
        ? Layer.succeed(
            WorkerExecutionContext,
            // Synthesize a minimal ExecutionContext from the adapter's
            // waitUntil so `ctx.waitUntil`-colored user code works on
            // entries that never see the real workerd context.
            fromExecutionContext({
              waitUntil: (promise: Promise<unknown>) =>
                options.waitUntil!(promise),
              passThroughOnException: () => {},
            } as any),
          )
        : Layer.empty;

  const exit = await makeRequestEffect(request as any, handler).pipe(
    // Per-event services take precedence over the built isolate context:
    // the real (or synthesized) WorkerExecutionContext shadows the deferred
    // one, and the fresh request `Scope` is what `Effect.addFinalizer` in a
    // handler attaches to.
    Effect.provide(
      Layer.mergeAll(
        executionContextLayer,
        Layer.succeed(Scope.Scope, scope),
        Layer.effectContext(
          buildEventTelemetry(runtime.context, scope, runtime.telemetry()),
        ),
      ).pipe(Layer.provideMerge(Layer.succeedContext(runtime.context))),
    ),
    Effect.runPromiseExit,
  );

  // Settle the request scope — unless a streaming response ejected it, in
  // which case its new owner closes it when the stream finishes. With a
  // waitUntil the close rides past the response; otherwise it settles
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
      await close;
    }
  }

  if (exit._tag !== "Success") {
    throw Cause.squash(exit.cause);
  }
  return exit.value as Response;
};

const noopPin = (): void => {};

/**
 * The explicit-tier entry: resolve the env ladder, apply the four-worlds
 * guard, lazily build the site, and run the fetch effect. Resolves
 * `undefined` on decline (no env markers or no fetch handler) so the
 * caller falls through to the framework. Route gating happens in the
 * caller (`Serve.make`) — a request that reaches this function is inside
 * the effect's claim, and the effect's answer (404s included) is final.
 */
export const matchSite = async (
  site: object,
  request: Request,
  options?: ServeOptions,
): Promise<Response | undefined> => {
  markRuntime();
  const env = await resolveServeEnv(options?.env);
  if (!hasStackMarkers(env)) {
    return undefined;
  }
  const runtime = await getSiteRuntime(
    site,
    env,
    options?.waitUntil ?? noopPin,
  );
  return runSiteFetch(runtime, request, { waitUntil: options?.waitUntil });
};
