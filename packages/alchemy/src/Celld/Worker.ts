/**
 * The **celld deployment** of the portable `Alchemy.Worker`.
 *
 * `Celld.Worker(cls, { fleet, main }, implOrDefinition)` is the deploy
 * module: it constructs the NATIVE {@link CelldWorker} resource from the
 * cloud-free impl and emits the `Deployment` proof, while
 * `Celld.Worker.ref(cls)` lets callers bind to the worker — consuming
 * that proof and yielding the platform-agnostic `HostRef`.
 *
 * The `Celld.Worker` resource owns the deployment lifecycle: bundle the
 * impl (celld's object-form entry), stage a wrangler project, run
 * `celld deploy` (a pure bucket write via the pinned CLI), and roll the
 * fleet's nodes so they load the new version.
 *
 * @section Deploying a Worker to a Fleet
 * @example
 * ```typescript
 * export class Api extends Alchemy.Worker<Api>()("Api") {}
 *
 * export default Celld.Worker(
 *   Api,
 *   { fleet: Cells, main: import.meta.url },
 *   Effect.gen(function* () {
 *     const counters = yield* Counter;
 *     return { fetch: ... };
 *   }).pipe(Effect.provide(CounterLive)),
 * );
 * ```
 */
import type { DeploymentService, HostRef } from "../Worker/Engine.ts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schedule from "effect/Schedule";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import * as Redacted from "effect/Redacted";
import * as Artifacts from "../Artifacts.ts";
import { Platform } from "../Platform.ts";
import * as Provider from "../Provider.ts";
import type { Resource, ResourceBinding } from "../Resource.ts";
import { Stack } from "../Stack.ts";
import { asEffect } from "../Util/types.ts";
import { fromCloudflareFetcher } from "../Cloudflare/Fetcher.ts";
import type { WorkerBuildOptions } from "../Cloudflare/Workers/Sources/Rolldown.ts";
import { WorkerBundle } from "../Cloudflare/Workers/Sources/Rolldown.ts";
import { makeWorkerRuntimeContext } from "../Cloudflare/Workers/WorkerRuntimeContext.ts";
import { makeFetchRpcStub } from "../Rpc.ts";
import {
  makeWorkerDeploy,
  type WorkerDeployAdapter,
} from "../Worker/Deploy.ts";
import type {
  HostRefService,
  WorkerBindingContract,
} from "../Worker/Engine.ts";
import { DEFAULT_CELLD_VERSION, celldDeploy } from "./CelldCli.ts";
import type { Fleet } from "./Fleet.ts";
import { makeCelldVirtualEntry } from "./FleetEntry.ts";
import {
  FLEET_DEPLOYMENT_VAR,
  FLEET_SECRET_HEADER,
  FLEET_SECRET_VAR,
  makeGatewayFetch,
} from "./FleetGateway.ts";
import { findFleetHost, type FleetBucket } from "./FleetHost.ts";
import {
  computeFleetMigrations,
  renderWranglerJson,
  type CelldMigration,
  type FleetDurableObjectBinding,
} from "./Wrangler.ts";
import { packEnvValue } from "../RuntimeContext.ts";

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

/** The public deploy-wrapper props. */
export interface CelldWorkerProps {
  /** The {@link Fleet} this worker deploys onto. */
  fleet: FleetRef;
  /** Entry module of the worker bundle, usually `import.meta.url`. */
  main: string;
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
 * The persisted Props of the native `Celld.Worker` resource: the deploy
 * config plus the fleet connection material resolved by the deploy
 * wrapper (attribute Outputs of the Fleet — resolved to plain values by
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
  fleet?: string;
  /** The fleet host kind (keys the FleetHost lookup). */
  hostKind?: string;
  /** The fleet's deployment bucket. */
  bucket?: FleetBucket;
  /** The fleet's public URL. */
  fleetUrl?: string;
  /** The fleet's gateway secret. */
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
  WorkerBindingContract
> {}

/**
 * The native `Celld.Worker` platform resource. Constructed by the deploy
 * wrapper (`Celld.Worker(cls, props, impl)`) — the platform machinery
 * evaluates the impl (exports, Durable Object registrations) exactly like
 * a Cloudflare Worker; the provider below owns the celld deployment
 * lifecycle.
 */
export const CelldWorkerResource = Platform(CelldWorkerTypeId, {
  // A fleet deploys the same Effect worker artifact Cloudflare Workers do,
  // so the serve/export/env machinery is shared — only the resource Type
  // stamp and the Durable Object flavors differ (the context is
  // Object.assigned onto the instance, where the DO hosting core reads
  // the two engine variation points).
  createRuntimeContext: (id: string) => ({
    ...makeWorkerRuntimeContext(id),
    Type: CelldWorkerTypeId as any,
    // Celld's worker binding contract carries plain DO declarations, not
    // Cloudflare's `bindings` array.
    durableObjectBinding: (decl: { name: string; className: string }) => ({
      durableObjects: [{ name: decl.name, className: decl.className }],
    }),
    // Celld namespace stubs speak fetch, not workerd JSRPC (celld's JSRPC
    // dispatch stalls on Proxy-returning constructors).
    durableObjectStub: (nativeStub: unknown) => localDurableObject(nativeStub),
  }),
});

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
  bindings: { data?: WorkerBindingContract; action?: string }[],
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
          bindings: ResourceBinding<WorkerBindingContract>[];
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
                  "declare the fleet on the deploy wrapper: " +
                  "Celld.Worker(cls, { fleet, main }, impl).",
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
            url: news.fleetUrl,
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

/**
 * The celld REMOTE transport: alchemy's fetch-RPC against the worker's
 * gateway — `POST {url}/{namespace}/{instance}/__rpc__/{method}` with the
 * fleet secret header. Bounded retry over transport errors and
 * not-reached gateway statuses (502/503/504); a 500 is NOT retried (the
 * request may have reached the cell) but still fails the call, since the
 * RPC protocol answers 200 with an envelope and any other status is
 * infrastructure, never a value.
 */
const remoteDurableObject = ({
  url,
  secret,
  namespace,
}: {
  url: string;
  secret: string;
  namespace: string;
}) => ({
  getByName: (name: string) =>
    makeFetchRpcStub<any>({
      fetch: (request) =>
        Effect.gen(function* () {
          const client = yield* HttpClient.HttpClient;
          // The stub builds requests against its dummy default base —
          // graft the RPC path onto the worker's gateway URL.
          const rpcPath = new URL(request.url, "http://alchemy-rpc").pathname;
          return yield* client
            .execute(
              request.pipe(
                HttpClientRequest.setUrl(
                  `${url}/${encodeURIComponent(namespace)}/${encodeURIComponent(name)}${rpcPath}`,
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
        }) as any,
      base: {
        fetch: () =>
          Effect.die(
            new Error(
              "HTTP fetch pass-through on a remote stub is not supported yet — call RPC methods, or send requests to the worker URL directly",
            ),
          ),
      },
    }),
});

const callerBinding =
  (): HostRefService["callerBinding"] =>
  ({ worker, host, urlKey, secretKey }) =>
    Effect.gen(function* () {
      const adapter = yield* findFleetHost(worker.Props?.hostKind);
      const fragment = yield* adapter.callerBinding({
        target: { hostState: worker.hostState },
        host,
      });
      return {
        ...fragment,
        env: {
          ...(fragment as { env?: Record<string, unknown> }).env,
          [urlKey]: worker.fleetUrl,
          [secretKey]: worker.fleetSecret,
        },
      };
    });

const adapter: WorkerDeployAdapter<"celld"> = {
  kind: CELLD_ENGINE,
  wrapServe: (handler) => makeGatewayFetch(handler),
  remoteDurableObject,
  callerBinding,
  makeNative: (clsId, props: CelldWorkerProps, impl) => {
    const nativeCls = (CelldWorkerResource as any)(clsId);
    // Input-shaped props (fleet attributes are Outputs, resolved to plain
    // values by reconcile) — typed loosely for the platform's InputProps.
    const nativeProps = Effect.gen(function* () {
      const base: Record<string, unknown> = {
        main: props.main,
        celldVersion: props.celldVersion,
        compatibilityDate: props.compatibilityDate,
        compatibilityFlags: props.compatibilityFlags,
        build: props.build,
      };
      // At runtime the deploy module re-executes inside the bundle, where
      // only the runtime behaviors matter — never touch the fleet node.
      if (globalThis.__ALCHEMY_RUNTIME__) {
        return base;
      }
      // Resolve the fleet and copy its connection material. Yielding the
      // fleet class references the stack's fleet node (memoized by
      // logical id) and orders it ahead of the worker in the graph. The
      // host KIND must be plan-readable (it keys the FleetHost lookup),
      // so it comes from the fleet's resolved Props, not the attribute
      // Output.
      const fleetClass = resolveFleetRef(props.fleet);
      const fleet = (yield* asEffect(fleetClass as any)) as Fleet & {
        Props?: { hostKind?: string };
      };
      return {
        ...base,
        fleet: fleetClass.LogicalId,
        hostKind: fleet.Props?.hostKind ?? fleet.hostKind,
        bucket: fleet.bucket,
        fleetUrl: fleet.fleetUrl,
        fleetSecret: fleet.fleetSecret,
        hostState: fleet.hostState,
      };
    });
    return {
      layer: nativeCls.make(nativeProps, impl),
      instance: nativeCls.Self,
    };
  },
};

const { deployWorker, workerRef } = makeWorkerDeploy(adapter);

export type { WorkerBindingContract };

/**
 * The Celld **deploy module** form plus its `.ref` companion — the same
 * shape every deploy target exposes, so switching clouds is one line.
 *
 * ```ts
 * export const ApiWorker = Celld.Worker(Api, { ... }, ApiLive);
 * export const WebWorker = Celld.Worker(Web, { ... },
 *   WebLive.pipe(Layer.provide(Celld.Worker.ref(Api))));
 * ```
 *
 * The worker class is passed explicitly because it names the deployment
 * (the class's logical id is the native resource's id). It mirrors the
 * resource form's leading `id: string`; here the id is the tag.
 */
export const Worker: {
  /** Deploy a worker definition (shared-module form). */
  <Self, WOut, RIn>(
    cls: Effect.Effect<WOut, never, any>,
    props: CelldWorkerProps,
    layer: Layer.Layer<Self, never, RIn | HostRef>,
  ): Layer.Layer<
    Self | DeploymentService<WOut, "celld">,
    never,
    Exclude<RIn, HostRef>
  >;
  /** Deploy an impl effect directly (single-module form). */
  <WOut, Self, I extends Effect.Effect<any, any, any>>(
    cls: Effect.Effect<WOut, never, any> & {
      make: (impl: I) => Layer.Layer<Self, never, any>;
    },
    props: CelldWorkerProps,
    impl: I,
  ): Layer.Layer<
    Self | DeploymentService<WOut, "celld">,
    never,
    Extract<Effect.Services<I>, DeploymentService<any, string>>
  >;
  readonly ref: <WOut>(
    cls: Effect.Effect<WOut, never, any>,
  ) => Layer.Layer<HostRef, never, DeploymentService<WOut, "celld">>;
} = Object.assign(deployWorker as any, { ref: workerRef });
