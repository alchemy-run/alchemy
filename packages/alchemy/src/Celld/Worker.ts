import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Redacted from "effect/Redacted";
import * as Schedule from "effect/Schedule";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import type * as HttpClientResponse from "effect/unstable/http/HttpClientResponse";
import * as Artifacts from "../Artifacts.ts";
import * as Binding from "../Binding.ts";
import type { WorkerBuildOptions } from "../Cloudflare/Workers/Sources/Rolldown.ts";
import { WorkerBundle } from "../Cloudflare/Workers/Sources/Rolldown.ts";
import type {
  WorkerServices,
  WorkerShape,
} from "../Cloudflare/Workers/Worker.ts";
import type { WorkerRuntimeContext } from "../Cloudflare/Workers/WorkerRuntimeContext.ts";
import { makeWorkerRuntimeContext } from "../Cloudflare/Workers/WorkerRuntimeContext.ts";
import { isResolved } from "../Diff.ts";
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
import { DEFAULT_CELLD_VERSION, celldDeploy } from "./CelldCli.ts";
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
  renderWranglerJson,
  type CelldMigration,
  type FleetDurableObjectBinding,
} from "./Wrangler.ts";

export const CelldWorkerTypeId = "Celld.Worker";
export type CelldWorkerTypeId = typeof CelldWorkerTypeId;

/** A reference to the {@link Fleet} a worker deploys onto: the Fleet class. */
export type FleetRef = Effect.Effect<Fleet, never, any>;

/** The public props of a `Celld.Worker`. */
export interface CelldWorkerProps {
  /** The {@link Fleet} this worker deploys onto. */
  fleet: FleetRef;
  /** Entry module of the worker bundle, usually `import.meta.url`. */
  main: string;
  /**
   * Expose the worker beyond the fleet's private network through
   * host-composed public ingress (an internet-facing ALB on `Celld.Ecs()`).
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
   * The celld release the managed deploy CLI is pinned to.
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
  /** The celld release the managed deploy CLI is pinned to. */
  celldVersion?: string;
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
  /** The celld version id written by `celld deploy`. */
  versionId: string | undefined;
  /** The persisted Durable Object class map (migration baseline). */
  durableObjectClasses: Record<string, string>;
  migrations: CelldMigration[];
  code: { hash: string };
}

export interface CelldWorker extends Resource<
  CelldWorkerTypeId,
  CelldWorkerResourceProps,
  CelldWorkerAttributes,
  CelldWorkerBindingContract,
  Providers
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

/** A `bindWorker` stub was called outside the deployed caller it was bound into. */
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
      isExternal: props.isExternal,
    };
    if (globalThis.__ALCHEMY_RUNTIME__ || props.fleet === undefined) {
      return base;
    }
    // Yielding the fleet class references the stack's fleet node (memoized
    // by logical id) and orders it ahead of the worker in the graph; the
    // connection material rides its attribute Outputs.
    const fleet = yield* props.fleet;
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
      fleetId: fleet.LogicalId,
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
 * A **Celld worker**: user code deployed onto a {@link Fleet}, authored
 * against the same native surface a Cloudflare Worker uses — the same
 * props-and-impl constructor forms, the same `Cloudflare.DurableObject`
 * hosting, the same Effect worker artifact. The fleet serves it behind the
 * gateway in `Celld/WorkerBridge.ts` (Durable Object routing, the guarded
 * RPC surface `bindWorker` stubs call, the readiness probe).
 *
 * The resource owns the deployment lifecycle: bundle the impl (celld's
 * object-form entry), stage a wrangler project, run `celld deploy` (a pure
 * bucket write via the pinned CLI), and roll the fleet's nodes so they
 * load the new version.
 *
 * ### Deploying a Worker to a Fleet
 * **Example:** Inline worker hosting a Durable Object
 * ```typescript
 * import * as Alchemy from "alchemy";
 * import * as AWS from "alchemy/AWS";
 * import * as Celld from "alchemy/Celld";
 * import * as Cloudflare from "alchemy/Cloudflare";
 * import * as Effect from "effect/Effect";
 * import * as Layer from "effect/Layer";
 * import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
 *
 * export class Cells extends Celld.Fleet<Cells>()("Cells") {}
 *
 * export class Counter extends Cloudflare.DurableObject<Counter>()(
 *   "Counter",
 *   Effect.gen(function* () {
 *     const state = yield* Cloudflare.DurableObjectState;
 *     return Effect.gen(function* () ({
 *       increment: () =>
 *         Effect.gen(function* () {
 *           const next = ((yield* state.storage.get<number>("count")) ?? 0) + 1;
 *           yield* state.storage.put("count", next);
 *           return next;
 *         }),
 *     }));
 *   }),
 * ) {}
 *
 * export default class Api extends Celld.Worker<Api>()(
 *   "Api",
 *   { fleet: Cells, main: import.meta.url },
 *   Effect.gen(function* () {
 *     const counters = yield* Counter;
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const value = yield* counters.getByName("lobby").increment();
 *         return yield* HttpServerResponse.json({ value });
 *       }),
 *     };
 *   }),
 * ) {}
 *
 * const stack = Alchemy.Stack("app", {
 *   providers: Layer.mergeAll(AWS.providers(), Celld.providers(), Celld.Ecs()),
 *   state: AWS.state(),
 * });
 * ```
 *
 * **Example:** Tag + deploy module (acyclic multi-file form)
 * ```typescript
 * // worker.ts — the shared tag
 * export class Api extends Celld.Worker<Api>()("Api") {}
 *
 * // main.ts — the deploy module
 * export default Api.make(
 *   { fleet: Cells, main: import.meta.url },
 *   Effect.gen(function* () {
 *     const counters = yield* Counter;
 *     return { fetch: serveCounters(counters) };
 *   }).pipe(Effect.provide(CounterLive)),
 * );
 * ```
 *
 * ### Exposing a Worker
 * **Example:** Public HTTPS on a custom domain, DNS on Cloudflare
 * ```typescript
 * export default Api.make(
 *   {
 *     fleet: Cells,
 *     main: import.meta.url,
 *     expose: "public",
 *     domain: "api.example.com",
 *   },
 *   Effect.gen(function* () {
 *     const counters = yield* Counter;
 *     return { fetch: serveCounters(counters) };
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
 *     const api = yield* Celld.bindWorker(Api);
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
  const durableObjects = new Map<string, FleetDurableObjectBinding>();
  const env: Record<string, unknown> = {};
  for (const binding of bindings) {
    for (const declaration of binding.data?.durableObjects ?? []) {
      durableObjects.set(declaration.name, declaration);
    }
    Object.assign(env, binding.data?.env ?? {});
  }
  return { durableObjects: [...durableObjects.values()], env };
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
      entry: {
        kind: "effect",
        exports: news.exports ?? {},
        makeVirtualEntry: makeCelldVirtualEntry,
      },
      stack: { name: stack.name, stage: stack.stage },
      extraOptions: news.build,
    });
  }).pipe(Artifacts.cached("build"));

const workerName = (stack: { name: string; stage: string }, id: string) =>
  `${stack.name}-${stack.stage}-${id}`.toLowerCase();

/**
 * The `Celld.Worker` provider: the deployment lifecycle for workers
 * targeted at a celld fleet. Registered by `Celld.providers()`.
 */
export const CelldWorkerProvider = () =>
  Provider.succeed(Worker, {
    read: ({ output }) => Effect.succeed(output),

    // The Props don't capture the code itself, so the default
    // prop-comparison misses pure code edits — compare the bundle hash
    // against the persisted one. Everything else is prop-visible and
    // handled by the default update logic. The fleet's connection
    // material is stable across its updates, so `news` resolves fully
    // whenever the fleet itself is not being replaced.
    diff: Effect.fn(function* ({ id, news, output }) {
      if (output === undefined || !isResolved(news)) {
        return;
      }
      const bundle = yield* buildBundle(id, news);
      if (bundle.hash !== output.code.hash) {
        return { action: "update" } as const;
      }
    }),

    reconcile: Effect.fn(function* ({ id, news, output, session, bindings }) {
      const stack = yield* Stack;
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;

      if (
        news.bucket === undefined ||
        news.fleetUrl === undefined ||
        news.fleetSecret === undefined
      ) {
        return yield* Effect.fail(
          new WorkerNotConnected({
            message:
              `Celld.Worker '${id}' has no fleet connection — ` +
              "declare the fleet on the worker's props: " +
              "Celld.Worker(id, { fleet, main }, impl).",
          }),
        );
      }
      const bucket = news.bucket;
      const fleetSecret = news.fleetSecret;

      const host = yield* requireHost(news.fleetId ?? id);
      const { durableObjects, env: bindingEnv } = collectBindings(bindings);

      // Migration delta against the persisted class map — typed
      // fail-before-deploy on conflicts.
      const { migrations, classes } = yield* computeFleetMigrations({
        history: output?.migrations,
        oldClasses: output?.durableObjectClasses,
        current: durableObjects,
      });

      yield* session.note("bundling worker");
      const bundle = yield* buildBundle(id, news);
      const deploymentId = bundle.hash.slice(0, 16);

      const vars: Record<string, string> = {};
      for (const [key, value] of Object.entries({
        ...news.env,
        ...bindingEnv,
      })) {
        if (value !== undefined) {
          vars[key] = renderVar(value);
        }
      }
      vars[FLEET_SECRET_VAR] = Redacted.value(fleetSecret);
      vars[FLEET_DEPLOYMENT_VAR] = deploymentId;

      // Stage the wrangler project (it carries the gateway secret) in a
      // scoped temp directory, removed on success AND failure.
      const { versionId } = yield* Effect.scoped(
        Effect.gen(function* () {
          const staged = yield* fs.makeTempDirectoryScoped({
            prefix: "alchemy-celld-",
          });
          for (const file of bundle.files) {
            const filePath = path.join(staged, file.path);
            yield* fs.makeDirectory(path.dirname(filePath), {
              recursive: true,
            });
            if (typeof file.content === "string") {
              yield* fs.writeFileString(filePath, file.content);
            } else {
              yield* fs.writeFile(filePath, file.content);
            }
          }
          yield* fs.writeFileString(
            path.join(staged, "wrangler.json"),
            renderWranglerJson({
              name: workerName(stack, id),
              main: bundle.files[0].path,
              compatibilityDate:
                news.compatibilityDate ?? DEFAULT_COMPATIBILITY_DATE,
              compatibilityFlags:
                news.compatibilityFlags ?? DEFAULT_COMPATIBILITY_FLAGS,
              durableObjects,
              migrations,
              vars,
            }),
          );

          // Deploy — a pure bucket write via the pinned celld CLI, with
          // standard-chain credentials resolved by the fleet host.
          yield* session.note("celld deploy");
          const deployEnv = yield* host.deployEnv({ news });
          return yield* celldDeploy({
            projectDir: staged,
            bucket: bucket.uri,
            endpoint: bucket.endpoint,
            region: bucket.region,
            env: deployEnv,
            version: news.celldVersion ?? DEFAULT_CELLD_VERSION,
          });
        }),
      );

      // celld nodes load a deployment at startup — roll them when the
      // deployed content changed. On the FIRST deploy the nodes' own
      // supervision loop picks the deployment up (they retry until one
      // exists), so no roll is needed.
      if (output !== undefined && output.deploymentId !== deploymentId) {
        yield* session.note("restarting fleet nodes");
        yield* host.restartNodes({ news });
      }

      return {
        workerName: workerName(stack, id),
        url: news.ingressUrl ?? news.fleetUrl,
        fleetUrl: news.fleetUrl,
        hostState: news.hostState,
        deploymentId,
        versionId,
        durableObjectClasses: classes,
        migrations,
        code: { hash: bundle.hash },
      };
    }),

    // The deployment object lives in the fleet's bucket, which the fleet
    // host tears down with the rest of its children.
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
 * At plan, yielding the worker references the stack's worker node (ordering
 * it and its fleet ahead of the caller), the fleet URL and the per-worker
 * gateway secret — the SAME root-anchored `Random` node the worker deploy
 * mints into its vars — are stamped into the caller's environment, and the
 * fleet network attachment is registered on the host. At runtime inside the
 * deployed caller the stub reads them back and speaks alchemy's fetch-RPC
 * against the worker's gateway with the secret header set.
 *
 * ### Calling cells from a Lambda
 * **Example:** Typed Durable Object RPC over the fleet gateway
 * ```typescript
 * export default class Backend extends AWS.Lambda.Function<Backend>()(
 *   "Backend",
 *   { main: import.meta.url },
 *   Effect.gen(function* () {
 *     const api = yield* Celld.bindWorker(Api);
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
  worker:
    | Effect.Effect<CelldWorker & Rpc<Shape>, never, any>
    | Effect.Effect<any, never, any>,
): Effect.Effect<Shape & CelldWorkerClient> =>
  Effect.gen(function* () {
    // Yielding the worker class references the stack's worker node at plan
    // (ordering it and its fleet ahead of this host) and resolves the
    // attribute accessors at runtime — pure data flow, no host registry.
    const target = (yield* worker) as CelldWorker;
    const secret = yield* mintGatewaySecret(target.LogicalId);
    // `yield* output` stamps the value into the host's environment at plan
    // and reads it back at runtime. The INTERNAL fleet URL on purpose: a
    // bound caller reaches the fleet over its network even when the worker
    // is also exposed through public ingress.
    const FleetUrl = yield* target.fleetUrl;
    const Secret = yield* secret.text;

    if (!globalThis.__ALCHEMY_RUNTIME__) {
      const host = yield* Binding.Host;
      if (isNetworkHost(host)) {
        yield* host.bind`Allow(${host}, Celld.Worker.Call(${target}))`({
          vpc: {
            subnetIds: target.hostState.pipe(
              Output.map(
                (state: { subnetIds?: string[] } | undefined) =>
                  state?.subnetIds ?? [],
              ),
            ),
            securityGroupIds: target.hostState.pipe(
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

    /**
     * The authenticated gateway transport: graft the stub request's path +
     * query onto the fleet URL and set the gateway secret header. The RPC
     * protocol answers 200 with an envelope, so any other status is
     * infrastructure, never a value — a typed `RpcCallError` carrying the
     * status, retried (bounded) while the gateway was not reached.
     */
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
      }).pipe(
        Effect.retry({
          while: (error): boolean =>
            error._tag === "RpcCallError" &&
            (error.status === undefined ||
              error.status === 429 ||
              error.status >= 500),
          schedule: Schedule.exponential("500 millis"),
          times: 5,
        }),
      );

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
            fetch: (request: HttpClientRequest.HttpClientRequest) =>
              transport(
                request.pipe(
                  HttpClientRequest.setUrl(
                    `http://alchemy-rpc${base}${new URL(request.url, "http://alchemy-rpc").pathname}`,
                  ),
                ),
              ),
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
