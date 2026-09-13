import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Binding from "../Binding.ts";
import { isResolved } from "../Diff.ts";
import type { InputProps } from "../Input.ts";
import * as Output from "../Output.ts";
import { Platform } from "../Platform.ts";
import * as Provider from "../Provider.ts";
import type { Resource, ResourceBinding } from "../Resource.ts";
import { packEnvValue } from "../RuntimeContext.ts";
import { Stack } from "../Stack.ts";
import { createInternalTags } from "../Tags.ts";
import { asEffect } from "../Util/types.ts";
import { isDurableObjectHost } from "../Workers/DurableObject.ts";
import type {
  WorkerServices,
  WorkerShape,
} from "../Cloudflare/Workers/Worker.ts";
import type { WorkerRuntimeContext } from "../Cloudflare/Workers/WorkerRuntimeContext.ts";
import { makeWorkerRuntimeContext } from "../Cloudflare/Workers/WorkerRuntimeContext.ts";
import { requireHost, type Cluster } from "./Cluster.ts";
import { durableObjectBinding, durableObjectStub } from "./DurableObject.ts";
import {
  makeRivetActorClient,
  RIVET_ACTOR_NAMESPACE,
  RIVET_RUNNER_POOL,
  formatRivetEndpoint,
  type RivetDurableObjectNamespaceClient,
} from "./Gateway.ts";
import type { CpuArchitecture, RunnerNames, RunnerSource } from "./Host.ts";
import type { Providers } from "./Providers.ts";
import { makeRivetRunnerEntry } from "./RunnerEntry.ts";

export const RivetWorkerTypeId = "Rivet.Worker";
export type RivetWorkerTypeId = typeof RivetWorkerTypeId;

/**
 * `expose` / `domain` were set on a `Rivet.Worker`. The engine's data
 * plane has no caller guard, so the gateway is never exposed beyond the
 * engine's private network.
 */
export class RivetWorkerExposureRefused extends Data.TaggedError(
  "RivetWorkerExposureRefused",
)<{
  readonly workerId: string;
  readonly message: string;
}> {}

/** A `Rivet.Worker` reached its lifecycle without a cluster connection. */
export class RivetWorkerNotAttached extends Data.TaggedError(
  "RivetWorkerNotAttached",
)<{
  readonly workerId: string;
  readonly message: string;
}> {}

/** The public props of a `Rivet.Worker`. */
export interface RivetWorkerProps {
  /** The {@link Cluster} this worker's runner connects to. */
  cluster: Effect.Effect<Cluster, never, any>;
  /** Entry module of the worker bundle, usually `import.meta.url`. */
  main: string;
  /**
   * Environment image the bundled runner is layered onto (must run bun).
   * @default "oven/bun:1"
   */
  image?: string;
  /**
   * The rivetkit release installed into the runner image.
   * @default DEFAULT_RIVETKIT_VERSION
   */
  rivetkitVersion?: string;
  /** Runner task CPU units. @default 512 */
  cpu?: number;
  /** Runner task memory (MiB). @default 1024 */
  memory?: number;
  /** Number of runner instances. @default 1 */
  desiredCount?: number;
  /**
   * CPU architecture the runner image is built for and runs on.
   * @default "X86_64"
   */
  cpuArchitecture?: CpuArchitecture;
  /** Bundler configuration overrides (`Bundle.BundleConfig`). */
  build?: unknown;
  /**
   * Refused at plan time with {@link RivetWorkerExposureRefused}: the Rivet
   * Engine's data plane enforces no caller token, so the actor gateway is
   * only ever reachable from inside the engine's private network (attach
   * callers with {@link bindWorker}).
   */
  expose?: "public" | "private";
  /**
   * Refused at plan time with {@link RivetWorkerExposureRefused} — see
   * {@link expose}.
   */
  domain?: string;
}

/**
 * The persisted Props of the `Rivet.Worker` resource: the deploy config
 * plus the cluster connection material resolved by the props transform
 * (attribute Outputs of the Cluster — resolved to plain values by
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
  /** CPU architecture the runner image is built for and runs on. */
  cpuArchitecture?: CpuArchitecture;
  /** Bundler configuration overrides. */
  build?: unknown;
  /** Logical id of the {@link Cluster} this worker's runner connects to. */
  clusterId?: string;
  /** The Rivet Engine endpoint. */
  endpoint?: string;
  /** The cluster admin token (the runner's management-API credential). */
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

/**
 * The binding contract of a `Rivet.Worker`: what bindings registered ON
 * the worker carry (Durable Object class declarations, env vars).
 */
export interface RivetWorkerBindingContract {
  env?: Record<string, any>;
  durableObjects?: { name: string; className: string }[];
}

export interface RivetWorkerAttributes {
  workerName: string;
  /** The worker's reachable URL — the engine endpoint (private network). */
  url: string | undefined;
  /** The Rivet Engine endpoint the runner is connected to. */
  endpoint: string | undefined;
  /** Host-specific connection state copied from the cluster. */
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
  RivetWorkerBindingContract,
  Providers
> {}

/**
 * Resolve the public props into the persisted resource props: copy the
 * cluster's connection material off its attributes. A no-op at runtime —
 * inside the runner only the runtime behaviors matter, and the cluster
 * node must never be touched.
 */
const transformWorkerProps = (
  id: string,
  props: RivetWorkerProps & { isExternal?: boolean },
): Effect.Effect<
  InputProps<RivetWorkerResourceProps>,
  RivetWorkerExposureRefused,
  any
> =>
  Effect.gen(function* () {
    const base: InputProps<RivetWorkerResourceProps> = {
      main: props.main,
      image: props.image,
      rivetkitVersion: props.rivetkitVersion,
      cpu: props.cpu,
      memory: props.memory,
      desiredCount: props.desiredCount,
      cpuArchitecture: props.cpuArchitecture,
      build: props.build,
      isExternal: props.isExternal,
    };
    if (globalThis.__ALCHEMY_RUNTIME__ || props.cluster === undefined) {
      return base;
    }
    if (props.expose !== undefined || props.domain !== undefined) {
      return yield* Effect.fail(
        new RivetWorkerExposureRefused({
          workerId: id,
          message:
            `Rivet.Worker '${id}' sets ${
              props.expose !== undefined ? `expose: "${props.expose}"` : ""
            }${props.expose !== undefined && props.domain !== undefined ? " and " : ""}${
              props.domain !== undefined ? `domain: "${props.domain}"` : ""
            }, but the Rivet Engine's data plane enforces no caller token — ` +
            "an exposed gateway would let anyone on the internet drive the " +
            "actors. The engine stays private to its network; attach callers " +
            "with `Rivet.bindWorker` instead.",
        }),
      );
    }
    // Yielding the cluster references the stack's cluster node (memoized
    // by logical id) and orders it ahead of the worker in the graph; the
    // connection material rides its attribute Outputs.
    const cluster = yield* asEffect(props.cluster);
    return {
      ...base,
      clusterId: cluster.LogicalId,
      endpoint: cluster.endpoint,
      adminToken: cluster.adminToken,
      hostState: cluster.hostState,
    } satisfies InputProps<RivetWorkerResourceProps>;
  });

/**
 * The class surface of {@link Worker} — the native Platform forms
 * (`Rivet.Worker("Id", props, impl)`, the `<Self>()` tag/class forms with
 * `.make(props, impl)`), typed over the public {@link RivetWorkerProps}.
 */
export type RivetWorkerClass = Platform<
  RivetWorker,
  WorkerServices,
  WorkerShape,
  WorkerRuntimeContext,
  {},
  RivetWorkerProps
>;

/**
 * A **Rivet worker**: user code deployed against a {@link Cluster},
 * authored with the same props-and-impl constructor forms a Cloudflare
 * Worker uses and hosting the same `Cloudflare.DurableObject` classes
 * (served as Rivet actors).
 *
 * Nothing is uploaded to the engine: the worker's `main` (plus the
 * generated runner entry) is built into a container image the host keeps
 * running as a **runner** that connects OUT to the engine. The runner has
 * no inbound ports; its actors are reached through the engine's gateway,
 * which only callers inside the engine's private network can reach.
 *
 * ### Deploying a Worker to a Cluster
 * **Example:** Tag + deploy module
 * ```typescript
 * import * as Alchemy from "alchemy";
 * import * as AWS from "alchemy/AWS";
 * import * as Cloudflare from "alchemy/Cloudflare";
 * import * as Rivet from "alchemy/Rivet";
 * import * as Effect from "effect/Effect";
 * import * as Layer from "effect/Layer";
 *
 * export class Actors extends Rivet.Cluster<Actors>()("Actors") {}
 * export class Api extends Rivet.Worker<Api>()("Api") {}
 *
 * export class Counter extends Cloudflare.DurableObject<Counter, CounterShape>()(
 *   "Counter",
 * ) {}
 *
 * export default Api.make(
 *   { cluster: Actors, main: import.meta.url },
 *   Effect.gen(function* () {
 *     yield* Counter;
 *     return {};
 *   }).pipe(Effect.provide(CounterLive)),
 * );
 *
 * export const stack = Alchemy.Stack(
 *   "app",
 *   {
 *     providers: Layer.mergeAll(AWS.providers(), Rivet.providers(), Rivet.Ecs()),
 *     state: AWS.state(),
 *   },
 *   Effect.gen(function* () {
 *     yield* Actors;
 *     const api = yield* Api;
 *     return { endpoint: api.endpoint };
 *   }),
 * );
 * ```
 *
 * ### Calling a Worker's actors from another host
 * **Example:** RPC from a Lambda through the engine gateway
 * ```typescript
 * export default class Caller extends AWS.Lambda.Function<Caller>()(
 *   "Caller",
 *   { main: import.meta.url },
 *   Effect.gen(function* () {
 *     const actors = yield* Rivet.bindWorker(Api);
 *     const counters = actors.durableObject<CounterShape>("Counter");
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const value = yield* counters.getByName("a").increment();
 *         return yield* HttpServerResponse.json({ value });
 *       }),
 *     };
 *   }),
 * ) {}
 * ```
 *
 * ### Sizing the runner
 * **Example:** Bigger tasks, more copies
 * ```typescript
 * export default Api.make(
 *   {
 *     cluster: Actors,
 *     main: import.meta.url,
 *     cpu: 1024,
 *     memory: 2048,
 *     desiredCount: 3,
 *     cpuArchitecture: "ARM64",
 *   },
 *   impl,
 * );
 * ```
 *
 * @resource
 * @product Rivet
 */
export const Worker: RivetWorkerClass = Platform(RivetWorkerTypeId, {
  transformProps: transformWorkerProps,
  createRuntimeContext: (id: string) => ({
    ...makeWorkerRuntimeContext(id),
    Type: RivetWorkerTypeId as any,
    durableObjectBinding,
    durableObjectStub,
  }),
}) as RivetWorkerClass;

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
  cpuArchitecture: news.cpuArchitecture,
});

/** The env every active binding on the worker contributes (the engine drops deleted ones). */
const collectBindingEnv = (
  bindings: ResourceBinding<RivetWorkerBindingContract>[],
) => {
  const env: Record<string, unknown> = {};
  for (const binding of bindings ?? []) {
    Object.assign(env, binding.data?.env ?? {});
  }
  return env;
};

/**
 * The `Rivet.Worker` provider: the runner deployment lifecycle for
 * workers targeted at a Rivet cluster. Registered by `Rivet.providers()`.
 */
export const RivetWorkerProvider = () =>
  Provider.effect(
    Worker,
    Effect.gen(function* () {
      return {
        read: ({ output }) => Effect.succeed(output),

        diff: ({ id, news, output }) =>
          Effect.gen(function* () {
            if (output === undefined || !isResolved(news)) {
              return undefined;
            }
            const stack = yield* Stack;
            const host = yield* requireHost(id);
            const hash = yield* host.runnerCodeHash({
              source: runnerSource(news),
              bootstrap: makeRivetRunnerEntry(news.exports ?? {}, {
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
        }) {
          const stack = yield* Stack;

          if (news.endpoint === undefined || news.adminToken === undefined) {
            return yield* Effect.fail(
              new RivetWorkerNotAttached({
                workerId: id,
                message:
                  `Rivet.Worker '${id}' has no cluster connection — ` +
                  "declare the cluster on the worker's props: " +
                  "Rivet.Worker(id, { cluster, main }, impl).",
              }),
            );
          }

          const host = yield* requireHost(id);

          // Rivet drains actors on lower versions once a higher one
          // registers — the version must strictly increase across deploys,
          // so it derives from the persisted attributes, not the content.
          const envoyVersion = (output?.envoyVersion ?? 0) + 1;

          const env: Record<string, string> = {};
          for (const [key, value] of Object.entries({
            ...news.env,
            ...collectBindingEnv(bindings),
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
            hostState: news.hostState,
            tags: yield* createInternalTags(id),
            output: output?.runner,
            session,
          });

          return {
            workerName: workerName(stack, id),
            url: news.endpoint,
            endpoint: news.endpoint,
            hostState: news.hostState,
            envoyVersion,
            runner: result.runnerState,
            code: { hash: result.codeHash },
          };
        }),

        delete: Effect.fn(function* ({ id, output }) {
          if (output?.runner === undefined) {
            return;
          }
          const host = yield* requireHost(id);
          yield* host.deleteRunner({ output: output.runner });
        }),

        list: () => Effect.succeed([]),
      };
    }),
  );

// ── bindWorker: RPC through the engine gateway ─────────────────────────

/** A host that accepts caller bindings — any binding host except a Durable Object's worker. */
interface CallerHost {
  readonly bind: (
    template: TemplateStringsArray,
    ...args: unknown[]
  ) => (data: {
    vpc: { subnetIds: unknown; securityGroupIds: unknown };
  }) => Effect.Effect<void>;
}

const isCallerHost = (host: unknown): host is CallerHost =>
  host !== undefined &&
  (typeof host === "object" || typeof host === "function") &&
  host !== null &&
  "bind" in host &&
  typeof host.bind === "function" &&
  !isDurableObjectHost(host);

/** The surface every `Rivet.bindWorker` stub carries. */
export interface RivetWorkerClient {
  /**
   * Address a Durable Object namespace (actor) hosted on the worker,
   * through the Rivet Engine's gateway protocol.
   */
  durableObject: <Shape = any>(
    namespace: string,
  ) => RivetDurableObjectNamespaceClient<Shape>;
}

/**
 * Bind a caller host (Lambda Function, ECS task, …) to a {@link Worker}
 * and return the actor-addressing stub — the Rivet mirror of
 * `Cloudflare.Workers.bindWorker` / `Celld.bindWorker`.
 *
 * The Rivet Engine's data plane enforces no caller token, so the binding
 * carries NO secret: the engine's private network is the boundary. At
 * plan, the init effect attaches the caller to that network (subnets +
 * security groups from the worker's host state) and stamps the engine
 * endpoint into the caller's environment; at runtime inside the deployed
 * caller the stub reads the endpoint back and speaks the gateway protocol.
 * Calls outside a bound runtime throw with guidance.
 *
 * **Example:** From a Lambda Function
 * ```typescript
 * const actors = yield* Rivet.bindWorker(Api);
 * const counter = actors.durableObject<CounterShape>("Counter").getByName("a");
 * const value = yield* counter.increment();
 * ```
 *
 * @binding
 * @product Rivet
 */
export const bindWorker = (
  worker: Effect.Effect<RivetWorker, never, any>,
): Effect.Effect<RivetWorkerClient, never, any> =>
  Effect.gen(function* () {
    // At plan this references the stack's worker node (ordering it, and its
    // cluster, ahead of the caller); at runtime it is the attribute accessor.
    const target = yield* asEffect(worker);

    if (!globalThis.__ALCHEMY_RUNTIME__) {
      const host = yield* Binding.Host;
      if (isCallerHost(host)) {
        yield* host.bind`Allow(${host}, Rivet.Worker.Call(${target}))`({
          vpc: {
            subnetIds: target.hostState.pipe(
              Output.map(
                (state: Record<string, any> | undefined) =>
                  (state?.subnetIds as string[] | undefined) ?? [],
              ),
            ),
            securityGroupIds: target.hostState.pipe(
              Output.map(
                (state: Record<string, any> | undefined) =>
                  (state?.securityGroupIds as string[] | undefined) ?? [],
              ),
            ),
          },
        });
      }
    }

    // Stamped onto the caller's environment at plan; read back at runtime
    // (`yield*` on an attribute Output hands back its accessor).
    const endpoint = yield* yield* target.endpoint;

    const durableObject = <Shape = any>(
      namespace: string,
    ): RivetDurableObjectNamespaceClient<Shape> => ({
      getByName: (name: string): Shape => {
        if (endpoint === undefined) {
          throw new Error(
            `Rivet worker '${target.LogicalId}' is not reachable from this host — ` +
              "its engine endpoint is bound at deploy time and only readable " +
              "at runtime inside the deployed caller.",
          );
        }
        return makeRivetActorClient(
          {
            endpoint,
            namespace: RIVET_ACTOR_NAMESPACE,
            pool: RIVET_RUNNER_POOL,
          },
          namespace,
        ).getByName(name) as Shape;
      },
    });

    return { durableObject } satisfies RivetWorkerClient;
  });
