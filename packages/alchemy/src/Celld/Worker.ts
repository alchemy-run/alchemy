import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Redacted from "effect/Redacted";
import type { Application } from "./Application.ts";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import type * as HttpClientResponse from "effect/unstable/http/HttpClientResponse";
import * as Artifacts from "../Artifacts.ts";
import * as Binding from "../Binding.ts";
import type { WorkerBuildOptions } from "../Cloudflare/Workers/Sources/Rolldown.ts";
import { WorkerBundle } from "../Cloudflare/Workers/Sources/Rolldown.ts";
import type { Request } from "../Cloudflare/Workers/Request.ts";
import type { WorkerExecutionContext } from "../Cloudflare/Workers/WorkerRuntime.ts";
import type { Main, MainRpc } from "../Platform.ts";
import type { Self } from "../Self.ts";
import type { WorkerEnvironment } from "../Workers/Worker.ts";
import type { WorkerRuntimeContext } from "../Cloudflare/Workers/WorkerRuntimeContext.ts";
import { makeWorkerRuntimeContext } from "../Cloudflare/Workers/WorkerRuntimeContext.ts";
import { deepEqual, isResolved, stripEffects } from "../Diff.ts";
import type { DnsRecordProps, DnsService } from "../Dns.ts";
import { safeHttpEffect, type HttpEffect } from "../Http.ts";
import type { Input, InputProps } from "../Input.ts";
import { Namespace, push as pushNamespace } from "../Namespace.ts";
import * as Output from "../Output.ts";
import { Platform } from "../Platform.ts";
import * as Provider from "../Provider.ts";
import { Random } from "../Random.ts";
import type { Resource, ResourceBinding, ResourceLike } from "../Resource.ts";
import { RpcCallError, makeFetchRpcStub, serveRpc, type Rpc } from "../Rpc.ts";
import { packEnvValue } from "../RuntimeContext.ts";
import { Stack } from "../Stack.ts";
import { isDurableObjectHost } from "../Workers/DurableObject.ts";
import { DEFAULT_CELLD_VERSION } from "./RuntimeVersion.ts";
import { CurrentFleet } from "./FleetContext.ts";
import { FleetStorage } from "./FleetStorage.ts";
import { DockerLive } from "../Docker/Docker.ts";
import {
  assertContainerUpdateSafe,
  prepareContainerImages,
  validateContainerHost,
  type PreparedContainer,
} from "./Containers/Images.ts";
import {
  prepareDeployment,
  stageAssetBlobs,
  stageContainerArtifacts,
  stageDeployment,
  DeploymentError,
} from "./Deployment.ts";
import { readAssets } from "./Assets.ts";
import { workerBuildOptions } from "./Build.ts";
import { lowerEnvironment } from "./Environment.ts";
import { digest, encode } from "./Deployment/Objects.ts";
import {
  deploymentMetadata,
  type CelldAssetsConfig,
  type CelldBinding,
  type CelldContainerConfig,
  type CelldQueueConsumer,
} from "./DeploymentConfig.ts";
import {
  validateStorageBindings,
  type StorageBinding,
} from "./KV/StorageBinding.ts";
import { createPhysicalName } from "../PhysicalName.ts";
import { durableObjectBinding, durableObjectStub } from "./DurableObject.ts";
import { requireHost, type Fleet } from "./Fleet.ts";
import { makeCelldVirtualEntry } from "./FleetEntry.ts";
import type { FleetBucket } from "./Host.ts";
import type { Providers } from "./Providers.ts";
import {
  FLEET_DEPLOYMENT_VAR,
  FLEET_SECRET_HEADER,
  FLEET_SECRET_VAR,
} from "./WorkerBridge.ts";
import {
  computeFleetMigrations,
  type CelldMigration,
  type FleetDurableObjectBinding,
} from "./Wrangler.ts";

type WorkerServices =
  | CelldWorker
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
   * Expose the worker beyond the fleet's private network through
   * host-composed public ingress (an internet-facing ALB on `Celld.EcsFleet()`).
   * The worker's `url` attribute becomes the ingress URL. Implied by
   * {@link domain}.
   * @default undefined — no ingress; the worker stays private to the fleet network
   */
  expose?: "public";
  /**
   * Custom domain for the exposed worker. Composes a DNS-validated TLS
   * certificate on the ingress and declares the domain CNAME + validation
   * records through the `Alchemy.Dns` seam — provide a DNS layer on the
   * worker's impl (`Effect.provide(AWS.Route53Dns())` or
   * `Effect.provide(Cloudflare.CloudflareDns())`). Implies `expose: "public"`.
   */
  domain?: string;
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
 * The ingress material the props transform hands the registration's
 * post-impl step: the DNS records for a `domain` are declared through the
 * `Alchemy.Dns` seam, which the impl's provide chain contributes.
 */
interface IngressMaterial {
  readonly domain: string | undefined;
  readonly dnsName: Input<string>;
  readonly validationRecords: readonly DnsRecordProps[];
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
  /** Requested ingress exposure (see {@link CelldWorkerProps.expose}). */
  expose?: "public";
  /** Custom domain for the exposed worker. */
  domain?: string;
  /** URL of the host-composed ingress, when the worker is exposed. */
  ingressUrl?: string;
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
  /** The worker's reachable URL: the ingress URL when exposed, else the fleet URL. */
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
  /** Requested public exposure; only the Application entrypoint may be exposed. */
  exposed: boolean;
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
export class WorkerNotConnected extends Data.TaggedError(
  "Celld.WorkerNotConnected",
)<{ readonly message: string }> {}

/** `expose`/`domain` on a worker declared without an impl. */
export class IngressRequiresImpl extends Data.TaggedError(
  "Celld.IngressRequiresImpl",
)<{ readonly message: string }> {}

/** A `domain` was requested but no `Alchemy.Dns` layer reached the worker's impl. */
export class DnsNotProvided extends Data.TaggedError("Celld.DnsNotProvided")<{
  readonly message: string;
}> {}

/** A binding lacks an activated root Application or a deployed caller connection. */
export class WorkerUnreachable extends Data.TaggedError(
  "Celld.WorkerUnreachable",
)<{ readonly message: string }> {}

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
 * gateway secret, and compose ingress when the worker is exposed. A no-op
 * at runtime — inside a deployed bundle only the runtime behaviors
 * matter, and the fleet node must never be touched.
 */
const transformWorkerProps = (
  id: string,
  props: CelldWorkerProps & { isExternal?: boolean },
): Effect.Effect<
  InputProps<CelldWorkerResourceProps> & { ingress?: IngressMaterial },
  IngressRequiresImpl,
  any
> =>
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

    // Public ingress when the worker asks to be exposed (or names a domain,
    // which implies it). The DNS records are declared later, once the
    // impl's provide chain contributed the Dns seam — see `foldProps`.
    let ingress: IngressMaterial | undefined;
    let ingressUrl: Input<string> | undefined;
    if (props.expose !== undefined || props.domain !== undefined) {
      if (props.isExternal) {
        return yield* Effect.fail(
          new IngressRequiresImpl({
            message:
              `Celld.Worker '${id}' sets expose/domain without an impl — ` +
              "ingress (and its DNS wiring) requires the impl form.",
          }),
        );
      }
      const host = yield* requireHost(fleet.LogicalId);
      const composed = yield* host
        .ingress({ id, fleet, domain: props.domain })
        .pipe(pushNamespace(id));
      ingressUrl = composed.url;
      ingress = {
        domain: props.domain,
        dnsName: composed.dnsName,
        validationRecords: composed.validationRecords,
      };
    }

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
      expose:
        props.expose ?? (props.domain !== undefined ? "public" : undefined),
      domain: props.domain,
      ingressUrl,
      ingress,
    };
  });

/**
 * Declare the exposed worker's DNS records (domain → ingress, certificate
 * validation) through the `Alchemy.Dns` seam captured from the impl's
 * provide chain. Runs as the registration's post-impl step — a no-op at
 * runtime and for workers without a domain.
 */
const declareIngressDns = (
  id: string,
  dns: DnsService | undefined,
  ingress: IngressMaterial | undefined,
): Effect.Effect<void, DnsNotProvided, any> =>
  Effect.gen(function* () {
    if (
      globalThis.__ALCHEMY_RUNTIME__ ||
      ingress === undefined ||
      ingress.domain === undefined
    ) {
      return;
    }
    if (dns === undefined) {
      return yield* Effect.fail(
        new DnsNotProvided({
          message:
            `Celld.Worker '${id}' declares domain '${ingress.domain}' but no ` +
            "DNS layer was provided — provide one on the worker's impl, " +
            "e.g. Effect.provide(AWS.Route53Dns()) or " +
            "Effect.provide(Cloudflare.CloudflareDns()).",
        }),
      );
    }
    yield* dns.record(`${id}-Domain`, {
      name: ingress.domain,
      type: "CNAME",
      values: [ingress.dnsName],
    });
    for (const [index, record] of ingress.validationRecords.entries()) {
      yield* dns.record(`${id}-DomainCertValidation${index}`, record);
    }
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
 * import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
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
 * ### Exposing a Worker
 * **Example:** Public HTTPS on a custom domain, DNS on Cloudflare
 * ```typescript
 * import * as Cloudflare from "alchemy/Cloudflare";
 *
 * export default Api.make(
 *   {
 *     main: import.meta.url,
 *     expose: "public",
 *     domain: "api.example.com",
 *   },
 *   Effect.gen(function* () {
 *     const counters = yield* Counter;
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const value = yield* counters.getByName("lobby").increment();
 *         return yield* HttpServerResponse.json({ value });
 *       }),
 *     };
 *   }).pipe(Effect.provide(Layer.mergeAll(CounterLive, Cloudflare.CloudflareDns()))),
 * );
 * // api.url === "https://api.example.com"
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
    const base = makeWorkerRuntimeContext(id);
    // Ingress material carried from the props transform (via `foldProps`)
    // to the post-impl DNS declaration below — per-instance state on this
    // context, never a module-level registry.
    let ingress: IngressMaterial | undefined;
    const ctx = {
      ...base,
      Type: CelldWorkerTypeId,
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
        base.serve(
          serveRpc(options?.shape ?? {}, safeHttpEffect(handler)),
          options,
        ),
      durableObjectBinding,
      durableObjectStub,
      foldProps: (props: Record<string, unknown>) => {
        const { ingress: pending, ...persisted } = props;
        ingress = pending as IngressMaterial | undefined;
        return persisted;
      },
    };
    // The registration's post-impl step: declare the exposed worker's DNS
    // records through the Dns seam the impl's provide chain captured onto
    // this context. `exports` is typed infallible; the one failure here is
    // the plan-time configuration error `DnsNotProvided`.
    ctx.exports = Effect.suspend(() =>
      declareIngressDns(id, ctx.dns, ingress),
    ).pipe(Effect.flatMap(() => base.exports)) as Effect.Effect<
      Record<string, any>
    >;
    return ctx;
  },
}) as CelldWorkerClass;

const DEFAULT_COMPATIBILITY_DATE = "2025-06-01";
const DEFAULT_COMPATIBILITY_FLAGS = ["nodejs_compat"];

/** Render a wrangler `vars` value: strings verbatim, everything else packed
 * so the runtime `get` accessor round-trips it (Redacted markers included). */
const renderVar = (value: unknown): string =>
  typeof value === "string"
    ? value
    : Redacted.isRedacted(value)
      ? Redacted.value(value as Redacted.Redacted<any>)
      : packEnvValue(value);

const collectBindings = (
  bindings: readonly ResourceBinding<CelldWorkerBindingContract>[],
) => {
  const durableObjects: FleetDurableObjectBinding[] = [];
  const env: Record<string, unknown> = {};
  const nativeBindings: CelldBinding[] = [];
  const storageBindings: StorageBinding[] = [];
  const queueConsumers: CelldQueueConsumer[] = [];
  const crons: string[] = [];
  const containers: CelldContainerConfig[] = [];
  for (const binding of bindings) {
    durableObjects.push(...(binding.data?.durableObjects ?? []));
    nativeBindings.push(...(binding.data?.bindings ?? []));
    storageBindings.push(...(binding.data?.storageBindings ?? []));
    queueConsumers.push(...(binding.data?.queueConsumers ?? []));
    crons.push(...(binding.data?.crons ?? []));
    containers.push(...(binding.data?.containers ?? []));
    Object.assign(env, binding.data?.env ?? {});
  }
  const unique = <T>(values: T[]) =>
    values.filter(
      (value, index) =>
        !values.slice(0, index).some((previous) => deepEqual(previous, value)),
    );
  return {
    durableObjects: unique(durableObjects),
    env,
    nativeBindings: unique(nativeBindings),
    storageBindings: unique(storageBindings),
    queueConsumers,
    crons: [...new Set(crons)],
    containers: unique(containers),
  };
};

const buildBundle = (id: string, news: CelldWorkerResourceProps) =>
  Effect.gen(function* () {
    const stack = yield* Stack;
    const bundler = yield* WorkerBundle;
    return yield* bundler.build({
      id,
      main: news.main,
      compatibility: {
        date: news.compatibilityDate ?? DEFAULT_COMPATIBILITY_DATE,
        flags: news.compatibilityFlags ?? DEFAULT_COMPATIBILITY_FLAGS,
      },
      entry: news.isExternal
        ? { kind: "external" }
        : {
            kind: "effect",
            exports: news.exports ?? {},
            makeVirtualEntry: makeCelldVirtualEntry,
          },
      stack: { name: stack.name, stage: stack.stage },
      extraOptions: yield* workerBuildOptions(news.build),
    });
  }).pipe(Artifacts.cached("build"));

/**
 * The `Celld.Worker` provider: the deployment lifecycle for workers
 * targeted at a celld fleet. Registered by `Celld.providers()`.
 */
export const CelldWorkerProvider = () =>
  Provider.succeed(Worker, {
    read: ({ output }) => Effect.succeed(output),

    // Source changes are not prop-visible; compare the bundle and asset hashes.
    diff: Effect.fn(function* ({ id, news: desired, output, newBindings }) {
      if (output === undefined) {
        return;
      }
      // Image tags, Dockerfile contexts, and generated programs can change outside Worker props.
      if (
        output.preparedContainers?.length ||
        (isResolved(newBindings) &&
          collectBindings(newBindings).containers.length)
      ) {
        return { action: "update" } as const;
      }
      // Export constructors are runtime Effects, not unresolved deployment inputs.
      // Keep their class metadata for the virtual entry, as persisted props do.
      const news = stripEffects(desired);
      if (!isResolved(news)) return;
      const bundle = yield* buildBundle(id, news);
      const assets = news.assets
        ? yield* readAssets(news.main, news.assets, {
            date: news.compatibilityDate ?? DEFAULT_COMPATIBILITY_DATE,
            flags: news.compatibilityFlags ?? DEFAULT_COMPATIBILITY_FLAGS,
          })
        : undefined;
      const assetsHash = assets
        ? yield* digest(yield* encode(assets.index))
        : undefined;
      if (
        bundle.hash !== output.code.hash ||
        assetsHash !== output.code.assetsHash
      ) {
        return { action: "update" } as const;
      }
    }),

    reconcile: Effect.fn(function* ({ id, news, output, session, bindings }) {
      if (
        !news.bucket ||
        !news.fleetUrl ||
        !news.fleetSecret ||
        !news.fleetId
      ) {
        return yield* Effect.fail(
          new WorkerNotConnected({
            message: `Celld.Worker '${id}' requires Celld.Fleet.layer(Cells) on its implementation layer.`,
          }),
        );
      }
      if ((news.celldVersion ?? DEFAULT_CELLD_VERSION) !== "0.5.0") {
        return yield* Effect.fail(
          new DeploymentError({
            reason: "unsupported",
            message:
              "API deployment supports Celld 0.5.0 only; runtime upgrades require an explicit maintenance operation.",
          }),
        );
      }
      const collected = collectBindings(bindings);
      yield* validateStorageBindings(news, [
        ...(news.storageBindings ?? []),
        ...collected.storageBindings,
      ]);
      const { migrations, classes } = yield* computeFleetMigrations({
        history: output?.migrations,
        oldClasses: output?.durableObjectClasses,
        current: collected.durableObjects,
      });
      yield* session.note("bundling worker");
      const bundle = yield* buildBundle(id, news);
      const deploymentId = bundle.hash.slice(0, 16);
      const scriptName =
        output?.workerName ??
        (yield* createPhysicalName({ id, maxLength: 63, lowercase: true }));
      const vars: Record<string, string> = {};
      for (const [key, value] of Object.entries({
        ...news.env,
        ...collected.env,
      })) {
        if (value !== undefined) vars[key] = renderVar(value);
      }
      vars[FLEET_SECRET_VAR] = Redacted.value(news.fleetSecret);
      vars[FLEET_DEPLOYMENT_VAR] = deploymentId;
      const compatibility = {
        date: news.compatibilityDate ?? DEFAULT_COMPATIBILITY_DATE,
        flags: news.compatibilityFlags ?? DEFAULT_COMPATIBILITY_FLAGS,
      };
      const native = yield* deploymentMetadata({
        scriptName,
        mainModule: bundle.files[0].path,
        compatibilityDate: compatibility.date,
        compatibilityFlags: compatibility.flags,
        bindings: [...(news.bindings ?? []), ...collected.nativeBindings],
        durableObjects: collected.durableObjects,
        vars,
        queueConsumers: collected.queueConsumers,
        assets: news.assets,
      });
      const containerHost = yield* validateContainerHost({
        declarations: collected.containers,
        doClasses: native.doClasses,
        sqliteClasses: native.sqliteClasses,
        hostState: news.hostState,
      });
      const platform = containerHost.platform;
      const containerImages =
        platform === undefined
          ? { containers: [], images: [], fenceImage: undefined }
          : yield* Effect.gen(function* () {
              const fs = yield* FileSystem.FileSystem;
              const archiveDirectory = yield* fs.makeTempDirectoryScoped({
                prefix: "alchemy-celld-images-",
              });
              return yield* prepareContainerImages({
                declarations: containerHost.declarations,
                platform,
                archiveDirectory,
              }).pipe(Effect.provide(DockerLive));
            });
      yield* assertContainerUpdateSafe(
        output?.preparedContainers ?? [],
        containerImages.containers,
      );
      const localContainerArtifacts = yield* Effect.forEach(
        containerImages.images,
        (image) =>
          Effect.gen(function* () {
            const fs = yield* FileSystem.FileSystem;
            const body = yield* fs.readFile(image.path);
            return {
              image: image.image,
              key: image.key,
              sha256: yield* digest(body),
              bytes: body.length,
              body,
            };
          }),
      );
      const assets = news.assets
        ? yield* readAssets(news.main, news.assets, compatibility)
        : undefined;
      const assetsHash = assets
        ? yield* digest(yield* encode(assets.index))
        : undefined;
      const storage = yield* FleetStorage;
      const store = yield* storage(news);
      yield* session.note("staging immutable worker deployment");
      const containerArtifacts = yield* stageContainerArtifacts(
        store,
        localContainerArtifacts,
      );
      const prepared = yield* prepareDeployment({
        scriptName,
        mainModule: bundle.files[0].path,
        modules: bundle.files.map((file) => ({
          name: file.path,
          content: file.content,
        })),
        ...native,
        crons: collected.crons,
        assets,
        containers: containerImages.containers,
        fenceImage: containerImages.fenceImage,
        containerArtifacts,
      });
      yield* stageAssetBlobs(store, prepared);
      yield* stageDeployment(store, prepared);
      return {
        workerName: scriptName,
        url: news.ingressUrl ?? news.fleetUrl,
        fleetUrl: news.fleetUrl,
        hostState: news.hostState,
        deploymentId,
        versionId: prepared.version,
        fleetId: news.fleetId,
        prefix: prepared.prefix,
        stagedManifestKey: prepared.candidate.key,
        exposed: news.expose === "public" || news.domain !== undefined,
        preparedContainers: containerImages.containers,
        durableObjectClasses: classes,
        migrations,
        code: { hash: bundle.hash, assetsHash },
      };
    }, Effect.scoped),

    // Retain immutable artifacts and data; Application owns live publication.
    delete: () => Effect.void,

    list: () => Effect.succeed([]),
  });

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
  durableObject: <Shape = any>(
    namespace: string,
  ) => CelldDurableObjectNamespaceClient<Shape>;
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
    const FleetUrl = yield* Output.all(
      app.revision,
      app.workerName,
      app.fleetId,
      app.fleetUrl,
      target.workerName,
      target.fleetId,
    ).pipe(
      Output.mapEffect(
        ([revision, root, fleet, url, workerName, workerFleet]) =>
          !revision || !url || !root || !fleet
            ? Effect.die(
                new WorkerUnreachable({
                  message:
                    "Celld.bindWorker requires an activated Application.",
                }),
              )
            : root !== workerName || fleet !== workerFleet
              ? Effect.die(
                  new WorkerUnreachable({
                    message:
                      "Celld.bindWorker can only target the Application's root Worker in the same fleet.",
                  }),
                )
              : Effect.succeed(url),
      ),
    );
    const Secret = yield* secret.text;

    if (!globalThis.__ALCHEMY_RUNTIME__) {
      const host = yield* Binding.Host;
      if (isNetworkHost(host)) {
        yield* host.bind`Allow(${host}, Celld.Worker.Call(${app}, ${target}))`({
          vpc: {
            subnetIds: app.hostState.pipe(
              Output.map(
                (state: { subnetIds?: string[] } | undefined) =>
                  state?.subnetIds ?? [],
              ),
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
    ): Effect.Effect<
      HttpClientResponse.HttpClientResponse,
      RpcCallError | WorkerUnreachable
    > =>
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
              HttpClientRequest.setUrl(
                `${url}${requestUrl.pathname}${requestUrl.search}`,
              ),
              HttpClientRequest.setHeader(
                FLEET_SECRET_HEADER,
                Redacted.value(secret),
              ),
            ),
          )
          .pipe(
            Effect.mapError((cause) => new RpcCallError({ method, cause })),
          );
        if (response.status >= 300) {
          const body = yield* response.text.pipe(
            Effect.orElseSucceed(() => ""),
          );
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

    const durableObject = <S = any>(
      namespace: string,
    ): CelldDurableObjectNamespaceClient<S> => ({
      getByName: (name: string) => {
        const base = `/${encodeURIComponent(namespace)}/${encodeURIComponent(name)}`;
        return makeFetchRpcStub<
          ReturnType<CelldDurableObjectNamespaceClient<S>["getByName"]>
        >({
          fetch: transport,
          baseUrl: `http://alchemy-rpc${base}`,
          base: {
            // Plain HTTP pass-through to the instance's `fetch` handler.
            fetch: (request: HttpClientRequest.HttpClientRequest) => {
              const url = new URL(request.url, "http://alchemy-rpc");
              return transport(
                request.pipe(
                  HttpClientRequest.setUrl(
                    `http://alchemy-rpc${base}${url.pathname}${url.search}`,
                  ),
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
