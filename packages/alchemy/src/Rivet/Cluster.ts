import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import type * as Redacted from "effect/Redacted";
import type { InputProps } from "../Input.ts";
import type { Named, Tag } from "../Named.ts";
import { Platform, type PlatformProps } from "../Platform.ts";
import * as Provider from "../Provider.ts";
import { Resource, isResourceOfType } from "../Resource.ts";
import type { BaseRuntimeContext } from "../RuntimeContext.ts";
import { Host, type CpuArchitecture, type HostService } from "./Host.ts";
import type { Providers } from "./Providers.ts";

export const ClusterTypeId = "Rivet.Cluster";
export type ClusterTypeId = typeof ClusterTypeId;

/** No `Rivet.Host` layer is merged into the stack's providers. */
export class RivetHostNotProvided extends Data.TaggedError(
  "RivetHostNotProvided",
)<{
  readonly resourceId: string;
  readonly message: string;
}> {}

/** The Cluster reached reconcile without the host's composed connection material. */
export class RivetClusterNotComposed extends Data.TaggedError(
  "RivetClusterNotComposed",
)<{
  readonly clusterId: string;
  readonly message: string;
}> {}

/**
 * Resolve the ambient {@link Host}, or fail with setup guidance naming the
 * resource that needs it.
 */
export const requireHost = (
  resourceId: string,
): Effect.Effect<HostService, RivetHostNotProvided> =>
  Effect.serviceOption(Host).pipe(
    Effect.flatMap((host) =>
      host._tag === "Some"
        ? Effect.succeed(host.value)
        : Effect.fail(
            new RivetHostNotProvided({
              resourceId,
              message:
                `'${resourceId}' needs a Rivet host but none is provided — merge ` +
                "one into the stack's providers, e.g. " +
                "`providers: Layer.mergeAll(AWS.providers(), Rivet.providers(), Rivet.Ecs())`.",
            }),
          ),
    ),
  );

export interface ClusterProps extends PlatformProps {
  /**
   * Number of engine nodes. Only meaningful with a multi-node storage
   * backend — the built-in RocksDB backend is single-node.
   * @default 1
   */
  instances?: number;
  /**
   * The Rivet Engine release the default image is pinned to.
   * @default DEFAULT_RIVET_VERSION
   */
  rivetVersion?: string;
  /**
   * Full engine image override (escape hatch past {@link rivetVersion}).
   * @default `rivetdev/engine:${rivetVersion}`
   */
  image?: string;
  /**
   * Bring your own network: subnets the engine nodes (and VPC-attached
   * callers) run in, plus the security group(s) admitting engine traffic
   * on the guard and api-peer ports. When omitted the host composes a
   * dedicated network.
   */
  vpc?: {
    vpcId: string;
    subnetIds: string[];
    securityGroupIds: string[];
  };
  /**
   * PostgreSQL connection URL for durable, multi-node-capable storage
   * (`RIVET__POSTGRES__URL`). When omitted the engine uses its built-in
   * single-node RocksDB store on the node's ephemeral disk, and
   * {@link instances} must stay `1`.
   */
  postgresUrl?: string;
  /**
   * Public origin clients use to reach this datacenter
   * (`topology.datacenters.default.public_url`). Defaults to the
   * network-internal discovery URL.
   */
  publicUrl?: string;
  /** Engine node CPU units. @default 1024 */
  cpu?: number;
  /** Engine node memory (MiB). @default 2048 */
  memory?: number;
  /** CPU architecture the engine nodes run on. @default "X86_64" */
  cpuArchitecture?: CpuArchitecture;
  /** Tags applied to host-composed cloud resources. */
  tags?: Record<string, string>;
  /** Written by the host's `compose` — never set manually. @internal */
  endpoint?: string;
  /** Written by the host's `compose` — never set manually. @internal */
  adminToken?: Redacted.Redacted<string>;
  /** Written by the host's `compose` — never set manually. @internal */
  hostState?: Record<string, any>;
}

export interface Cluster extends Resource<
  ClusterTypeId,
  ClusterProps,
  {
    /** The HTTP endpoint callers reach the engine's guard service on. */
    endpoint: string;
    /** The engine's admin token (auths the management APIs and runners). */
    adminToken: Redacted.Redacted<string>;
    /** Host-specific state (compute identifiers, network attachment). */
    hostState: Record<string, any> | undefined;
  },
  {},
  Providers
> {}

export const isCluster = <T>(value: T): value is T & Cluster =>
  isResourceOfType(value, ClusterTypeId);

/**
 * Compose the cluster's platform-specific children (network, engine
 * compute, discovery, admin token) through the ambient {@link Host} and
 * rewrite the props with the connection material. A no-op at runtime.
 */
const transformClusterProps = (
  id: string,
  props: ClusterProps,
): Effect.Effect<ClusterProps, unknown, any> =>
  Effect.gen(function* () {
    // Composition is a plan/deploy concern — never runs inside bundles.
    if (globalThis.__ALCHEMY_RUNTIME__) {
      return props;
    }
    const host = yield* requireHost(id);
    const composed = yield* host.compose({ id, props });
    return {
      ...props,
      endpoint: composed.endpoint,
      adminToken: composed.adminToken,
      hostState: composed.hostState,
    } as ClusterProps;
  });

/** A cluster carries no code — there is nothing to serve at init. */
const makeClusterContext = (id: string): BaseRuntimeContext => ({
  Type: ClusterTypeId,
  id,
  env: {},
  get: () => Effect.succeed(undefined),
  set: (key) => Effect.succeed(key),
});

/**
 * A cluster takes no impl (it carries no code), so its class surface adds
 * the tag + props forms the generic `Platform` type lacks.
 */
export type ClusterClass = {
  <Self>(): {
    <const Id extends string>(
      id: Id,
      props?: InputProps<ClusterProps>,
    ): Effect.Effect<Cluster, never, Providers> &
      Named<Id> & {
        new (_: never): Named<Id> & Tag<ClusterTypeId>;
      };
  };
  (
    id: string,
    props?: InputProps<ClusterProps>,
  ): Effect.Effect<Cluster, never, Providers>;
} & Platform<Cluster, never, void, BaseRuntimeContext>;

/**
 * A **Rivet cluster**: the [Rivet Engine](https://rivet.dev) (the actor
 * orchestrator) a {@link Worker} runs against — infrastructure only, no
 * user code. Runners (the processes executing `Cloudflare.DurableObject`
 * actors) connect OUT to the engine; deploying a `Rivet.Worker` composes
 * a runner deployment against this cluster.
 *
 * WHERE the engine runs is owned by the `Rivet.Host` layer merged into the
 * stack's providers (`Rivet.Ecs()` runs it on AWS ECS Fargate); the
 * cluster persists the connection material the host composes.
 *
 * ### Creating a Cluster
 * **Example:** Cluster on AWS ECS
 * ```typescript
 * import * as Alchemy from "alchemy";
 * import * as AWS from "alchemy/AWS";
 * import * as Rivet from "alchemy/Rivet";
 * import * as Effect from "effect/Effect";
 * import * as Layer from "effect/Layer";
 *
 * export class Actors extends Rivet.Cluster<Actors>()("Actors") {}
 *
 * export const stack = Alchemy.Stack(
 *   "app",
 *   {
 *     providers: Layer.mergeAll(AWS.providers(), Rivet.providers(), Rivet.Ecs()),
 *     state: AWS.state(),
 *   },
 *   Effect.gen(function* () {
 *     const actors = yield* Actors;
 *     return { endpoint: actors.endpoint };
 *   }),
 * );
 * ```
 *
 * **Example:** Durable multi-node storage
 * ```typescript
 * export class Actors extends Rivet.Cluster<Actors>()("Actors", {
 *   postgresUrl: "postgres://user:pass@db.internal:5432/rivet",
 *   instances: 2,
 * }) {}
 * ```
 *
 * ### Bringing your own network
 * **Example:** Engine nodes in an existing VPC
 * ```typescript
 * export class Actors extends Rivet.Cluster<Actors>()("Actors", {
 *   vpc: {
 *     vpcId: "vpc-0123",
 *     subnetIds: ["subnet-a", "subnet-b"],
 *     securityGroupIds: ["sg-engine"],
 *   },
 * }) {}
 * ```
 *
 * @resource
 * @product Rivet
 */
export const Cluster: ClusterClass = Platform(ClusterTypeId, {
  createRuntimeContext: makeClusterContext,
  transformProps: transformClusterProps,
}) as ClusterClass;

export const ClusterProvider = () =>
  Provider.succeed(Cluster, {
    read: ({ output }) => Effect.succeed(output),

    // The cluster's physical substance lives in the host-composed children —
    // this resource just persists the connection material they produced.
    reconcile: ({ id, news }) =>
      news.endpoint === undefined || news.adminToken === undefined
        ? Effect.fail(
            new RivetClusterNotComposed({
              clusterId: id,
              message:
                `Rivet.Cluster '${id}' has no composed connection material — ` +
                "the Rivet host's `compose` did not run for it.",
            }),
          )
        : Effect.succeed({
            endpoint: news.endpoint,
            adminToken: news.adminToken,
            hostState: news.hostState,
          }),

    delete: () => Effect.void,
  });
