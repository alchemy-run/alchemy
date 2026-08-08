/**
 * The **Rivet deployment target** for `Alchemy.Worker`.
 *
 * `Rivet.Worker({ cluster, main })` is a Layer provided INSIDE the worker
 * impl's own provide chain — it resolves the {@link Cluster}'s connection
 * material, records the target on the worker's runtime context, and
 * supplies the Rivet-specific runtime behaviors (the gateway-backed
 * Durable Object stub flavors).
 *
 * With NO props (`Rivet.Worker()`) the layer is **client-only**: it
 * supplies the transport a remote caller (Lambda, ECS task) needs to reach
 * a Rivet worker's Durable Objects, and records nothing — the caller's own
 * deployment target stays in charge.
 *
 * The matching **engine** (`Alchemy.WorkerEngine/rivet`, registered by
 * `Rivet.providers()`) owns the deployment lifecycle. Rivet inverts celld:
 * the user's actor code runs in their OWN long-running process (a
 * "runner") that connects OUT to the Rivet Engine — nothing is uploaded to
 * the engine. So reconcile builds the user's `main` (plus the generated
 * runner entry) into a container image and keeps it running via the
 * platform's {@link RunnerHost} (`aws-ecs` deploys an ECS service with no
 * inbound ports).
 *
 * @section Deploying a Worker to a Cluster
 * @example
 * ```typescript
 * export class Api extends Alchemy.Worker<Api>()("Api") {}
 *
 * export default Api.make(
 *   Effect.gen(function* () {
 *     yield* Counter;
 *     return {};
 *   }).pipe(
 *     Effect.provide(
 *       CounterLive.pipe(
 *         Layer.provideMerge(Rivet.Worker({ cluster: Actors, main: import.meta.url })),
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
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Output from "../Output.ts";
import { packEnvValue, RuntimeContext } from "../RuntimeContext.ts";
import { Stack } from "../Stack.ts";
import { asEffect } from "../Util/types.ts";
import {
  WorkerEngine,
  WorkerTarget,
  type WorkerBindingContract,
  type WorkerEngineService,
  type WorkerTargetService,
} from "../Worker/Engine.ts";
import type { GenericWorkerRuntimeContext } from "../Worker/RuntimeContext.ts";
import type { Cluster } from "./Cluster.ts";
import { findClusterHost } from "./ClusterHost.ts";
import {
  makeRivetActorClient,
  RIVET_ACTOR_NAMESPACE,
  RIVET_RUNNER_POOL,
  formatRivetEndpoint,
} from "./Gateway.ts";
import { makeRivetRunnerEntry } from "./RunnerEntry.ts";
import {
  findRunnerHost,
  type RunnerNames,
  type RunnerSource,
} from "./RunnerHost.ts";

export const RIVET_ENGINE = "rivet";

/**
 * A reference to the {@link Cluster} class: the class itself, or a thunk
 * for forward references / import cycles.
 */
export type ClusterRef =
  | Effect.Effect<any, any, any>
  | { readonly LogicalId: string }
  | (() => ClusterRef);

const resolveClusterRef = (
  ref: ClusterRef,
  depth = 0,
): { LogicalId: string } => {
  if (
    ref !== null &&
    typeof (ref as { LogicalId?: unknown }).LogicalId === "string"
  ) {
    return ref as unknown as { LogicalId: string };
  }
  if (typeof ref === "function" && depth < 8) {
    return resolveClusterRef((ref as () => ClusterRef)(), depth + 1);
  }
  throw new Error(
    "Invalid cluster reference: pass the Cluster class (or a thunk of it).",
  );
};

export interface RivetWorkerProps {
  /** The {@link Cluster} this worker's runner connects to. */
  cluster: ClusterRef;
  /** Entry module of the worker bundle, usually `import.meta.url`. */
  main: string;
  /**
   * Environment image the bundled runner is layered onto (must run bun).
   * @default "oven/bun:1"
   */
  image?: string;
  /**
   * The rivetkit release installed into the runner image.
   * @default DEFAULT_RIVETKIT_VERSION (see the aws-ecs runner host)
   */
  rivetkitVersion?: string;
  /** Runner task CPU units. @default 512 */
  cpu?: number;
  /** Runner task memory (MiB). @default 1024 */
  memory?: number;
  /** Number of runner instances. @default 1 */
  desiredCount?: number;
  /** Bundler configuration overrides (`Bundle.BundleConfig`). */
  build?: unknown;
}

/**
 * The in-runner stub flavor: the synthetic runner environment (see
 * `Runner.ts`) already maps each hosted class to a gateway-backed
 * namespace, so the "native binding" IS the finished stub.
 */
const localDurableObject = (nativeBinding: any) => nativeBinding;

/**
 * The remote-caller stub flavor: speak the Rivet gateway protocol against
 * the engine endpoint + token that the engine's `callerBinding` bound into
 * the caller's environment.
 */
const remoteDurableObject = ({
  url,
  secret,
  namespace,
}: {
  url: string;
  secret: string;
  namespace: string;
}) =>
  makeRivetActorClient(
    {
      endpoint: url,
      token: secret,
      namespace: RIVET_ACTOR_NAMESPACE,
      pool: RIVET_RUNNER_POOL,
    },
    namespace,
  );

/**
 * The Rivet target layer. With props, resolves the cluster's connection
 * material at plan (a no-op at runtime — the bundle re-executes this
 * layer, where only the runtime behaviors matter) and records the target
 * on the worker's runtime context. With NO props, client-only: supplies
 * the transport without recording a deployment.
 */
const makeTarget = (props?: RivetWorkerProps): Layer.Layer<WorkerTarget> =>
  Layer.effect(
    WorkerTarget,
    Effect.gen(function* () {
      let targetProps: Record<string, unknown> = {
        engine: RIVET_ENGINE,
        main: props?.main,
        image: props?.image,
        rivetkitVersion: props?.rivetkitVersion,
        cpu: props?.cpu,
        memory: props?.memory,
        desiredCount: props?.desiredCount,
        build: props?.build,
      };

      if (props !== undefined && !globalThis.__ALCHEMY_RUNTIME__) {
        // Resolve the cluster and copy its connection material. Yielding
        // the cluster class references the stack's cluster node (memoized
        // by logical id) and orders it ahead of the worker in the graph.
        // The host KIND must be plan-readable (it keys the RunnerHost
        // lookup), so it comes from the cluster's resolved Props, not the
        // attribute Output.
        const clusterClass = resolveClusterRef(props.cluster);
        const cluster = (yield* asEffect(clusterClass as any)) as Cluster & {
          Props?: { hostKind?: string };
        };
        targetProps = {
          ...targetProps,
          cluster: clusterClass.LogicalId,
          hostKind: cluster.Props?.hostKind ?? cluster.hostKind,
          endpoint: cluster.endpoint,
          adminToken: cluster.adminToken,
          hostState: cluster.hostState,
        };
      }

      const target: WorkerTargetService = {
        kind: RIVET_ENGINE,
        props: targetProps,
        localDurableObject,
        remoteDurableObject,
      };

      // Record the target on the ambient worker runtime context so the
      // platform folds it into the persisted Props — but ONLY for the
      // deployment form. The client-only form must not clobber the
      // caller's own target (e.g. a celld worker calling a Rivet DO).
      if (props !== undefined) {
        const ctx = yield* Effect.serviceOption(RuntimeContext).pipe(
          Effect.map(Option.getOrUndefined),
        );
        if (ctx !== undefined) {
          (ctx as GenericWorkerRuntimeContext).target = target;
        }
      }
      return target;
    }),
  );

/** Render a container env value: strings verbatim, everything else packed
 * so the runtime `get` accessor round-trips it (Redacted markers included). */
const renderVar = (value: unknown): string =>
  typeof value === "string"
    ? value
    : Redacted.isRedacted(value)
      ? Redacted.value(value as Redacted.Redacted<any>)
      : packEnvValue(value);

interface RivetTargetProps {
  cluster?: string;
  main?: string;
  image?: string;
  rivetkitVersion?: string;
  cpu?: number;
  memory?: number;
  desiredCount?: number;
  build?: unknown;
  hostKind?: string;
  endpoint?: string;
  adminToken?: Redacted.Redacted<string>;
  hostState?: Record<string, any>;
}

const truncateName = (name: string, maxLength: number) =>
  name.length <= maxLength ? name : name.slice(0, maxLength);

/**
 * The `rivet` {@link WorkerEngine}: the deployment lifecycle for
 * `Alchemy.Worker`s targeted at a Rivet cluster. Registered by
 * `Rivet.providers()`.
 */
export const RivetWorkerEngine = (): Layer.Layer<WorkerEngine<"rivet">> =>
  Layer.effect(
    WorkerEngine(RIVET_ENGINE),
    Effect.gen(function* () {
      const stack = yield* Stack;

      const workerName = (id: string) =>
        `${stack.name}-${stack.stage}-${id}`.toLowerCase();

      const runnerNames = (id: string): RunnerNames => {
        const base = `${workerName(id)}-runner`;
        return {
          serviceName: truncateName(base, 255),
          repositoryName: truncateName(base, 255),
          taskFamily: truncateName(base, 255),
          taskRoleName: truncateName(`${workerName(id)}-rnr-task`, 64),
          executionRoleName: truncateName(`${workerName(id)}-rnr-exec`, 64),
          logGroupName: `/ecs/${truncateName(base, 200)}`,
        };
      };

      const runnerSource = (target: RivetTargetProps): RunnerSource => ({
        main: target.main!,
        build: target.build,
        image: target.image,
        rivetkitVersion: target.rivetkitVersion,
        cpu: target.cpu,
        memory: target.memory,
        desiredCount: target.desiredCount,
      });

      const collectBindings = (
        bindings: { data?: WorkerBindingContract; action?: string }[],
      ) => {
        const active = (bindings ?? []).filter(
          (binding) => binding.action !== "delete",
        );
        const durableObjects = new Map<
          string,
          { name: string; className: string }
        >();
        const env: Record<string, unknown> = {};
        for (const binding of active) {
          for (const declaration of binding.data?.durableObjects ?? []) {
            durableObjects.set(declaration.name, declaration);
          }
          Object.assign(env, binding.data?.env ?? {});
        }
        return { durableObjects: [...durableObjects.values()], env };
      };

      return {
        kind: "Alchemy.WorkerEngine" as const,

        diff: ({ id: _id, news, output }) =>
          Effect.gen(function* () {
            const target: RivetTargetProps | undefined = news?.target?.props;
            if (output === undefined || typeof target?.main !== "string") {
              return undefined;
            }
            const host = yield* findRunnerHost(target.hostKind);
            const hash = yield* host.runnerCodeHash({
              source: runnerSource(target),
              bootstrap: makeRivetRunnerEntry(news?.exports ?? {}, {
                name: stack.name,
                stage: stack.stage,
              }),
            });
            if (hash !== undefined && hash !== output.code?.hash) {
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
          const target: RivetTargetProps = news.target?.props ?? {};

          if (target.main === undefined) {
            return yield* Effect.die(
              new Error(
                `Alchemy.Worker '${id}' (rivet) requires a 'main' entry module on its target.`,
              ),
            );
          }
          if (
            target.endpoint === undefined ||
            target.adminToken === undefined ||
            target.hostKind === undefined
          ) {
            return yield* Effect.die(
              new Error(
                `Alchemy.Worker '${id}' (rivet) has no cluster connection — ` +
                  "declare the cluster on the target: Rivet.Worker({ cluster, main }).",
              ),
            );
          }

          const host = yield* findRunnerHost(target.hostKind);
          const { env: bindingEnv } = collectBindings(bindings as any);

          // Rivet drains actors on lower versions once a higher one
          // registers — the version must strictly increase across deploys,
          // so it derives from the persisted attributes, not the content.
          const envoyVersion = ((output?.envoyVersion as number) ?? 0) + 1;

          const env: Record<string, string> = {};
          for (const [key, value] of Object.entries({
            ...news.env,
            ...bindingEnv,
          })) {
            if (value !== undefined) {
              env[key] = renderVar(value);
            }
          }
          Object.assign(env, {
            ALCHEMY_STACK_NAME: stack.name,
            ALCHEMY_STAGE: stack.stage,
            ALCHEMY_PHASE: "runtime",
            // URL-auth form (`http://{namespace}:{token}@host:port`) — note
            // rivetkit rejects RIVET_NAMESPACE alongside it, so the
            // namespace travels inside the endpoint.
            RIVET_ENDPOINT: formatRivetEndpoint({
              endpoint: target.endpoint,
              namespace: RIVET_ACTOR_NAMESPACE,
              token: Redacted.value(target.adminToken),
            }),
            RIVET_POOL: RIVET_RUNNER_POOL,
            RIVET_ENVOY_VERSION: String(envoyVersion),
          });

          yield* session.note("deploying rivet runner");
          const result = yield* host.deployRunner({
            id,
            names: runnerNames(id),
            source: runnerSource(target),
            env,
            bootstrap: makeRivetRunnerEntry(news.exports ?? {}, {
              name: stack.name,
              stage: stack.stage,
            }),
            connection: { hostState: target.hostState },
            tags: {
              "alchemy::stack": stack.name,
              "alchemy::stage": stack.stage,
              "alchemy::id": id,
            },
            output: output?.runner,
            session,
          });

          return {
            workerName: workerName(id),
            url: target.endpoint,
            endpoint: target.endpoint,
            adminToken: target.adminToken,
            hostKind: target.hostKind,
            hostState: target.hostState,
            envoyVersion,
            runner: result.runnerState,
            code: { hash: result.codeHash },
          };
        }),

        delete: Effect.fn(function* ({ olds, output }) {
          const kind: string | undefined =
            (output?.hostKind as string | undefined) ??
            olds?.target?.props?.hostKind;
          if (kind === undefined || output?.runner === undefined) {
            return;
          }
          const host = yield* findRunnerHost(kind);
          yield* host.deleteRunner({ output: output.runner });
        }),

        callerBinding: ({ worker, host, urlKey, secretKey }) =>
          Effect.gen(function* () {
            const adapter = yield* findClusterHost(
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
                  (attrs: any) => attrs?.endpoint,
                ),
                [secretKey]: Output.map(
                  engineAttrs,
                  (attrs: any) => attrs?.adminToken,
                ),
              },
            };
          }),
      } satisfies WorkerEngineService;
    }),
  ) as Layer.Layer<WorkerEngine<"rivet">>;

export type { WorkerBindingContract };

/**
 * The Rivet **deploy module** form plus its `.ref` companion — the same
 * shape every engine exposes, so switching clouds is one line.
 *
 * ```ts
 * export const ApiWorker = Rivet.Worker(Api, { ... }, ApiLive);
 * export const WebWorker = Rivet.Worker(Web, { ... },
 *   WebLive.pipe(Layer.provide(Rivet.Worker.ref(Api))));
 * ```
 *
 * The worker class is passed explicitly because `Layer.provide` returns a
 * fresh layer, so an annotation on the layer would not survive a binder's
 * `.pipe(...)`. It mirrors the resource form's leading `id: string`; here
 * the id is the tag.
 */
const deployWorker = <Self, WOut, RIn>(
  cls: Effect.Effect<WOut, never, any>,
  props: RivetWorkerProps,
  layer: Layer.Layer<Self, never, RIn | WorkerTarget | HostRef>,
): Layer.Layer<
  Self | DeploymentService<WOut, "rivet">,
  never,
  Exclude<RIn, WorkerTarget | HostRef>
> => {
  const clsId = resolveWorkerRef(cls as any).LogicalId;
  const selfRef = Layer.sync(HostRef, () => ({
    kind: RIVET_ENGINE,
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
    Deployment<WOut, "rivet">(RIVET_ENGINE, clsId),
    Effect.gen(function* () {
      const worker = yield* cls as unknown as Effect.Effect<WOut, never, never>;
      return { kind: RIVET_ENGINE as "rivet", worker };
    }),
  );
  return deployment.pipe(Layer.provideMerge(deployed)) as Layer.Layer<
    Self | DeploymentService<WOut, "rivet">,
    never,
    Exclude<RIn, WorkerTarget | HostRef>
  >;
};

/**
 * Assert — and prove — that `cls` is deployed to Rivet, yielding the
 * platform-agnostic {@link HostRef} a binder requires. Only the Rivet
 * deploy module for this worker can discharge the `Deployment`
 * requirement, so a binder pointed at a worker hosted elsewhere fails to
 * compile.
 */
const workerRef = <WOut>(
  cls: Effect.Effect<WOut, never, any>,
): Layer.Layer<HostRef, never, DeploymentService<WOut, "rivet">> =>
  Layer.effect(
    HostRef,
    Effect.gen(function* () {
      const clsId = resolveWorkerRef(cls as any).LogicalId;
      const { urlKey, secretKey } = workerConnectionKeys(clsId);
      const base = {
        kind: RIVET_ENGINE,
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
      const deployment = yield* Deployment<WOut, "rivet">(RIVET_ENGINE, clsId);
      return { ...base, worker: deployment.worker };
    }),
  );

export const Worker = Object.assign(deployWorker, { ref: workerRef });
