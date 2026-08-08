/**
 * The **celld deployment target** for `Alchemy.Worker`.
 *
 * `Celld.Worker({ fleet, main })` is a Layer provided INSIDE the worker
 * impl's own provide chain — it resolves the {@link Fleet}'s connection
 * material, records the target on the worker's runtime context, and
 * supplies the celld-specific runtime behaviors (the authenticated RPC
 * gateway around `fetch`, the fetch-RPC local stub flavor).
 *
 * The matching **engine** (`Alchemy.WorkerEngine/celld`, registered by
 * `Celld.providers()`) owns the deployment lifecycle: bundle the impl
 * (celld's object-form entry), stage a wrangler project, run
 * `celld deploy` (a pure bucket write via the pinned CLI), and roll the
 * fleet's nodes so they load the new version.
 *
 * @section Deploying a Worker to a Fleet
 * @example
 * ```typescript
 * export class Api extends Alchemy.Worker<Api>()("Api") {}
 *
 * export default Api.make(
 *   Effect.gen(function* () {
 *     const counters = yield* Counter;
 *     return { fetch: ... };
 *   }).pipe(
 *     Effect.provide(
 *       CounterLive.pipe(
 *         Layer.provideMerge(Celld.Worker({ fleet: Cells, main: import.meta.url })),
 *       ),
 *     ),
 *   ),
 * );
 * ```
 */
import {
  Deployment,
  HostRef,
  type DeploymentService,
  type HostRefService,
} from "../Worker/Engine.ts";
import {
  resolveWorkerRef,
  workerConnectionKeys,
} from "../Worker/DurableObject.ts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schedule from "effect/Schedule";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import * as Redacted from "effect/Redacted";
import * as Artifacts from "../Artifacts.ts";
import * as Output from "../Output.ts";
import { packEnvValue, RuntimeContext } from "../RuntimeContext.ts";
import { Stack } from "../Stack.ts";
import { asEffect } from "../Util/types.ts";
import { fromCloudflareFetcher } from "../Cloudflare/Fetcher.ts";
import type { WorkerBuildOptions } from "../Cloudflare/Workers/Sources/Rolldown.ts";
import { WorkerBundle } from "../Cloudflare/Workers/Sources/Rolldown.ts";
import { makeFetchRpcStub } from "../Rpc.ts";
import {
  WorkerEngine,
  WorkerTarget,
  type WorkerBindingContract,
  type WorkerEngineService,
  type WorkerTargetService,
} from "../Worker/Engine.ts";
import type { GenericWorkerRuntimeContext } from "../Worker/RuntimeContext.ts";
import { DEFAULT_CELLD_VERSION, celldDeploy } from "./CelldCli.ts";
import type { Fleet } from "./Fleet.ts";
import { makeCelldVirtualEntry } from "./FleetEntry.ts";
import {
  FLEET_DEPLOYMENT_VAR,
  FLEET_SECRET_HEADER,
  FLEET_SECRET_VAR,
  makeGatewayFetch,
} from "./FleetGateway.ts";
import { findFleetHost } from "./FleetHost.ts";
import {
  computeFleetMigrations,
  renderWranglerJson,
  type CelldMigration,
  type FleetDurableObjectBinding,
} from "./Wrangler.ts";

export const CELLD_ENGINE = "celld";

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

/**
 * The celld target layer. Resolves the fleet's connection material at plan
 * (a no-op at runtime — the bundle re-executes this layer, where only the
 * runtime behaviors matter) and records the target on the worker's runtime
 * context.
 */
const makeTarget = (props?: CelldWorkerProps): Layer.Layer<WorkerTarget> =>
  Layer.effect(
    WorkerTarget,
    Effect.gen(function* () {
      // No props = CLIENT mode: the layer supplies only the runtime
      // behaviors (transport, stub flavors) so a caller can reach a celld
      // worker. With props it can additionally deploy one.
      let targetProps: Record<string, unknown> = {
        engine: CELLD_ENGINE,
        main: props?.main,
        celldVersion: props?.celldVersion,
        compatibilityDate: props?.compatibilityDate,
        compatibilityFlags: props?.compatibilityFlags,
        build: props?.build,
      };

      if (!globalThis.__ALCHEMY_RUNTIME__ && props !== undefined) {
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
        targetProps = {
          ...targetProps,
          fleet: fleetClass.LogicalId,
          hostKind: fleet.Props?.hostKind ?? fleet.hostKind,
          bucket: fleet.bucket,
          fleetUrl: fleet.fleetUrl,
          fleetSecret: fleet.fleetSecret,
          hostState: fleet.hostState,
        };
      }

      const target: WorkerTargetService = {
        kind: CELLD_ENGINE,
        props: targetProps,
        wrapServe: (handler) => makeGatewayFetch(handler),
        localDurableObject,
        remoteDurableObject,
      };

      // Record the target on the ambient worker runtime context so the
      // platform folds it into the persisted Props.
      const ctx = yield* Effect.serviceOption(RuntimeContext).pipe(
        Effect.map(Option.getOrUndefined),
      );
      if (ctx !== undefined) {
        (ctx as GenericWorkerRuntimeContext).target = target;
      }
      return target;
    }),
  );

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

interface CelldTargetProps {
  fleet?: string;
  main?: string;
  celldVersion?: string;
  compatibilityDate?: string;
  compatibilityFlags?: string[];
  build?: WorkerBuildOptions;
  hostKind?: string;
  bucket?: { uri: string; endpoint?: string; region?: string };
  fleetUrl?: string;
  fleetSecret?: Redacted.Redacted<string>;
  hostState?: Record<string, any>;
}

/**
 * The `celld` {@link WorkerEngine}: the deployment lifecycle for
 * `Alchemy.Worker`s targeted at a Celld fleet. Registered by
 * `Celld.providers()`.
 */
export const CelldWorkerEngine = (): Layer.Layer<WorkerEngineService> =>
  Layer.effect(
    WorkerEngine(CELLD_ENGINE),
    Effect.gen(function* () {
      const stack = yield* Stack;

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

      const buildBundle = (
        id: string,
        target: CelldTargetProps,
        exports: Record<string, any> | undefined,
        build: WorkerBuildOptions | undefined,
      ) =>
        Effect.gen(function* () {
          const bundler = yield* WorkerBundle;
          return yield* bundler.build({
            id,
            main: target.main!,
            compatibility: {
              date: target.compatibilityDate ?? DEFAULT_COMPATIBILITY_DATE,
              flags: target.compatibilityFlags ?? DEFAULT_COMPATIBILITY_FLAGS,
            },
            entry: {
              kind: "effect",
              exports: exports ?? {},
              makeVirtualEntry: makeCelldVirtualEntry,
            },
            stack: { name: stack.name, stage: stack.stage },
            extraOptions: build,
          });
        }).pipe(Artifacts.cached("build"));

      const workerName = (id: string) =>
        `${stack.name}-${stack.stage}-${id}`.toLowerCase();

      return {
        kind: "Alchemy.WorkerEngine" as const,

        diff: ({ id, news, output }) =>
          Effect.gen(function* () {
            const target: CelldTargetProps | undefined = news?.target?.props;
            if (output === undefined || typeof target?.main !== "string") {
              return undefined;
            }
            const bundle = yield* buildBundle(
              id,
              target,
              news?.exports,
              target.build,
            );
            if (bundle.hash !== output.code?.hash) {
              return { action: "update" as const };
            }
            return undefined;
          }),

        reconcile: Effect.fn(function* ({
          id,
          news,
          output,
          bindings,
          session,
        }) {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const target: CelldTargetProps = news.target?.props ?? {};

          if (target.main === undefined) {
            return yield* Effect.die(
              new Error(
                `Alchemy.Worker '${id}' (celld) requires a 'main' entry module on its target.`,
              ),
            );
          }
          if (
            target.bucket === undefined ||
            target.fleetUrl === undefined ||
            target.fleetSecret === undefined ||
            target.hostKind === undefined
          ) {
            return yield* Effect.die(
              new Error(
                `Alchemy.Worker '${id}' (celld) has no fleet connection — ` +
                  "declare the fleet on the target: Celld.Worker({ fleet, main }).",
              ),
            );
          }

          const host = yield* findFleetHost(target.hostKind);
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
          const bundle = yield* buildBundle(
            id,
            target,
            news.exports,
            target.build,
          );
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
          vars[FLEET_SECRET_VAR] = Redacted.value(target.fleetSecret);
          vars[FLEET_DEPLOYMENT_VAR] = deploymentId;
          yield* fs.writeFileString(
            path.join(staged, "wrangler.json"),
            renderWranglerJson({
              name: workerName(id),
              main: bundle.files[0].path,
              compatibilityDate:
                target.compatibilityDate ?? DEFAULT_COMPATIBILITY_DATE,
              compatibilityFlags:
                target.compatibilityFlags ?? DEFAULT_COMPATIBILITY_FLAGS,
              durableObjects,
              migrations,
              vars,
            }),
          );

          // Deploy — a pure bucket write via the pinned celld CLI, with
          // standard-chain credentials resolved by the fleet host.
          yield* session.note("celld deploy");
          const deployEnv = yield* host.deployEnv({ news: target });
          const { versionId } = yield* celldDeploy({
            projectDir: staged,
            bucket: target.bucket.uri,
            endpoint: target.bucket.endpoint,
            region: target.bucket.region,
            env: deployEnv,
            version: target.celldVersion ?? DEFAULT_CELLD_VERSION,
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
            yield* host.restartNodes({ news: target });
          }

          return {
            workerName: workerName(id),
            url: target.fleetUrl,
            fleetUrl: target.fleetUrl,
            fleetSecret: target.fleetSecret,
            bucket: target.bucket,
            hostKind: target.hostKind,
            hostState: target.hostState,
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

        callerBinding: ({ worker, host, urlKey, secretKey }) =>
          Effect.gen(function* () {
            const adapter = yield* findFleetHost(
              worker.Props?.target?.props?.hostKind,
            );
            // Engine-specific attributes live under the worker's `engine`
            // bag — hand the adapter an Output view of what it needs.
            const engineAttrs = worker.engine;
            const fragment = yield* adapter.callerBinding({
              target: {
                hostState: Output.map(
                  engineAttrs,
                  (attrs: any) => attrs?.hostState,
                ),
              },
              host,
            });
            return {
              ...fragment,
              env: {
                ...(fragment as { env?: Record<string, unknown> }).env,
                [urlKey]: Output.map(
                  engineAttrs,
                  (attrs: any) => attrs?.fleetUrl,
                ),
                [secretKey]: Output.map(
                  engineAttrs,
                  (attrs: any) => attrs?.fleetSecret,
                ),
              },
            };
          }),
      } satisfies WorkerEngineService;
    }),
  ) as Layer.Layer<WorkerEngineService>;

export type { WorkerBindingContract };

/**
 * The Celld **deploy module** form plus its `.ref` companion — the same
 * shape every engine exposes, so switching clouds is one line.
 *
 * ```ts
 * export const ApiWorker = Celld.Worker(Api, { ... }, ApiLive);
 * export const WebWorker = Celld.Worker(Web, { ... },
 *   WebLive.pipe(Layer.provide(Celld.Worker.ref(Api))));
 * ```
 *
 * The worker class is passed explicitly because `Layer.provide` returns a
 * fresh layer, so an annotation on the layer would not survive a binder's
 * `.pipe(...)`. It mirrors the resource form's leading `id: string`; here
 * the id is the tag.
 */
const deployWorker = <Self, WOut, RIn>(
  cls: Effect.Effect<WOut, never, any>,
  props: CelldWorkerProps,
  layer: Layer.Layer<Self, never, RIn | WorkerTarget | HostRef>,
): Layer.Layer<
  Self | DeploymentService<WOut, "celld">,
  never,
  Exclude<RIn, WorkerTarget | HostRef>
> => {
  const clsId = resolveWorkerRef(cls as any).LogicalId;
  const selfRef = Layer.sync(HostRef, () => ({
    kind: CELLD_ENGINE,
    workerId: clsId,
    // Never read on the hosting path (dispatch compares ids and hosts);
    // present so foreign-DO layers piped with their own ref are unaffected.
    worker: undefined,
    ...workerConnectionKeys(clsId),
    remoteDurableObject,
  }));
  const deployed = layer.pipe(
    Layer.provide(Layer.mergeAll(makeTarget(props), selfRef)),
  );
  const deployment = Layer.effect(
    Deployment<WOut, "celld">(CELLD_ENGINE, clsId),
    Effect.gen(function* () {
      const worker = yield* cls as unknown as Effect.Effect<WOut, never, never>;
      return { kind: CELLD_ENGINE as "celld", worker };
    }),
  );
  return deployment.pipe(Layer.provideMerge(deployed)) as Layer.Layer<
    Self | DeploymentService<WOut, "celld">,
    never,
    Exclude<RIn, WorkerTarget | HostRef>
  >;
};

/**
 * Assert — and prove — that `cls` is deployed to Celld, yielding the
 * platform-agnostic {@link HostRef} a binder requires. Only the Celld
 * deploy module for this worker can discharge the `Deployment`
 * requirement, so a binder pointed at a worker hosted elsewhere fails to
 * compile.
 */
const workerRef = <WOut>(
  cls: Effect.Effect<WOut, never, any>,
): Layer.Layer<HostRef, never, DeploymentService<WOut, "celld">> =>
  Layer.effect(
    HostRef,
    Effect.gen(function* () {
      const clsId = resolveWorkerRef(cls as any).LogicalId;
      const { urlKey, secretKey } = workerConnectionKeys(clsId);
      const base = {
        kind: CELLD_ENGINE,
        workerId: clsId,
        urlKey,
        secretKey,
        remoteDurableObject,
      };
      // Inside the deployed caller the layer stack re-executes, but the
      // stack-scoped Deployment proof is a plan-time construct — the
      // connection material arrives via the bound env instead.
      if (globalThis.__ALCHEMY_RUNTIME__) {
        return { ...base, worker: undefined };
      }
      const deployment = yield* Deployment<WOut, "celld">(CELLD_ENGINE, clsId);
      return { ...base, worker: deployment.worker };
    }),
  );

export const Worker = Object.assign(deployWorker, { ref: workerRef });
