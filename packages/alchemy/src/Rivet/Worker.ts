/**
 * A **Rivet worker**: user code deployed against a {@link Cluster},
 * authored with the same native props-and-impl constructor forms a
 * Cloudflare Worker uses, hosting the same `Cloudflare.DurableObject`
 * classes (served as Rivet actors).
 *
 * Rivet inverts celld: the user's actor code runs in their OWN
 * long-running process (a "runner") that connects OUT to the Rivet Engine
 * — nothing is uploaded to the engine. So reconcile builds the user's
 * `main` (plus the generated runner entry) into a container image and
 * keeps it running via the platform's {@link RunnerHost} (`aws-ecs`
 * deploys an ECS service with no inbound ports).
 *
 * ### Deploying a Worker to a Cluster
 * **Example:** Tag + deploy module
 * ```typescript
 * export class Actors extends Rivet.Cluster<Actors>()("Actors") {}
 * export class Api extends Rivet.Worker<Api>()("Api") {}
 *
 * export default Api.make(
 *   { cluster: Actors, main: import.meta.url },
 *   Effect.gen(function* () {
 *     yield* Counter;
 *     return {};
 *   }).pipe(Effect.provide(CounterLive)),
 * );
 * ```
 *
 * ### Calling a Worker's actors from another host
 * **Example:** Secure RPC from a Lambda through the engine gateway
 * ```typescript
 * const api = yield* Rivet.bindWorker(Api);
 * const counter = api.durableObject<CounterShape>("Counter").getByName("a");
 * const value = yield* counter.increment();
 * ```
 */
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Binding from "../Binding.ts";
import type { InputProps } from "../Input.ts";
import * as Output from "../Output.ts";
import { Platform } from "../Platform.ts";
import * as Provider from "../Provider.ts";
import type { Resource, ResourceBinding } from "../Resource.ts";
import type { Rpc } from "../Rpc.ts";
import { CurrentRuntimeContext, packEnvValue } from "../RuntimeContext.ts";
import { Stack } from "../Stack.ts";
import { asEffect } from "../Util/types.ts";
import {
  rawEnvValue,
  resolveWorkerRef,
  workerConnectionKeys,
  type WorkerRefLike,
} from "../WorkerConnection.ts";
import { isDurableObjectHost } from "../Cloudflare/Workers/DurableObject.ts";
import type {
  WorkerServices,
  WorkerShape,
} from "../Cloudflare/Workers/Worker.ts";
import type { WorkerRuntimeContext } from "../Cloudflare/Workers/WorkerRuntimeContext.ts";
import { makeWorkerRuntimeContext } from "../Cloudflare/Workers/WorkerRuntimeContext.ts";
import type { Cluster } from "./Cluster.ts";
import {
  makeRivetActorClient,
  RIVET_ACTOR_NAMESPACE,
  RIVET_RUNNER_POOL,
  formatRivetEndpoint,
  type DurableObjectNamespaceClient,
} from "./Gateway.ts";
import type { Providers } from "./Providers.ts";
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

/** The public props of a `Rivet.Worker`. */
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
  /** Bundler configuration overrides. */
  build?: unknown;
  /** Logical id of the {@link Cluster} this worker's runner connects to. */
  clusterId?: string;
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
): Effect.Effect<InputProps<RivetWorkerResourceProps>, unknown, any> =>
  Effect.gen(function* () {
    const base: InputProps<RivetWorkerResourceProps> = {
      main: props.main,
      image: props.image,
      rivetkitVersion: props.rivetkitVersion,
      cpu: props.cpu,
      memory: props.memory,
      desiredCount: props.desiredCount,
      build: props.build,
      isExternal: props.isExternal,
    };
    if (globalThis.__ALCHEMY_RUNTIME__ || props.cluster === undefined) {
      return base;
    }
    // Resolve the cluster and copy its connection material. Yielding the
    // cluster class references the stack's cluster node (memoized by
    // logical id) and orders it ahead of the worker in the graph. The host
    // KIND must be plan-readable (it keys the RunnerHost lookup), so it
    // comes from the cluster's resolved Props, not the attribute Output.
    const clusterClass = resolveClusterRef(props.cluster);
    const cluster = (yield* asEffect(clusterClass as any)) as Cluster & {
      Props?: { hostKind?: string };
    };
    return {
      ...base,
      clusterId: clusterClass.LogicalId,
      hostKind: cluster.Props?.hostKind ?? cluster.hostKind,
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
 * The `Rivet.Worker` platform resource. The impl evaluates through the
 * shared worker runtime context (exports and Durable Object registration
 * machinery); only the resource Type stamp and the Durable Object flavors
 * differ.
 */
export const Worker: RivetWorkerClass = Platform(RivetWorkerTypeId, {
  transformProps: transformWorkerProps,
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
}) as RivetWorkerClass;

/** The provider-registration alias of {@link Worker}. @internal */
export const RivetWorkerResource = Worker;

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
  bindings: { data?: RivetWorkerBindingContract; action?: string }[],
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
          bindings: ResourceBinding<RivetWorkerBindingContract>[];
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
                  "declare the cluster on the worker's props: " +
                  "Rivet.Worker(id, { cluster, main }, impl).",
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

// ── bindWorker: secure RPC through the engine gateway ──────────────────

/** The surface every `Rivet.bindWorker` stub carries. */
export interface RivetWorkerClient {
  /**
   * Address a Durable Object namespace (actor) hosted on the worker,
   * through the Rivet Engine's gateway protocol.
   */
  durableObject: <Shape = any>(
    namespace: string,
  ) => DurableObjectNamespaceClient & {
    getByName: (name: string) => Shape;
  };
}

/**
 * Bind a caller host (Lambda Function, ECS task, …) to a {@link Worker}
 * and return the actor-addressing stub — the Rivet mirror of
 * `Cloudflare.Workers.bindWorker` / `Celld.bindWorker`.
 *
 * At plan, the init effect registers the caller binding on the ambient
 * host: the cluster network attachment (subnets + security groups from the
 * worker's host state) and the worker connection env (engine endpoint +
 * the cluster admin token, both riding the worker's attribute Outputs). At
 * runtime inside the deployed caller, the stub speaks the Rivet gateway
 * protocol against the bound endpoint; calls outside a bound runtime throw
 * with guidance.
 */
export const bindWorker = <Shape = {}>(
  worker:
    | Effect.Effect<RivetWorker & Rpc<Shape>, never, any>
    | Effect.Effect<any, never, any>
    | WorkerRefLike,
): Effect.Effect<RivetWorkerClient> =>
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
        // orders it (and its cluster) ahead of this host in the graph. The
        // connection material rides the worker's attribute Outputs — pure
        // data flow, no host-registry lookup.
        const target = (yield* asEffect(worker as any)) as any;
        yield* (host as any).bind`Allow(${host}, Rivet.Worker.Call(${target}))`(
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
              [urlKey]: target.endpoint,
              [secretKey]: target.adminToken,
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

    const durableObject = <S = any>(namespace: string) => ({
      getByName: (name: string): S => {
        if (url === undefined || secret === undefined) {
          throw new Error(
            `Rivet worker '${workerId}' is not reachable from this host — ` +
              `the worker connection env ('${urlKey}') is bound at deploy ` +
              "time and only readable at runtime inside the deployed caller.",
          );
        }
        return makeRivetActorClient(
          {
            endpoint: url,
            token: secret,
            namespace: RIVET_ACTOR_NAMESPACE,
            pool: RIVET_RUNNER_POOL,
          },
          namespace,
        ).getByName(name) as S;
      },
    });

    return { durableObject } satisfies RivetWorkerClient;
  }) as Effect.Effect<RivetWorkerClient>;
