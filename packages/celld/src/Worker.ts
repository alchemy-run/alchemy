import * as Binding from "alchemy/Binding";
import { safeHttpEffect, type HttpEffect } from "alchemy/Http";
import type { Input, InputProps } from "alchemy/Input";
import { Namespace } from "alchemy/Namespace";
import * as Output from "alchemy/Output";
import type { Main, MainRpc } from "alchemy/Platform";
import { Platform } from "alchemy/Platform";
import { Random } from "alchemy/Random";
import type { Resource, ResourceLike } from "alchemy/Resource";
import { RpcCallError, makeFetchRpcStub, serveRpc, type Rpc } from "alchemy/Rpc";
import type { Self } from "alchemy/Self";
import { isDurableObjectHost } from "alchemy/Workers/DurableObject";
import type { WorkerEnvironment } from "alchemy/Workers/Worker";
import { dispatchRpcMethod } from "alchemy/Workers/WorkerBridge";
import type { WorkerBuildOptions } from "alchemy/Workers/Workerd/Bundle";
import type { Request } from "alchemy/Workers/Workerd/Request";
import { isWorkerEvent } from "alchemy/Workers/Workerd/WorkerEvent";
import type { WorkerRuntimeContext } from "alchemy/Workers/Workerd/WorkerRuntimeContext";
import { makeWorkerRuntimeContext } from "alchemy/Workers/Workerd/WorkerRuntimeContext";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import type * as HttpClientResponse from "effect/http/HttpClientResponse";
import * as Redacted from "effect/Redacted";
import type { Application } from "./Application.ts";
import { type PreparedContainer } from "./Containers/Images.ts";
import {
  type CelldAssetsConfig,
  type CelldBinding,
  type CelldContainerConfig,
  type CelldQueueConsumer,
} from "./DeploymentConfig.ts";
import { durableObjectBinding, durableObjectStub } from "./DurableObject.ts";
import { lowerEnvironment } from "./Environment.ts";
import type { WorkerExecutionContext } from "./ExecutionContext.ts";
import { type Fleet } from "./Fleet.ts";
import { CurrentFleet } from "./FleetContext.ts";
import type { FleetBucket } from "./Host.ts";
import { type StorageBinding } from "./KV/StorageBinding.ts";
import type { Providers } from "./Providers.ts";
import { FLEET_SECRET_HEADER } from "./WorkerBridge.ts";
import { type CelldMigration } from "./Wrangler.ts";

// `CurrentFleet` is also a requirement of the Worker resource itself, so an
// impl that declares fleet-scoped storage still surfaces it on the Layer.
type WorkerServices =
  | CelldWorker
  | CurrentFleet
  | Providers
  | WorkerEnvironment
  | WorkerExecutionContext
  | Request
  | Self;
type WorkerShape = Main<WorkerServices> & MainRpc<WorkerServices>;

export const CelldWorkerTypeId = "Celld.Worker";
export type CelldWorkerTypeId = typeof CelldWorkerTypeId;

/** A reference to the {@link Fleet} a worker deploys onto: the Fleet class. */
export type FleetRef = Effect.Effect<Fleet, never, any>;

/** The public props of a `Celld.Worker`. */
export interface CelldWorkerProps {
  /** Static files served by the application's entry Worker. */
  assets?: CelldAssetsConfig;
  /** Explicit environment values for native Worker modules. */
  env?: Record<string, unknown>;
  /** Native binding declarations; Effect capabilities register these automatically. */
  bindings?: CelldBinding[];
  /** Entry module of the worker bundle, usually `import.meta.url`. */
  main: string;
  /**
   * Exact Celld runtime version required by this deployment.
   * @default DEFAULT_CELLD_VERSION
   */
  celldVersion?: string;
  /**
   * Workers compatibility date for the bundle.
   * @default "2025-06-01"
   */
  compatibilityDate?: string;
  /**
   * Workers compatibility flags for the bundle.
   * @default ["nodejs_compat"]
   */
  compatibilityFlags?: string[];
  /** Bundler configuration overrides. */
  build?: WorkerBuildOptions;
}

/**
 * The persisted Props of the `Celld.Worker` resource: the deploy config
 * plus the fleet connection material resolved by the props transform
 * (attribute Outputs of the Fleet — resolved to plain values by
 * reconcile), plus the env/exports channels the platform machinery fills.
 */
export interface CelldWorkerResourceProps {
  /** Entry module of the worker bundle. */
  main: string;
  /** Celld runtime version captured from the selected fleet. */
  celldVersion?: string;
  /** Static asset configuration. */
  assets?: CelldAssetsConfig;
  /** Explicit native bindings. */
  bindings?: CelldBinding[];
  /** Captured fleet checks for explicit resource-valued environment entries. @internal */
  storageBindings?: StorageBinding[];
  /** Workers compatibility date for the bundle. */
  compatibilityDate?: string;
  /** Workers compatibility flags for the bundle. */
  compatibilityFlags?: string[];
  /** Bundler configuration overrides. */
  build?: WorkerBuildOptions;
  /** Logical id of the {@link Fleet} this worker deploys onto. */
  fleetId?: string;
  /** The fleet's deployment bucket. */
  bucket?: FleetBucket;
  /** The fleet's internal URL. */
  fleetUrl?: string;
  /** The per-worker gateway secret checked by the RPC guard. */
  fleetSecret?: Redacted.Redacted<string>;
  /** Host-specific connection state copied from the fleet. */
  hostState?: Record<string, any>;
  /** Extra environment variables for the worker. @internal */
  env?: Record<string, any>;
  /** Durable Object / export map, populated from the impl. @internal */
  exports?: Record<string, any>;
  /** @internal */
  isExternal?: boolean;
}

/**
 * The binding contract of a `Celld.Worker`: what bindings registered ON
 * the worker carry (Durable Object class declarations, env vars).
 */
export interface CelldWorkerBindingContract {
  env?: Record<string, any>;
  durableObjects?: { name: string; className: string }[];
  bindings?: CelldBinding[];
  storageBindings?: StorageBinding[];
  queueConsumers?: CelldQueueConsumer[];
  crons?: string[];
  containers?: CelldContainerConfig[];
}

export interface CelldWorkerAttributes {
  workerName: string;
  /** The worker's URL on the fleet's private network. */
  url: string;
  /** The internal fleet URL — what a `bindWorker` caller speaks to over the fleet network. */
  fleetUrl: string;
  /** Host-specific connection state (network attachment for callers). */
  hostState: Record<string, any> | undefined;
  /** The deployed content id (bundle-hash prefix). */
  deploymentId: string;
  /** Native content version of the staged deployment. */
  versionId: string | undefined;
  /** Fully qualified owner fleet identity. */
  fleetId: string;
  /** Immutable deployment prefix in the backing bucket. */
  prefix: string;
  /** Alchemy candidate descriptor used by Application activation. */
  stagedManifestKey: string;
  /** Prepared native container specs; absent in legacy Worker state. */
  preparedContainers?: PreparedContainer[];
  /** The persisted Durable Object class map (migration baseline). */
  durableObjectClasses: Record<string, string>;
  migrations: CelldMigration[];
  code: { hash: string; assetsHash?: string };
}

export interface CelldWorker extends Resource<
  CelldWorkerTypeId,
  CelldWorkerResourceProps,
  CelldWorkerAttributes,
  CelldWorkerBindingContract,
  Providers | CurrentFleet
> {}

/** The worker was declared without a fleet, so it has nothing to deploy onto. */
export class WorkerNotConnected extends Data.TaggedError("Celld.WorkerNotConnected")<{
  readonly message: string;
}> {}

/** A binding lacks an activated root Application or a deployed caller connection. */
export class WorkerUnreachable extends Data.TaggedError("Celld.WorkerUnreachable")<{
  readonly message: string;
}> {}

/**
 * The per-worker gateway-secret {@link Random} node. Anchored at the ROOT
 * namespace (the Namespace service is stripped when it is yielded) so the
 * worker's props transform and `bindWorker` — which run under different
 * ambient namespaces — always resolve the SAME node.
 */
const mintGatewaySecret = (workerLogicalId: string) =>
  Random(`${workerLogicalId}-GatewaySecret`, { bytes: 32 }).pipe(
    Effect.updateContext(Context.omit(Namespace)),
  );

/**
 * Resolve the public props into the persisted resource props: copy the
 * fleet's connection material off its attributes, mint the per-worker
 * gateway secret. A no-op
 * at runtime — inside a deployed bundle only the runtime behaviors
 * matter, and the fleet node must never be touched.
 */
const transformWorkerProps = (
  id: string,
  props: CelldWorkerProps & { isExternal?: boolean },
): Effect.Effect<InputProps<CelldWorkerResourceProps>, any, any> =>
  Effect.gen(function* () {
    const base: InputProps<CelldWorkerResourceProps> = {
      main: props.main,
      celldVersion: props.celldVersion,
      compatibilityDate: props.compatibilityDate,
      compatibilityFlags: props.compatibilityFlags,
      build: props.build,
      assets: props.assets,
      env: props.env,
      bindings: props.bindings,
      isExternal: props.isExternal,
    };
    if (globalThis.__ALCHEMY_RUNTIME__) {
      return base;
    }
    const fleet = yield* CurrentFleet;
    const environment = yield* lowerEnvironment(props.env ?? {});
    // The gateway secret is per-WORKER: minted here into the deployed vars
    // and by `bindWorker` into each caller's env — the same root-anchored
    // Random node on both paths.
    const secret = yield* mintGatewaySecret(id);

    return {
      ...base,
      env: environment.env,
      bindings: [...(props.bindings ?? []), ...environment.bindings],
      storageBindings: environment.storageBindings,
      fleetId: fleet.FQN,
      bucket: fleet.bucket,
      fleetUrl: fleet.fleetUrl,
      fleetSecret: secret.text,
      hostState: fleet.hostState,
    };
  });

/**
 * The class surface of {@link Worker} — the native Platform forms
 * (`Celld.Worker("Id", props, impl)`, the `<Self>()` tag/class forms with
 * `.make(props, impl)`), typed over the public {@link CelldWorkerProps}.
 */
export type CelldWorkerClass = Platform<
  CelldWorker,
  WorkerServices,
  WorkerShape,
  WorkerRuntimeContext,
  {},
  CelldWorkerProps
>;

/**
 * A **Celld worker**: user code deployed onto a {@link Fleet}, hosting
 * `Celld.DurableObject` declarations whose implementations use
 * `Celld.DurableObjectState`. The fleet serves the worker behind the
 * gateway in `Celld/WorkerBridge.ts` (Durable Object routing, the guarded
 * RPC surface `bindWorker` stubs call, the readiness probe).
 *
 * The resource bundles the implementation and stages immutable native artifacts
 * through the backing object-store API. `Celld.Application` separately owns
 * publication and activation. No deployment CLI or node restart is used.
 *
 * ### Deploying a Worker to a Fleet
 * **Example:** Worker hosting a Celld Durable Object
 * ```typescript
 * import * as Alchemy from "alchemy";
 * import * as AWS from "alchemy/AWS";
 * import * as Celld from "alchemy/Celld";
 * import * as Effect from "effect/Effect";
 * import * as Layer from "effect/Layer";
 * import * as HttpServerResponse from "effect/http/HttpServerResponse";
 *
 * export class Cells extends Celld.Fleet<Cells>()("Cells") {}
 * export class Api extends Celld.Worker<Api>()("Api") {}
 *
 * export interface CounterShape {
 *   increment: () => Effect.Effect<number, never, Alchemy.RuntimeContext>;
 * }
 *
 * export class Counter extends Celld.DurableObject<Counter, CounterShape>()(
 *   "Counter",
 * ) {}
 *
 * export const CounterLive = Counter.make(
 *   Effect.gen(function* () {
 *     const state = yield* Celld.DurableObjectState;
 *     return Effect.gen(function* () {
 *       return {
 *         increment: () =>
 *           Effect.gen(function* () {
 *             const next = ((yield* state.storage.get<number>("count")) ?? 0) + 1;
 *             yield* state.storage.put("count", next);
 *             return next;
 *           }),
 *       } satisfies CounterShape;
 *     });
 *   }),
 * );
 *
 * const ApiLive = Api.make(
 *   { main: import.meta.url },
 *   Effect.gen(function* () {
 *     const counters = yield* Counter;
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const value = yield* counters.getByName("lobby").increment();
 *         return yield* HttpServerResponse.json({ value });
 *       }),
 *     };
 *   }).pipe(Effect.provide(CounterLive)),
 * );
 * export default ApiLive;
 *
 * export const stack = Alchemy.Stack(
 *   "app",
 *   {
 *     providers: Layer.mergeAll(
 *       AWS.providers(),
 *       Celld.providers(),
 *       Celld.EcsFleet(),
 *     ),
 *     state: AWS.state(),
 *   },
 *   Effect.gen(function* () {
 *     const app = yield* Celld.Application("App", { entrypoint: Api });
 *     return { url: app.url };
 *   }).pipe(Effect.provide(ApiLive.pipe(Layer.provideMerge(Celld.Fleet.layer(Cells))))),
 * );
 * ```
 *
 * **Example:** Tag + deploy module (acyclic multi-file form)
 * ```typescript
 * // worker.ts — the shared tag
 * export class Api extends Celld.Worker<Api>()("Api") {}
 *
 * // main.ts — the deploy module
 * export default Api.make(
 *   { main: import.meta.url },
 *   Effect.gen(function* () {
 *     const counters = yield* Counter;
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const value = yield* counters.getByName("lobby").increment();
 *         return yield* HttpServerResponse.json({ value });
 *       }),
 *     };
 *   }).pipe(Effect.provide(CounterLive)),
 * );
 * ```
 *
 * ### Serving a Worker publicly
 * The fleet's listener serves only the Application entrypoint. Set
 * `ingress` on the {@link Fleet} to put it behind a public load balancer.
 *
 * **Example:** Public HTTPS on a custom domain, DNS on Cloudflare
 * ```typescript
 * import * as Cloudflare from "@alchemy.run/cloudflare";
 *
 * export class Cells extends Celld.Fleet<Cells>()("Cells", {
 *   ingress: {
 *     domain: { name: "api.example.com", dns: Cloudflare.DNS.Adapter() },
 *   },
 * }) {}
 * // (yield* Celld.Application("App", { entrypoint: Api })).url === "https://api.example.com"
 * ```
 *
 * ### Calling a Worker from another host
 * **Example:** Secure schemaless RPC from a Lambda
 * ```typescript
 * export default class Backend extends AWS.Lambda.Function<Backend>()(
 *   "Backend",
 *   { main: import.meta.url },
 *   Effect.gen(function* () {
 *     const api = yield* Celld.bindWorker(App, Api);
 *     const counters = api.durableObject<CounterShape>("Counter");
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const value = yield* counters.getByName("lobby").increment();
 *         return yield* HttpServerResponse.json({ value });
 *       }),
 *     };
 *   }),
 * ) {}
 * ```
 *
 * @resource
 * @product Celld
 */
export const Worker: CelldWorkerClass = Platform(CelldWorkerTypeId, {
  transformProps: transformWorkerProps,
  createRuntimeContext: (id: string) => {
    const base = makeWorkerRuntimeContext(id, { type: CelldWorkerTypeId });
    const ctx = {
      ...base,
      // Always boot the server: the gateway routes Durable Objects for a
      // worker that hosts DOs but returns no fetch handler of its own.
      alwaysServe: true,
      // The worker's own RPC surface (the schemaless methods `bindWorker`
      // stubs call) is served under `/__rpc__/{method}` ahead of the
      // user's fetch — the bridge has already guarded that path.
      serve: <Req = never>(
        handler: HttpEffect<Req> | Effect.Effect<HttpEffect<Req>>,
        options?: { shape?: Record<string, unknown> },
      ) =>
        Effect.gen(function* () {
          const shape = options?.shape ?? {};
          if (typeof shape.tail === "function") {
            yield* base.listen<unknown, Req>((event) => {
              if (!isWorkerEvent(event) || event.type !== "tail") return;
              return dispatchRpcMethod(shape, "tail", [event.input]).pipe(Effect.orDie);
            });
          }
          yield* base.serve(serveRpc(shape, safeHttpEffect(handler)), options);
        }),
      durableObjectBinding,
      durableObjectStub,
    };
    return ctx;
  },
}) as CelldWorkerClass;

// ── bindWorker: secure schemaless RPC over the fleet gateway ───────────

/** A caller host that can carry a network attachment (a Lambda Function, an ECS task). */
interface NetworkHost extends ResourceLike {
  readonly bind: (
    template: TemplateStringsArray,
    ...args: unknown[]
  ) => (data: {
    vpc: { subnetIds: Input<string[]>; securityGroupIds: Input<string[]> };
  }) => Effect.Effect<void>;
}

const isNetworkHost = (host: ResourceLike | undefined): host is NetworkHost =>
  host !== undefined &&
  "bind" in host &&
  typeof host.bind === "function" &&
  // Native worker hosts (Cloudflare / Celld / Rivet) cannot attach to a
  // fleet network.
  !isDurableObjectHost(host);

/** A Durable Object namespace addressed through a worker's gateway. */
export interface CelldDurableObjectNamespaceClient<Shape = any> {
  /** Address the named instance — the stub's methods mirror `Shape`. */
  getByName: (name: string) => Shape & {
    fetch: (
      request: HttpClientRequest.HttpClientRequest,
    ) => Effect.Effect<HttpClientResponse.HttpClientResponse, unknown>;
  };
}

/** The base surface every `Celld.bindWorker` stub carries. */
export interface CelldWorkerClient {
  /**
   * Raw authenticated fetch against the worker's gateway URL: the
   * request's path + query are grafted onto the fleet URL and the gateway
   * secret header is set.
   */
  fetch: (
    request: HttpClientRequest.HttpClientRequest,
  ) => Effect.Effect<HttpClientResponse.HttpClientResponse, unknown>;
  /**
   * Address a Durable Object namespace hosted on the worker
   * (`/{namespace}/{instance}/__rpc__/{method}` over the gateway).
   */
  durableObject: <Shape = any>(namespace: string) => CelldDurableObjectNamespaceClient<Shape>;
  /** The internal fleet URL the stub speaks to (readable at runtime). */
  fleetUrl: Effect.Effect<string>;
  /** The per-worker gateway secret the stub authenticates with (readable at runtime). */
  secret: Effect.Effect<Redacted.Redacted<string>>;
}

/**
 * Bind a caller host (Lambda Function, ECS task, …) to a {@link Worker}
 * and return the typed schemaless RPC stub — the celld mirror of
 * `Cloudflare.Workers.bindWorker`.
 *
 * Pass the publishing Application and its root Worker. The Application's
 * activation outputs order the caller after publication and readiness; a staged
 * Worker alone is not callable. Non-root and cross-fleet targets are rejected
 * because the fleet listener serves only the Application entrypoint. Accepts an
 * Application resource or its constructor Effect; the latter must carry its
 * Fleet layer and resolve the same Application identity in the stack and caller.
 *
 * The Application's internal fleet URL and network attachment, plus the root
 * Worker's gateway secret, are bound into the caller. Requests are never
 * automatically retried: a failed response may follow a successful mutation.
 *
 * ### Calling cells from a Lambda
 * **Example:** Typed Durable Object RPC over the fleet gateway
 * ```typescript
 * export default class Backend extends AWS.Lambda.Function<Backend>()(
 *   "Backend",
 *   { main: import.meta.url },
 *   Effect.gen(function* () {
 *     const api = yield* Celld.bindWorker(App, Api);
 *     const counters = api.durableObject<CounterShape>("Counter");
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const value = yield* counters.getByName("lobby").increment();
 *         return yield* HttpServerResponse.json({ value });
 *       }),
 *     };
 *   }),
 * ) {}
 * ```
 *
 * **Example:** The worker's own surface through the authenticated fetch
 * ```typescript
 * const response = yield* api.fetch(HttpClientRequest.get("/hello"));
 * ```
 *
 * @binding
 * @product Celld
 */
export const bindWorker = <Shape = {}>(
  application: Application | Effect.Effect<Application, never, any>,
  worker:
    | Effect.Effect<CelldWorker & Rpc<Shape>, never, any>
    | Effect.Effect<CelldWorker, never, any>,
): Effect.Effect<Shape & CelldWorkerClient> =>
  Effect.gen(function* () {
    const app = Effect.isEffect(application) ? yield* application : application;
    const target = yield* worker;
    const secret = yield* mintGatewaySecret(target.LogicalId);
    // Resolving this binding requires activation, not merely Worker staging.
    if (!globalThis.__ALCHEMY_RUNTIME__) {
      // Deploy-time only: resolving this Output fails the caller's deploy
      // unless the Application is activated and `worker` is its root. Its
      // bound key is derived from the expression (closure source included),
      // so the runtime never reads it back — it reads `fleetUrl` below.
      yield* Output.all(
        app.revision,
        app.workerName,
        app.fleetId,
        app.fleetUrl,
        target.workerName,
        target.fleetId,
      ).pipe(
        Output.mapEffect(([revision, root, fleet, url, workerName, workerFleet]) =>
          !revision || !url || !root || !fleet
            ? Effect.die(
                new WorkerUnreachable({
                  message: "Celld.bindWorker requires an activated Application.",
                }),
              )
            : root !== workerName || fleet !== workerFleet
              ? Effect.die(
                  new WorkerUnreachable({
                    message:
                      "Celld.bindWorker can only target the Application's root Worker in the same fleet.",
                  }),
                )
              : Effect.succeed(revision),
        ),
      );
    }
    const FleetUrl = yield* app.fleetUrl;
    const Secret = yield* secret.text;

    if (!globalThis.__ALCHEMY_RUNTIME__) {
      const host = yield* Binding.Host;
      if (isNetworkHost(host)) {
        yield* host.bind`Allow(${host}, Celld.Worker.Call(${app}, ${target}))`({
          vpc: {
            subnetIds: app.hostState.pipe(
              Output.map((state: { subnetIds?: string[] } | undefined) => state?.subnetIds ?? []),
            ),
            securityGroupIds: app.hostState.pipe(
              Output.map(
                (state: { securityGroupIds?: string[] } | undefined) =>
                  state?.securityGroupIds ?? [],
              ),
            ),
          },
        });
      }
    }

    const client = yield* HttpClient.HttpClient;

    // Never replay ambiguous failures: the gateway may have applied a mutation.
    const transport = (
      request: HttpClientRequest.HttpClientRequest,
    ): Effect.Effect<HttpClientResponse.HttpClientResponse, RpcCallError | WorkerUnreachable> =>
      Effect.gen(function* () {
        const [url, secret] = yield* Effect.all([FleetUrl, Secret]);
        if (url === undefined || secret === undefined) {
          return yield* Effect.fail(
            new WorkerUnreachable({
              message:
                `Celld worker '${target.LogicalId}' is not reachable from this ` +
                "host — the fleet connection is bound at deploy time and " +
                "only readable at runtime inside the deployed caller.",
            }),
          );
        }
        const requestUrl = new URL(request.url, "http://alchemy-rpc");
        const method = `${request.method} ${requestUrl.pathname}`;
        const response = yield* client
          .execute(
            request.pipe(
              HttpClientRequest.setUrl(`${url}${requestUrl.pathname}${requestUrl.search}`),
              HttpClientRequest.setHeader(FLEET_SECRET_HEADER, Redacted.value(secret)),
            ),
          )
          .pipe(Effect.mapError((cause) => new RpcCallError({ method, cause })));
        if (response.status >= 300) {
          const body = yield* response.text.pipe(Effect.orElseSucceed(() => ""));
          return yield* Effect.fail(
            new RpcCallError({
              method,
              cause: new Error(
                `worker gateway returned ${response.status}${body ? `: ${body.slice(0, 256)}` : ""}`,
              ),
              status: response.status,
            }),
          );
        }
        return response;
      });

    const durableObject = <S = any>(namespace: string): CelldDurableObjectNamespaceClient<S> => ({
      getByName: (name: string) => {
        const base = `/${encodeURIComponent(namespace)}/${encodeURIComponent(name)}`;
        return makeFetchRpcStub<ReturnType<CelldDurableObjectNamespaceClient<S>["getByName"]>>({
          fetch: transport,
          baseUrl: `http://alchemy-rpc${base}`,
          base: {
            // Plain HTTP pass-through to the instance's `fetch` handler.
            fetch: (request: HttpClientRequest.HttpClientRequest) => {
              const url = new URL(request.url, "http://alchemy-rpc");
              return transport(
                request.pipe(
                  HttpClientRequest.setUrl(`http://alchemy-rpc${base}${url.pathname}${url.search}`),
                ),
              );
            },
          },
        });
      },
    });

    return makeFetchRpcStub<Shape & CelldWorkerClient>({
      fetch: transport,
      base: {
        fetch: transport,
        durableObject,
        fleetUrl: FleetUrl,
        secret: Secret,
      } satisfies CelldWorkerClient,
    });
  }) as Effect.Effect<Shape & CelldWorkerClient>;
