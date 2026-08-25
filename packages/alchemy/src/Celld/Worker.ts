/**
 * A **Celld worker**: user code deployed onto a {@link Fleet}, authored
 * against the same native surface a Cloudflare Worker uses — the same
 * props-and-impl constructor forms, the same `Cloudflare.DurableObject`
 * hosting, the same Effect worker artifact.
 *
 * The `Celld.Worker` resource owns the deployment lifecycle: bundle the
 * impl (celld's object-form entry), stage a wrangler project, run
 * `celld deploy` (a pure bucket write via the pinned CLI), and roll the
 * fleet's nodes so they load the new version.
 *
 * ### Deploying a Worker to a Fleet
 * **Example:** Inline worker
 * ```typescript
 * export class Cells extends Celld.Fleet<Cells>()("Cells") {}
 *
 * export default class Api extends Celld.Worker<Api>()(
 *   "Api",
 *   { fleet: Cells, main: import.meta.url },
 *   Effect.gen(function* () {
 *     const counters = yield* Counter;
 *     return { fetch: ... };
 *   }).pipe(Effect.provide(CounterLive)),
 * ) {}
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
 *   Effect.gen(function* () { ... }).pipe(Effect.provide(CounterLive)),
 * );
 * ```
 *
 * ### Calling a Worker from another host
 * **Example:** Secure schemaless RPC from a Lambda
 * ```typescript
 * const api = yield* Celld.bindWorker(Api);
 * const counter = api.durableObject<CounterShape>("Counter").getByName("a");
 * const value = yield* counter.increment();
 * ```
 */
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schedule from "effect/Schedule";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import type * as HttpClientResponse from "effect/unstable/http/HttpClientResponse";
import * as Redacted from "effect/Redacted";
import * as Artifacts from "../Artifacts.ts";
import * as Binding from "../Binding.ts";
import type { DnsService } from "../Dns.ts";
import type { Input, InputProps } from "../Input.ts";
import { Namespace, push as pushNamespace } from "../Namespace.ts";
import * as Output from "../Output.ts";
import { Platform } from "../Platform.ts";
import * as Provider from "../Provider.ts";
import { Random } from "../Random.ts";
import type { Resource, ResourceBinding } from "../Resource.ts";
import type { Rpc } from "../Rpc.ts";
import { makeFetchRpcStub } from "../Rpc.ts";
import { CurrentRuntimeContext, packEnvValue } from "../RuntimeContext.ts";
import { Stack } from "../Stack.ts";
import { asEffect } from "../Util/types.ts";
import {
  rawEnvValue,
  resolveWorkerRef,
  workerConnectionKeys,
  type WorkerRefLike,
} from "../WorkerConnection.ts";
import { fromCloudflareFetcher } from "../Cloudflare/Fetcher.ts";
import { isDurableObjectHost } from "../Cloudflare/Workers/DurableObject.ts";
import type { WorkerBuildOptions } from "../Cloudflare/Workers/Sources/Rolldown.ts";
import { WorkerBundle } from "../Cloudflare/Workers/Sources/Rolldown.ts";
import type {
  WorkerServices,
  WorkerShape,
} from "../Cloudflare/Workers/Worker.ts";
import type { WorkerRuntimeContext } from "../Cloudflare/Workers/WorkerRuntimeContext.ts";
import { makeWorkerRuntimeContext } from "../Cloudflare/Workers/WorkerRuntimeContext.ts";
import { DEFAULT_CELLD_VERSION, celldDeploy } from "./CelldCli.ts";
import type { Fleet } from "./Fleet.ts";
import { makeCelldVirtualEntry } from "./FleetEntry.ts";
import {
  FLEET_DEPLOYMENT_VAR,
  FLEET_SECRET_HEADER,
  FLEET_SECRET_VAR,
  makeGatewayFetch,
} from "./FleetGateway.ts";
import {
  findFleetHost,
  type FleetBucket,
  type FleetIngressResult,
} from "./FleetHost.ts";
import type { Providers } from "./Providers.ts";
import {
  computeFleetMigrations,
  renderWranglerJson,
  type CelldMigration,
  type FleetDurableObjectBinding,
} from "./Wrangler.ts";

export const CELLD_ENGINE = "celld";

export const CelldWorkerTypeId = "Celld.Worker";
export type CelldWorkerTypeId = typeof CelldWorkerTypeId;

/**
 * A reference to the {@link Fleet} class: the class itself, or a thunk for
 * forward references / import cycles.
 */
export type FleetRef =
  | Effect.Effect<any, any, any>
  | { readonly LogicalId: string }
  | (() => FleetRef);

const resolveFleetRef = (ref: FleetRef, depth = 0): { LogicalId: string } => {
  if (
    ref !== null &&
    typeof (ref as { LogicalId?: unknown }).LogicalId === "string"
  ) {
    return ref as unknown as { LogicalId: string };
  }
  if (typeof ref === "function" && depth < 8) {
    return resolveFleetRef((ref as () => FleetRef)(), depth + 1);
  }
  throw new Error(
    "Invalid fleet reference: pass the Fleet class (or a thunk of it).",
  );
};

/** The public props of a `Celld.Worker`. */
export interface CelldWorkerProps {
  /** The {@link Fleet} this worker deploys onto. */
  fleet: FleetRef;
  /** Entry module of the worker bundle, usually `import.meta.url`. */
  main: string;
  /**
   * Expose the worker beyond the fleet's private network through
   * host-composed ingress (an ALB on `aws-ecs`): `"public"` is
   * internet-facing; `"private"` composes internal ingress reachable only
   * from the fleet's network. When set (or when {@link domain} is set) the
   * worker's `url` attribute becomes the ingress URL.
   * @default undefined — no ingress; the worker stays private to the fleet network
   */
  expose?: "public" | "private";
  /**
   * Custom domain for the exposed worker. Composes a DNS-validated TLS
   * certificate on the ingress and declares the domain + validation DNS
   * records through the {@link ../Dns.ts Dns} seam — provide a DNS layer
   * on the worker's impl (`Effect.provide(AWS.Route53Dns())` or
   * `Effect.provide(Cloudflare.Dns())`). Implies `expose: "private"`
   * ingress when {@link expose} is unset.
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
  /** The fleet host kind (keys the FleetHost lookup). */
  hostKind?: string;
  /** The fleet's deployment bucket. */
  bucket?: FleetBucket;
  /** The fleet's public URL. */
  fleetUrl?: string;
  /** The per-worker gateway secret checked by the RPC guard. */
  fleetSecret?: Redacted.Redacted<string>;
  /** Host-specific connection state copied from the fleet. */
  hostState?: Record<string, any>;
  /** Requested ingress exposure (see {@link CelldWorkerProps.expose}). */
  expose?: "public" | "private";
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
  /** The worker's reachable URL (the fleet URL). */
  url: string | undefined;
  fleetUrl: string | undefined;
  fleetSecret: Redacted.Redacted<string> | undefined;
  bucket: FleetBucket | undefined;
  hostKind: string | undefined;
  hostState: Record<string, any> | undefined;
  /** The deployed content id (bundle-hash prefix). */
  deploymentId: string;
  /** The celld version id written by `celld deploy`. */
  versionId: string | undefined;
  /** The persisted Durable Object class map (migration baseline). */
  durableObjectClasses: string[];
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

/**
 * The id of the per-worker gateway-secret {@link Random} node. Anchored at
 * the ROOT namespace (the Namespace service is stripped when it is
 * yielded) so the worker's props transform and `bindWorker` — which run
 * under different ambient namespaces — always resolve the SAME node.
 */
const gatewaySecretId = (workerLogicalId: string) =>
  `${workerLogicalId}-GatewaySecret`;

const mintGatewaySecret = (workerLogicalId: string) =>
  Random(gatewaySecretId(workerLogicalId), { bytes: 32 }).pipe(
    Effect.updateContext(Context.omit(Namespace)),
  );

/**
 * Ingress material stashed by the props transform for the worker's
 * registration to consume AFTER the impl evaluated: the DNS records for a
 * `domain` are declared through the {@link Dns} seam, which the impl's
 * provide chain contributes (captured on the runtime context by the DNS
 * layer's build — see Dns.ts).
 */
const pendingIngressDns = new Map<
  string,
  { domain: string | undefined; ingress: FleetIngressResult }
>();

/**
 * Declare the exposed worker's DNS records (domain → ingress, certificate
 * validation) through the {@link Dns} seam captured from the impl's
 * provide chain. Runs as part of the registration's post-impl step (the
 * `exports` yield) — a no-op at runtime and for workers without a domain.
 */
const declareWorkerDnsRecords = (
  id: string,
  ctx: { dns?: DnsService },
): Effect.Effect<void, never, any> =>
  Effect.gen(function* () {
    if (globalThis.__ALCHEMY_RUNTIME__) {
      return;
    }
    const pending = pendingIngressDns.get(id);
    if (pending === undefined || pending.domain === undefined) {
      return;
    }
    const dns = ctx.dns;
    if (dns === undefined) {
      return yield* Effect.die(
        new Error(
          `Celld.Worker '${id}' declares domain '${pending.domain}' but no ` +
            "DNS layer was provided — provide one on the worker's impl, " +
            "e.g. Effect.provide(AWS.Route53Dns()) or " +
            "Effect.provide(Cloudflare.Dns()).",
        ),
      );
    }
    yield* dns.record(`${id}-Domain`, {
      name: pending.domain,
      type: "ALIAS",
      values: [pending.ingress.dnsName] as Input<string[]>,
    });
    if (pending.ingress.certificate !== undefined) {
      yield* dns.record(`${id}-DomainCertValidation`, {
        name: pending.ingress.certificate.validationRecordName,
        type: "CNAME",
        values: [pending.ingress.certificate.validationRecordValue] as Input<
          string[]
        >,
      });
    }
  });

/**
 * Resolve the public props into the persisted resource props: copy the
 * fleet's connection material off its attributes and mint the per-worker
 * gateway secret. A no-op at runtime — inside a deployed bundle only the
 * runtime behaviors matter, and the fleet node must never be touched.
 */
const transformWorkerProps = (
  id: string,
  props: CelldWorkerProps & { isExternal?: boolean },
): Effect.Effect<InputProps<CelldWorkerResourceProps>, unknown, any> =>
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
    // Resolve the fleet and copy its connection material. Yielding the
    // fleet class references the stack's fleet node (memoized by logical
    // id) and orders it ahead of the worker in the graph. The host KIND
    // must be plan-readable (it keys the FleetHost lookup), so it comes
    // from the fleet's resolved Props, not the attribute Output.
    const fleetClass = resolveFleetRef(props.fleet);
    const fleet = (yield* asEffect(fleetClass as any)) as Fleet & {
      Props?: { hostKind?: string };
    };
    // The gateway secret is per-WORKER: minted here into the deployed vars
    // and by `bindWorker` into each caller's env — the same root-anchored
    // Random node on both paths.
    const secret = yield* mintGatewaySecret(id);

    // Compose host ingress when the worker asks to be exposed (or names a
    // domain — which implies private ingress). The host kind must be
    // plan-readable, same as below.
    let ingressUrl: Input<string> | undefined;
    if (props.expose !== undefined || props.domain !== undefined) {
      if (props.isExternal) {
        return yield* Effect.die(
          new Error(
            `Celld.Worker '${id}' sets expose/domain without an impl — ` +
              "ingress (and its DNS wiring) requires the impl form.",
          ),
        );
      }
      const hostKind = fleet.Props?.hostKind;
      const host = yield* findFleetHost(
        typeof hostKind === "string" ? hostKind : undefined,
      );
      const ingress = yield* host
        .ingress({
          fleetId: fleetClass.LogicalId,
          expose: props.expose ?? "private",
          domain: props.domain,
        })
        .pipe(pushNamespace(id));
      ingressUrl = ingress.url;
      pendingIngressDns.set(id, { domain: props.domain, ingress });
    }

    return {
      ...base,
      fleetId: fleetClass.LogicalId,
      hostKind: fleet.Props?.hostKind ?? fleet.hostKind,
      bucket: fleet.bucket,
      fleetUrl: fleet.fleetUrl,
      fleetSecret: secret.text,
      hostState: fleet.hostState,
      expose: props.expose,
      domain: props.domain,
      ingressUrl,
    } satisfies InputProps<CelldWorkerResourceProps>;
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
 * The `Celld.Worker` platform resource. A fleet deploys the same Effect
 * worker artifact Cloudflare Workers do, so the serve/export/env machinery
 * is shared — only the resource Type stamp, the gateway wrap on the served
 * fetch handler, and the Durable Object flavors differ.
 */
export const Worker: CelldWorkerClass = Platform(CelldWorkerTypeId, {
  transformProps: transformWorkerProps,
  createRuntimeContext: (id: string) => {
    const base = makeWorkerRuntimeContext(id);
    const ctx = {
      ...base,
      Type: CelldWorkerTypeId as any,
      // Every fleet worker serves through the gateway: RPC-path auth guard,
      // Durable Object routing, worker-level RPC over the impl shape, user
      // fetch fall-through. Applied on BOTH plan and runtime evaluations —
      // the deploy module re-executes inside the bundle. `alwaysServe`
      // keeps the gateway (and its Durable Object routes) served for a
      // worker that hosts DOs but returns no fetch handler of its own.
      alwaysServe: true,
      serve: (handler: any, options?: { shape?: Record<string, unknown> }) =>
        base.serve(makeGatewayFetch(handler, options), options),
      // Celld's worker binding contract carries plain DO declarations, not
      // Cloudflare's `bindings` array.
      durableObjectBinding: (decl: { name: string; className: string }) => ({
        durableObjects: [{ name: decl.name, className: decl.className }],
      }),
      // Celld namespace stubs speak fetch, not workerd JSRPC (celld's JSRPC
      // dispatch stalls on Proxy-returning constructors).
      durableObjectStub: (nativeStub: unknown) =>
        localDurableObject(nativeStub),
    };
    // The registration's post-impl step: declare the exposed worker's DNS
    // records through the Dns seam the impl's provide chain captured onto
    // this context (see declareWorkerDnsRecords).
    ctx.exports = Effect.flatMap(
      declareWorkerDnsRecords(id, ctx),
      () => base.exports,
    ) as Effect.Effect<Record<string, any>>;
    return ctx;
  },
}) as CelldWorkerClass;

/** The provider-registration alias of {@link Worker}. @internal */
export const CelldWorkerResource = Worker;

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
  bindings: { data?: CelldWorkerBindingContract; action?: string }[],
) => {
  const active = (bindings ?? []).filter(
    (binding) => binding.action !== "delete",
  );
  const durableObjects = new Map<string, FleetDurableObjectBinding>();
  const env: Record<string, unknown> = {};
  for (const binding of active) {
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
  Provider.effect(
    CelldWorkerResource as any,
    Effect.gen(function* () {
      return {
        read: ({ output }: { output: Record<string, any> | undefined }) =>
          Effect.succeed(output),

        // The Props don't capture the code itself, so the default
        // prop-comparison misses pure code edits — compare the bundle hash
        // against the persisted one. Everything else is prop-visible and
        // handled by the default update logic.
        diff: ({
          id,
          news,
          output,
        }: {
          id: string;
          news: any;
          output: Record<string, any> | undefined;
        }) =>
          Effect.gen(function* () {
            if (output === undefined || typeof news?.main !== "string") {
              return undefined;
            }
            const bundle = yield* buildBundle(id, news);
            if (bundle.hash !== output.code?.hash) {
              return { action: "update" as const };
            }
            return undefined;
          }),

        reconcile: Effect.fn(function* ({
          id,
          news,
          output,
          session,
          bindings,
        }: {
          id: string;
          news: CelldWorkerResourceProps;
          olds: CelldWorkerResourceProps | undefined;
          output: Record<string, any> | undefined;
          session: { note: (message: string) => Effect.Effect<void> };
          bindings: ResourceBinding<CelldWorkerBindingContract>[];
        }) {
          const stack = yield* Stack;
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;

          if (news.main === undefined) {
            return yield* Effect.die(
              new Error(`Celld.Worker '${id}' requires a 'main' entry module.`),
            );
          }
          if (
            news.bucket === undefined ||
            news.fleetUrl === undefined ||
            news.fleetSecret === undefined ||
            news.hostKind === undefined
          ) {
            return yield* Effect.die(
              new Error(
                `Celld.Worker '${id}' has no fleet connection — ` +
                  "declare the fleet on the worker's props: " +
                  "Celld.Worker(id, { fleet, main }, impl).",
              ),
            );
          }

          const host = yield* findFleetHost(news.hostKind);
          const { durableObjects, env: bindingEnv } = collectBindings(
            bindings as any,
          );

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

          // Stage the wrangler project.
          const staged = yield* fs.makeTempDirectory({
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
          const vars: Record<string, string> = {};
          for (const [key, value] of Object.entries({
            ...news.env,
            ...bindingEnv,
          })) {
            if (value !== undefined) {
              vars[key] = renderVar(value);
            }
          }
          vars[FLEET_SECRET_VAR] = Redacted.value(news.fleetSecret);
          vars[FLEET_DEPLOYMENT_VAR] = deploymentId;
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
          const { versionId } = yield* celldDeploy({
            projectDir: staged,
            bucket: news.bucket.uri,
            endpoint: news.bucket.endpoint,
            region: news.bucket.region,
            env: deployEnv,
            version: news.celldVersion ?? DEFAULT_CELLD_VERSION,
          });
          yield* fs
            .remove(staged, { recursive: true })
            .pipe(Effect.catch(() => Effect.void));

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
            fleetSecret: news.fleetSecret,
            bucket: news.bucket,
            hostKind: news.hostKind,
            hostState: news.hostState,
            deploymentId,
            versionId,
            durableObjectClasses: classes,
            migrations: migrations as CelldMigration[],
            code: { hash: bundle.hash },
          };
        }),

        // The deployment object lives in the fleet's bucket, which the
        // fleet host tears down with the rest of its children.
        delete: () => Effect.void,

        list: () => Effect.succeed([]),
      };
    }),
  );

/** The celld local-stub flavor: alchemy fetch-RPC over the native binding. */
const localDurableObject = (nativeBinding: any) => {
  const fetcher = fromCloudflareFetcher(nativeBinding);
  return makeFetchRpcStub<any>({
    fetch: (request) => fetcher.fetch(request),
    base: { fetch: (request: unknown) => fetcher.fetch(request as any) },
  });
};

// ── bindWorker: secure schemaless RPC over the fleet gateway ───────────

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
}

/**
 * Bind a caller host (Lambda Function, ECS task, …) to a {@link Worker}
 * and return the typed schemaless RPC stub — the celld mirror of
 * `Cloudflare.Workers.bindWorker`.
 *
 * At plan, the init effect registers the caller binding on the ambient
 * host: the fleet network attachment (subnets + security groups from the
 * worker's host state) and the worker connection env (fleet URL + the
 * per-worker gateway secret — the SAME root-anchored `Random` node the
 * worker deploy mints into its `FLEET_SECRET_VAR`). At runtime inside the
 * deployed caller, the stub reads the bound connection back and speaks
 * alchemy's fetch-RPC against the worker's gateway with the secret header
 * set; calls outside a bound runtime die with guidance.
 */
export const bindWorker = <Shape = {}>(
  worker:
    | Effect.Effect<CelldWorker & Rpc<Shape>, never, any>
    | Effect.Effect<any, never, any>
    | WorkerRefLike,
): Effect.Effect<Shape & CelldWorkerClient> =>
  Effect.gen(function* () {
    const workerId = resolveWorkerRef(worker as WorkerRefLike).LogicalId;
    const { urlKey, secretKey } = workerConnectionKeys(workerId);

    if (!globalThis.__ALCHEMY_RUNTIME__) {
      const host = yield* Binding.Host;
      if (
        host !== undefined &&
        "bind" in (host as object) &&
        typeof (host as any).bind === "function" &&
        !isDurableObjectHost(host)
      ) {
        // Yielding the worker class references the stack's worker node and
        // orders it (and its fleet) ahead of this host in the graph. The
        // connection material rides the worker's attribute Outputs — pure
        // data flow, no host-registry lookup.
        const target = (yield* asEffect(worker as any)) as any;
        const secret = yield* mintGatewaySecret(workerId);
        yield* (host as any).bind`Allow(${host}, Celld.Worker.Call(${target}))`(
          {
            vpc: {
              subnetIds: target.hostState.pipe(
                Output.map((state: any) => state?.subnetIds ?? []),
              ),
              securityGroupIds: target.hostState.pipe(
                Output.map((state: any) => state?.securityGroupIds ?? []),
              ),
            },
            env: {
              // The INTERNAL fleet URL on purpose: a bound caller reaches
              // the fleet over the VPC even when the worker is also
              // exposed through public ingress (`url` then carries the
              // ingress URL instead).
              [urlKey]: target.fleetUrl,
              [secretKey]: secret.text,
            },
          },
        );
      }
    }

    // Read the bound connection once: empty at plan (nothing to call yet),
    // populated inside the deployed caller by the binding above.
    const ctx = yield* CurrentRuntimeContext;
    const url = ctx ? rawEnvValue(yield* ctx.get(urlKey)) : undefined;
    const secret = ctx ? rawEnvValue(yield* ctx.get(secretKey)) : undefined;

    /**
     * The authenticated gateway transport: graft the stub request's path +
     * query onto the fleet URL and set the gateway secret header. Bounded
     * retry over transport errors and not-reached gateway statuses
     * (502/503/504); a 500 is NOT retried (the request may have reached
     * the cell) but still fails the call, since the RPC protocol answers
     * 200 with an envelope and any other status is infrastructure, never a
     * value.
     */
    const transport = (
      request: HttpClientRequest.HttpClientRequest,
    ): Effect.Effect<HttpClientResponse.HttpClientResponse, unknown, any> =>
      Effect.gen(function* () {
        if (url === undefined || secret === undefined) {
          return yield* Effect.die(
            new Error(
              `Celld worker '${workerId}' is not reachable from this host — ` +
                `the worker connection env ('${urlKey}') is bound at deploy ` +
                "time and only readable at runtime inside the deployed caller.",
            ),
          );
        }
        const client = yield* HttpClient.HttpClient;
        // The stub builds requests against its dummy default base — graft
        // the path onto the worker's gateway URL.
        const requestUrl = new URL(request.url, "http://alchemy-rpc");
        return yield* client
          .execute(
            request.pipe(
              HttpClientRequest.setUrl(
                `${url}${requestUrl.pathname}${requestUrl.search}`,
              ),
              HttpClientRequest.setHeader(FLEET_SECRET_HEADER, secret),
            ),
          )
          .pipe(
            Effect.flatMap((response) =>
              response.status >= 300
                ? response.text.pipe(
                    Effect.orElseSucceed(() => ""),
                    Effect.flatMap((body) =>
                      Effect.fail(
                        Object.assign(
                          new Error(
                            `worker gateway returned ${response.status}${body ? `: ${body.slice(0, 256)}` : ""}`,
                          ),
                          { status: response.status },
                        ),
                      ),
                    ),
                  )
                : Effect.succeed(response),
            ),
            Effect.retry({
              while: (error): boolean =>
                !(
                  typeof error === "object" &&
                  error !== null &&
                  "status" in error
                ) ||
                (error as { status: number }).status === 502 ||
                (error as { status: number }).status === 503 ||
                (error as { status: number }).status === 504,
              schedule: Schedule.exponential("500 millis"),
              times: 5,
            }),
          );
      });

    const durableObject = <S = any>(
      namespace: string,
    ): CelldDurableObjectNamespaceClient<S> => ({
      getByName: (name: string) =>
        makeFetchRpcStub<any>({
          fetch: transport as any,
          baseUrl: `http://alchemy-rpc/${encodeURIComponent(namespace)}/${encodeURIComponent(name)}`,
          base: {
            // Plain HTTP pass-through to the instance's `fetch` handler.
            fetch: (request: HttpClientRequest.HttpClientRequest) =>
              transport(
                request.pipe(
                  HttpClientRequest.setUrl(
                    `http://alchemy-rpc/${encodeURIComponent(namespace)}/${encodeURIComponent(name)}${new URL(request.url, "http://alchemy-rpc").pathname}`,
                  ),
                ),
              ),
          },
        }),
    });

    return makeFetchRpcStub<Shape & CelldWorkerClient>({
      fetch: transport as any,
      base: {
        fetch: (request: HttpClientRequest.HttpClientRequest) =>
          transport(request),
        durableObject,
      },
    });
  }) as Effect.Effect<Shape & CelldWorkerClient>;
