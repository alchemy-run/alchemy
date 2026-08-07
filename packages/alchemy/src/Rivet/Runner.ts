/**
 * The Rivet **runner bridge**: resolve an `Alchemy.Worker` deployable
 * module's export map inside the runner process (a plain Node/Bun
 * container), mirroring what `WorkerBridge.getSharedBuild` does inside a
 * Cloudflare/celld isolate.
 *
 * The generated runner entry (see `RunnerEntry.ts`) imports the user's
 * `main`, calls {@link resolveWorkerExports} to run the impl's init (layer
 * stack included) exactly once, and adapts each resulting
 * `DurableObjectExport` into a Rivet actor via `makeRivetActor`.
 *
 * Two divergences from the isolate bridges, both because a runner is an
 * ordinary process:
 *
 * - the platform layer is Node-flavored (`NodeServices`, env-backed
 *   `ConfigProvider`), not `cloudflare:workers`;
 * - there is no native Durable Object binding in the environment, so a
 *   synthetic `WorkerEnvironment` maps each hosted class name to a
 *   {@link makeRivetActorClient} — in-runner `getByName` round-trips
 *   through the engine's gateway, which routes to whichever runner owns
 *   the instance.
 *
 * @internal consumed by the generated runner entry, not by user code.
 */
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as ConfigProvider from "effect/ConfigProvider";
import type * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Scope from "effect/Scope";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import type { DurableObjectExport } from "../Cloudflare/Workers/DurableObject.ts";
import { DurableObjectState } from "../Cloudflare/Workers/DurableObjectState.ts";
import { WorkerEnvironment } from "../Cloudflare/Workers/Worker.ts";
import { makeEntrypointLayer, reifyBoundConfigProvider } from "../Runtime.ts";
import { Self } from "../Self.ts";
import { Stack } from "../Stack.ts";
import { fromRivetState } from "./ActorState.ts";
import {
  makeRivetActorClient,
  parseRivetEndpoint,
  RIVET_RUNNER_POOL,
} from "./Gateway.ts";

export interface ResolveWorkerExportsOptions {
  readonly stack: { readonly name: string; readonly stage: string };
  /**
   * The Durable Object class names hosted by this worker, discovered at
   * plan time and baked into the generated entry. Each gets a synthetic
   * gateway-backed namespace in the worker environment.
   */
  readonly durableObjects: readonly string[];
}

/**
 * The synthetic runner environment: process env verbatim, plus a
 * gateway-backed namespace client under each hosted Durable Object class
 * name (where workerd would surface the native binding).
 */
const makeRunnerEnvironment = (
  durableObjects: readonly string[],
): Record<string, any> => {
  const env: Record<string, any> = { ...process.env };
  const endpoint = process.env.RIVET_ENDPOINT;
  if (endpoint !== undefined) {
    const connection = parseRivetEndpoint(endpoint);
    const pool = process.env.RIVET_POOL ?? RIVET_RUNNER_POOL;
    for (const className of durableObjects) {
      env[className] = makeRivetActorClient({ ...connection, pool }, className);
    }
  }
  return env;
};

/** Lifecycle handlers dispatched by the bridge itself — never actions. */
const RESERVED_HANDLERS = new Set([
  "fetch",
  "alarm",
  "webSocketMessage",
  "webSocketClose",
]);

/** A detached, throwaway `DurableObjectState` for method discovery. */
const makeProbeState = (): any => ({
  id: { toString: () => "__alchemy_method_probe" },
  storage: fromRivetState({ state: { kv: {} } }),
  raw: undefined,
  waitUntil: () => Effect.void,
  blockConcurrencyWhile: (callback: () => Effect.Effect<any>) => callback(),
  acceptWebSocket: () => Effect.void,
  getWebSockets: () => Effect.succeed([]),
  getTags: () => Effect.succeed([]),
  setWebSocketAutoResponse: () => Effect.void,
  getWebSocketAutoResponse: () => Effect.succeed(undefined),
  getWebSocketAutoResponseTimestamp: () => Effect.succeed(undefined),
  setHibernatableWebSocketEventTimeout: () => Effect.void,
  getHibernatableWebSocketEventTimeout: () => Effect.succeed(undefined),
  abort: () => Effect.void,
});

/**
 * Discover a Durable Object export's RPC surface by building ONE throwaway
 * instance against a detached in-memory state and reading the shape's keys.
 *
 * Rivet reads an actor's `actions` map once at registration, so the method
 * names must be known before any real instance exists. The plan-time
 * export carries `methods` when the platform discovered them; this is the
 * runner-side fallback for exports that don't (the portable
 * `Alchemy.DurableObject` today). Instances that perform storage-dependent
 * init in their per-instance effect may fail the probe — the generated
 * entry then falls back to the baked list and logs the failure.
 */
export const discoverDurableObjectMethods = (
  exported: DurableObjectExport,
): Promise<string[]> =>
  Effect.runPromise(
    Effect.gen(function* () {
      const doContext = Layer.succeed(
        DurableObjectState,
        makeProbeState(),
      ).pipe(Layer.provideMerge(Layer.succeedContext(exported.services)));
      const shape = yield* (
        exported.constructor as Effect.Effect<any, never, any>
      ).pipe(
        Effect.provide(doContext),
        Effect.flatMap((instance: any) =>
          Effect.isEffect(instance)
            ? instance.pipe(Effect.provide(doContext))
            : Effect.succeed(instance),
        ),
      );
      return Object.keys((shape as Record<string, unknown>) ?? {}).filter(
        (name) => !RESERVED_HANDLERS.has(name),
      );
    }) as Effect.Effect<string[]>,
  );

/**
 * Build the deployable module's layer stack once and return the resolved
 * export map (`default` + one `DurableObjectExport` per hosted class).
 *
 * A `Promise` on purpose: this is the runner entry's top-level await, and
 * the process-lifetime build scope is never closed (the runner runs until
 * the engine drains it).
 */
export const resolveWorkerExports = (
  entrypoint: any,
  options: ResolveWorkerExportsOptions,
): Promise<Record<string, any>> => {
  const tag = Self as any as Context.Service<
    never,
    { RuntimeContext: { exports: Effect.Effect<Record<string, any>> } }
  >;
  const layer = makeEntrypointLayer(tag, entrypoint);

  const globalContext = layer.pipe(
    Layer.provideMerge(
      Layer.succeed(Stack, {
        name: options.stack.name,
        stage: options.stack.stage,
        bindings: {},
        resources: {},
        actions: {},
      }),
    ),
    Layer.provideMerge(
      Layer.mergeAll(
        NodeServices.layer,
        FetchHttpClient.layer,
        Logger.layer([Logger.consolePretty()]),
      ),
    ),
    Layer.provideMerge(
      Layer.succeed(
        ConfigProvider.ConfigProvider,
        ConfigProvider.orElse(
          ConfigProvider.fromUnknown({ ALCHEMY_PHASE: "runtime" }),
          // Auto-bound `Config` values arrive in the environment as
          // `{"_tag":"Redacted","value":...}` markers; reify them so a
          // `Config` re-read inside an action decodes the source value.
          reifyBoundConfigProvider(
            ConfigProvider.fromEnv(),
            process.env as Record<string, unknown>,
          ),
        ),
      ),
    ),
    Layer.provideMerge(
      Layer.succeed(
        WorkerEnvironment,
        makeRunnerEnvironment(options.durableObjects),
      ),
    ),
  );

  // Process-lifetime build scope — never closed (the runner has no teardown
  // hook short of the engine draining the process).
  const scope = Scope.makeUnsafe();
  const memoMap = Layer.makeMemoMapUnsafe();

  return Effect.runPromise(
    Layer.buildWithMemoMap(globalContext, memoMap, scope).pipe(
      Effect.flatMap((context) =>
        tag.pipe(
          Effect.flatMap((worker) => worker.RuntimeContext.exports),
          Effect.provideContext(context),
        ),
      ),
    ) as Effect.Effect<Record<string, any>>,
  );
};
