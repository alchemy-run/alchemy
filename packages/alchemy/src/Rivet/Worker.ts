/**
 * The **Rivet deployment** of the portable `Alchemy.Worker`.
 *
 * `Rivet.Worker(cls, { cluster, main }, implOrDefinition)` is the deploy
 * module: it constructs the NATIVE {@link RivetWorker} resource from the
 * cloud-free impl and emits the `Deployment` proof, while
 * `Rivet.Worker.ref(cls)` lets callers bind to the worker — consuming
 * that proof and yielding the platform-agnostic `HostRef`.
 *
 * Rivet inverts celld: the user's actor code runs in their OWN
 * long-running process (a "runner") that connects OUT to the Rivet Engine
 * — nothing is uploaded to the engine. So reconcile builds the user's
 * `main` (plus the generated runner entry) into a container image and
 * keeps it running via the platform's {@link RunnerHost} (`aws-ecs`
 * deploys an ECS service with no inbound ports).
 *
 * @section Deploying a Worker to a Cluster
 * @example
 * ```typescript
 * export class Api extends Alchemy.Worker<Api>()("Api") {}
 *
 * export default Rivet.Worker(
 *   Api,
 *   { cluster: Actors, main: import.meta.url },
 *   Effect.gen(function* () {
 *     yield* Counter;
 *     return {};
 *   }).pipe(Effect.provide(CounterLive)),
 * );
 * ```
 */
import type { DeploymentService, HostRef } from "../Worker/Engine.ts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import { Platform } from "../Platform.ts";
import * as Provider from "../Provider.ts";
import type { Resource, ResourceBinding } from "../Resource.ts";
import { packEnvValue } from "../RuntimeContext.ts";
import { Stack } from "../Stack.ts";
import { asEffect } from "../Util/types.ts";
import { makeWorkerRuntimeContext } from "../Cloudflare/Workers/WorkerRuntimeContext.ts";
import {
  makeWorkerDeploy,
  type WorkerDeployAdapter,
} from "../Worker/Deploy.ts";
import type {
  HostRefService,
  WorkerBindingContract,
} from "../Worker/Engine.ts";
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

export const RivetWorkerTypeId = "Rivet.Worker";
export type RivetWorkerTypeId = typeof RivetWorkerTypeId;

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

/** The public deploy-wrapper props. */
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
 * The persisted Props of the native `Rivet.Worker` resource: the deploy
 * config plus the cluster connection material resolved by the deploy
 * wrapper (attribute Outputs of the Cluster — resolved to plain values by
 * reconcile), plus the env/exports channels the platform machinery fills.
 */
export interface RivetWorkerResourceProps {
  /** Entry module of the worker bundle. */
  main: string;
  /** Environment image the bundled runner is layered onto. */
  image?: string;
  /** The rivetkit release installed into the runner image. */
  rivetkitVersion?: string;
  /** Runner task CPU units. */
  cpu?: number;
  /** Runner task memory (MiB). */
  memory?: number;
  /** Number of runner instances. */
  desiredCount?: number;
  /** Bundler configuration overrides. */
  build?: unknown;
  /** Logical id of the {@link Cluster} this worker's runner connects to. */
  cluster?: string;
  /** The runner host kind (keys the RunnerHost lookup). */
  hostKind?: string;
  /** The Rivet Engine endpoint. */
  endpoint?: string;
  /** The cluster admin token. */
  adminToken?: Redacted.Redacted<string>;
  /** Host-specific connection state copied from the cluster. */
  hostState?: Record<string, any>;
  /** Extra environment variables for the runner. @internal */
  env?: Record<string, any>;
  /** Durable Object / export map, populated from the impl. @internal */
  exports?: Record<string, any>;
  /** @internal */
  isExternal?: boolean;
}

export interface RivetWorkerAttributes {
  workerName: string;
  /** The worker's reachable URL (the engine endpoint). */
  url: string | undefined;
  endpoint: string | undefined;
  adminToken: Redacted.Redacted<string> | undefined;
  hostKind: string | undefined;
  hostState: Record<string, any> | undefined;
  /**
   * Rivet drains actors on lower versions once a higher one registers —
   * the version must strictly increase across deploys, so it derives from
   * the persisted attributes, not the content.
   */
  envoyVersion: number;
  /** Host-specific runner state (ECS service/task identifiers, image). */
  runner: Record<string, any> | undefined;
  code: { hash: string | undefined };
}

export interface RivetWorker extends Resource<
  RivetWorkerTypeId,
  RivetWorkerResourceProps,
  RivetWorkerAttributes,
  WorkerBindingContract
> {}

/**
 * The native `Rivet.Worker` platform resource. Constructed by the deploy
 * wrapper (`Rivet.Worker(cls, props, impl)`) — the platform machinery
 * evaluates the impl (exports, Durable Object registrations); the
 * provider below owns the runner deployment lifecycle.
 */
export const RivetWorkerResource = Platform(RivetWorkerTypeId, {
  // The impl evaluates through the shared worker runtime context (exports
  // and Durable Object registration machinery); the resource Type stamp
  // and the Durable Object flavors differ (the context is Object.assigned
  // onto the instance, where the DO hosting core reads the two engine
  // variation points).
  createRuntimeContext: (id: string) => ({
    ...makeWorkerRuntimeContext(id),
    Type: RivetWorkerTypeId as any,
    // Rivet's worker binding contract carries plain DO declarations, not
    // Cloudflare's `bindings` array.
    durableObjectBinding: (decl: { name: string; className: string }) => ({
      durableObjects: [{ name: decl.name, className: decl.className }],
    }),
    // The synthetic runner environment (see `Runner.ts`) already maps each
    // hosted class to a gateway-backed namespace, so the "native stub" IS
    // the finished stub.
    durableObjectStub: (nativeStub: unknown) => nativeStub,
  }),
});

/** Render a container env value: strings verbatim, everything else packed
 * so the runtime `get` accessor round-trips it (Redacted markers included). */
const renderVar = (value: unknown): string =>
  typeof value === "string"
    ? value
    : Redacted.isRedacted(value)
      ? Redacted.value(value as Redacted.Redacted<any>)
      : packEnvValue(value);

const truncateName = (name: string, maxLength: number) =>
  name.length <= maxLength ? name : name.slice(0, maxLength);

const workerName = (stack: { name: string; stage: string }, id: string) =>
  `${stack.name}-${stack.stage}-${id}`.toLowerCase();

const runnerNames = (
  stack: { name: string; stage: string },
  id: string,
): RunnerNames => {
  const base = `${workerName(stack, id)}-runner`;
  return {
    serviceName: truncateName(base, 255),
    repositoryName: truncateName(base, 255),
    taskFamily: truncateName(base, 255),
    taskRoleName: truncateName(`${workerName(stack, id)}-rnr-task`, 64),
    executionRoleName: truncateName(`${workerName(stack, id)}-rnr-exec`, 64),
    logGroupName: `/ecs/${truncateName(base, 200)}`,
  };
};

const runnerSource = (news: RivetWorkerResourceProps): RunnerSource => ({
  main: news.main,
  build: news.build,
  image: news.image,
  rivetkitVersion: news.rivetkitVersion,
  cpu: news.cpu,
  memory: news.memory,
  desiredCount: news.desiredCount,
});

const collectBindings = (
  bindings: { data?: WorkerBindingContract; action?: string }[],
) => {
  const active = (bindings ?? []).filter(
    (binding) => binding.action !== "delete",
  );
  const durableObjects = new Map<string, { name: string; className: string }>();
  const env: Record<string, unknown> = {};
  for (const binding of active) {
    for (const declaration of binding.data?.durableObjects ?? []) {
      durableObjects.set(declaration.name, declaration);
    }
    Object.assign(env, binding.data?.env ?? {});
  }
  return { durableObjects: [...durableObjects.values()], env };
};

/**
 * The `Rivet.Worker` provider: the runner deployment lifecycle for
 * workers targeted at a Rivet cluster. Registered by `Rivet.providers()`.
 */
export const RivetWorkerProvider = () =>
  Provider.effect(
    RivetWorkerResource as any,
    Effect.gen(function* () {
      return {
        read: ({ output }: { output: Record<string, any> | undefined }) =>
          Effect.succeed(output),

        diff: ({
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
            const stack = yield* Stack;
            const host = yield* findRunnerHost(news.hostKind);
            const hash = yield* host.runnerCodeHash({
              source: runnerSource(news),
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
          session,
          bindings,
        }: {
          id: string;
          news: RivetWorkerResourceProps;
          olds: RivetWorkerResourceProps | undefined;
          output: Record<string, any> | undefined;
          session: { note: (message: string) => Effect.Effect<void> };
          bindings: ResourceBinding<WorkerBindingContract>[];
        }) {
          const stack = yield* Stack;

          if (news.main === undefined) {
            return yield* Effect.die(
              new Error(`Rivet.Worker '${id}' requires a 'main' entry module.`),
            );
          }
          if (
            news.endpoint === undefined ||
            news.adminToken === undefined ||
            news.hostKind === undefined
          ) {
            return yield* Effect.die(
              new Error(
                `Rivet.Worker '${id}' has no cluster connection — ` +
                  "declare the cluster on the deploy wrapper: " +
                  "Rivet.Worker(cls, { cluster, main }, impl).",
              ),
            );
          }

          const host = yield* findRunnerHost(news.hostKind);
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
              endpoint: news.endpoint,
              namespace: RIVET_ACTOR_NAMESPACE,
              token: Redacted.value(news.adminToken),
            }),
            RIVET_POOL: RIVET_RUNNER_POOL,
            RIVET_ENVOY_VERSION: String(envoyVersion),
          });

          yield* session.note("deploying rivet runner");
          const result = yield* host.deployRunner({
            id,
            names: runnerNames(stack, id),
            source: runnerSource(news),
            env,
            bootstrap: makeRivetRunnerEntry(news.exports ?? {}, {
              name: stack.name,
              stage: stack.stage,
            }),
            connection: { hostState: news.hostState },
            tags: {
              "alchemy::stack": stack.name,
              "alchemy::stage": stack.stage,
              "alchemy::id": id,
            },
            output: output?.runner,
            session,
          });

          return {
            workerName: workerName(stack, id),
            url: news.endpoint,
            endpoint: news.endpoint,
            adminToken: news.adminToken,
            hostKind: news.hostKind,
            hostState: news.hostState,
            envoyVersion,
            runner: result.runnerState,
            code: { hash: result.codeHash },
          };
        }),

        delete: Effect.fn(function* ({
          olds,
          output,
        }: {
          id: string;
          olds: RivetWorkerResourceProps;
          output: Record<string, any>;
        }) {
          const kind: string | undefined =
            (output?.hostKind as string | undefined) ?? olds?.hostKind;
          if (kind === undefined || output?.runner === undefined) {
            return;
          }
          const host = yield* findRunnerHost(kind);
          yield* host.deleteRunner({ output: output.runner });
        }),

        list: () => Effect.succeed([]),
      };
    }),
  );

/**
 * The remote-caller stub flavor: speak the Rivet gateway protocol against
 * the engine endpoint + token that the ref's `callerBinding` bound into
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

const callerBinding =
  (): HostRefService["callerBinding"] =>
  ({ worker, host, urlKey, secretKey }) =>
    Effect.gen(function* () {
      const adapter = yield* findClusterHost(worker.Props?.hostKind);
      const fragment = yield* adapter.callerBinding({
        target: { hostState: worker.hostState },
        host,
      });
      return {
        ...fragment,
        env: {
          ...(fragment as { env?: Record<string, unknown> }).env,
          [urlKey]: worker.endpoint,
          [secretKey]: worker.adminToken,
        },
      };
    });

const adapter: WorkerDeployAdapter<"rivet"> = {
  kind: RIVET_ENGINE,
  // No gateway wrap: the runner serves no HTTP — actors are reached
  // through the engine's own gateway protocol.
  remoteDurableObject,
  callerBinding,
  makeNative: (clsId, props: RivetWorkerProps, impl) => {
    const nativeCls = (RivetWorkerResource as any)(clsId);
    // Input-shaped props (cluster attributes are Outputs, resolved to
    // plain values by reconcile) — typed loosely for the platform's
    // InputProps.
    const nativeProps = Effect.gen(function* () {
      const base: Record<string, unknown> = {
        main: props.main,
        image: props.image,
        rivetkitVersion: props.rivetkitVersion,
        cpu: props.cpu,
        memory: props.memory,
        desiredCount: props.desiredCount,
        build: props.build,
      };
      // At runtime the deploy module re-executes inside the runner, where
      // only the runtime behaviors matter — never touch the cluster node.
      if (globalThis.__ALCHEMY_RUNTIME__) {
        return base;
      }
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
      return {
        ...base,
        cluster: clusterClass.LogicalId,
        hostKind: cluster.Props?.hostKind ?? cluster.hostKind,
        endpoint: cluster.endpoint,
        adminToken: cluster.adminToken,
        hostState: cluster.hostState,
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
 * The Rivet **deploy module** form plus its `.ref` companion — the same
 * shape every deploy target exposes, so switching clouds is one line.
 *
 * ```ts
 * export const ApiWorker = Rivet.Worker(Api, { ... }, ApiLive);
 * export const WebWorker = Rivet.Worker(Web, { ... },
 *   WebLive.pipe(Layer.provide(Rivet.Worker.ref(Api))));
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
    props: RivetWorkerProps,
    layer: Layer.Layer<Self, never, RIn | HostRef>,
  ): Layer.Layer<
    Self | DeploymentService<WOut, "rivet">,
    never,
    Exclude<RIn, HostRef>
  >;
  /** Deploy an impl effect directly (single-module form). */
  <WOut, Self, I extends Effect.Effect<any, any, any>>(
    cls: Effect.Effect<WOut, never, any> & {
      make: (impl: I) => Layer.Layer<Self, never, any>;
    },
    props: RivetWorkerProps,
    impl: I,
  ): Layer.Layer<
    Self | DeploymentService<WOut, "rivet">,
    never,
    Extract<Effect.Services<I>, DeploymentService<any, string>>
  >;
  readonly ref: <WOut>(
    cls: Effect.Effect<WOut, never, any>,
  ) => Layer.Layer<HostRef, never, DeploymentService<WOut, "rivet">>;
} = Object.assign(deployWorker as any, { ref: workerRef });
