import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import type { InputProps } from "../Input.ts";
import type { Named, Tag } from "../Named.ts";
import { Platform, type PlatformProps } from "../Platform.ts";
import * as Provider from "../Provider.ts";
import { isResourceOfType, type Resource } from "../Resource.ts";
import type { BaseRuntimeContext } from "../RuntimeContext.ts";
import { CurrentFleet } from "./FleetContext.ts";
import { Host, type FleetBucket } from "./Host.ts";
import type { Providers } from "./Providers.ts";

export const FleetTypeId = "Celld.Fleet";
export type FleetTypeId = typeof FleetTypeId;

export interface FleetProps extends PlatformProps {
  /**
   * Number of fleet nodes — a fixed count, or an autoscaling range. The
   * object form composes a CPU target-tracking policy on the node compute
   * (`targetCpu` percent, default 60); the plain number pins a fixed count.
   * @default 2
   */
  instances?:
    | number
    | {
        /** Minimum node count the host may scale in to. */
        min: number;
        /** Maximum node count the host may scale out to. */
        max: number;
        /** Target average CPU utilization (percent). @default 60 */
        targetCpu?: number;
      };
  /**
   * Container image the fleet's nodes run.
   * @default the pinned celld image digest
   */
  image?: string;
  /**
   * CPU units per node, as the host's compute platform counts them
   * (Fargate: 256, 512, 1024, …).
   * @default 512
   */
  cpu?: number;
  /**
   * Memory per node (MiB).
   * @default 1024
   */
  memory?: number;
  /**
   * CPU architecture of the node compute. The default celld image is
   * multi-arch; pick the architecture the host's compute offers cheapest.
   * @default "ARM64"
   */
  cpuArchitecture?: "ARM64" | "X86_64";
  /**
   * Bring your own network: the VPC and subnets the fleet nodes run in,
   * plus the security group(s) admitting fleet traffic on port 8080. When
   * omitted the host composes a dedicated network. Public ingress
   * (`Celld.Worker`'s `expose`) needs public subnets in at least two
   * Availability Zones.
   */
  vpc?: {
    vpcId: string;
    subnetIds: string[];
    securityGroupIds: string[];
  };
  /** Tags applied to host-composed cloud resources. */
  tags?: Record<string, string>;
  /** Written by the host's `compose` — never set manually. @internal */
  bucket?: FleetBucket;
  /** Written by the host's `compose` — never set manually. @internal */
  fleetUrl?: string;
  /** Written by the host's `compose` — never set manually. @internal */
  hostState?: Record<string, any>;
}

export interface Fleet extends Resource<
  FleetTypeId,
  FleetProps,
  {
    /** The HTTP endpoint network-attached callers reach the fleet on. */
    fleetUrl: string;
    /** The S3-compatible bucket backing the fleet. */
    bucket: FleetBucket;
    /** Host-specific state (compute identifiers, network attachment). */
    hostState: Record<string, any> | undefined;
  },
  {},
  Providers
> {}

export const isFleet = <T>(value: T): value is T & Fleet =>
  isResourceOfType(value, FleetTypeId);

/** No `Celld.Host` Layer is in the stack's providers. */
export class HostNotProvided extends Data.TaggedError("Celld.HostNotProvided")<{
  readonly message: string;
}> {}

/** Resolve the ambient {@link Host}, failing with setup guidance when absent. */
export const requireHost = (
  id: string,
): Effect.Effect<Host["Service"], HostNotProvided> =>
  Effect.serviceOption(Host).pipe(
    Effect.flatMap(
      Option.match({
        onSome: Effect.succeed,
        onNone: () =>
          Effect.fail(
            new HostNotProvided({
              message:
                `Celld.Fleet '${id}' has no host — provide one alongside the ` +
                "providers, e.g. " +
                "`Layer.mergeAll(AWS.providers(), Celld.providers(), Celld.EcsFleet())`.",
            }),
          ),
      }),
    ),
  );

/**
 * Compose the fleet's platform-specific children (bucket, network, node
 * compute) through the ambient {@link Host} and rewrite the props with the
 * connection material. A no-op at runtime.
 */
const transformFleetProps = (
  id: string,
  props: FleetProps,
): Effect.Effect<FleetProps, HostNotProvided, any> =>
  Effect.gen(function* () {
    // Composition is a plan/deploy concern — never runs inside bundles.
    if (globalThis.__ALCHEMY_RUNTIME__) {
      return props;
    }
    const host = yield* requireHost(id);
    const composed = yield* host.compose({ id, props });
    return {
      ...props,
      bucket: composed.bucket,
      fleetUrl: composed.fleetUrl,
      hostState: composed.hostState,
    } as FleetProps;
  });

/** A fleet carries no code — there is nothing to serve at init. */
const makeFleetContext = (id: string): BaseRuntimeContext => ({
  Type: FleetTypeId,
  id,
  env: {},
  get: () => Effect.succeed(undefined),
  set: (key) => Effect.succeed(key),
});

/**
 * A fleet takes no impl (it carries no code), so its class surface adds the
 * tag + props forms the generic `Platform` type lacks.
 */
export type FleetClass = {
  /** Select a fleet for declarations in this Layer's scope. */
  layer<E, R>(ref: Effect.Effect<Fleet, E, R>): Layer.Layer<CurrentFleet, E, R>;
  <Self>(): {
    <const Id extends string>(
      id: Id,
      props?: InputProps<FleetProps>,
    ): Effect.Effect<Fleet, never, Providers> &
      Named<Id> & {
        new (_: never): Named<Id> & Tag<FleetTypeId>;
      };
  };
  (
    id: string,
    props?: InputProps<FleetProps>,
  ): Effect.Effect<Fleet, never, Providers>;
} & Platform<Fleet, never, void, BaseRuntimeContext>;

/**
 * A **Celld fleet**: the infrastructure a `Celld.Worker` runs on. Fleet
 * nodes embed V8 and coordinate through an S3-compatible bucket
 * ([celld](https://github.com/denoland/celld)); cells (Durable Object
 * instances) replicate their SQLite state to the bucket before
 * acknowledging writes.
 *
 * The fleet is platform-agnostic: WHERE the nodes run (and which bucket
 * backs them) is owned by the `Celld.Host` Layer composed alongside the
 * providers. `Celld.EcsFleet()` uses ECS Fargate by default; the EC2 capacity
 * option provides dedicated Docker hosts for experimental Containers and Sandbox.
 * The fleet carries no code. Workers stage immutable artifacts through object
 * storage APIs; {@link Celld.Application} publishes and activates the selected graph.
 * Neither Wrangler nor `celld deploy` is invoked.
 *
 * ### v0.5.0 capabilities and limits <!-- api-prose -->
 * Celld embeds V8 rather than workerd. This integration targets the pinned
 * v0.5.0 runtime and is not a general Cloudflare API implementation.
 *
 * - {@link Celld.KV.Namespace}, {@link Celld.D1.Database}, {@link Celld.R2.Bucket},
 *   {@link Celld.Queues.Queue}, {@link Celld.DurableObject}, {@link Celld.Workflow},
 *   {@link Celld.cron}, {@link Celld.Assets}, {@link Celld.Fetch}, and
 *   {@link Celld.WorkerLoader} use Celld's native runtime interfaces.
 * - R2 buckets are isolated keyspaces in the fleet's backing object store,
 *   rather than independently provisioned S3 buckets.
 * - Queues support producers and push consumers, not a pull-consumer API.
 * - Native service bindings expose fetch. Cross-host RPC is a separate Alchemy
 *   gateway capability and must target the activated Application entrypoint.
 * - Publication writes multiple objects in order under an exclusive lock; it
 *   is not a multi-object atomic transaction. Activation verifies a locked
 *   graph generation, not cron delivery or completion of previously admitted work.
 * - Persistent data and ownership records are retained by default. Removing
 *   declarations is not authorization to erase data or transfer ownership.
 * - Keep Durable Object class names stable. Class history does not migrate
 *   stored data between renamed classes.
 * - Containers and Sandbox require EC2 capacity. Fargate rejects them. Changing
 *   or removing cached container specifications requires explicit retirement;
 *   an isolate reload alone is insufficient.
 * - Persistent Cache API, AI, Vectorize, Hyperdrive, browser rendering, email,
 *   Python Workers, and a CDN are not supplied by this integration.
 *
 * ### Creating a Fleet
 * **Example:** A two-node fleet on ECS Fargate
 * ```typescript
 * import * as Alchemy from "alchemy";
 * import * as AWS from "alchemy/AWS";
 * import * as Celld from "alchemy/Celld";
 * import * as Layer from "effect/Layer";
 *
 * export class Cells extends Celld.Fleet<Cells>()("Cells", {
 *   instances: 2,
 * }) {}
 *
 * const stack = Alchemy.Stack("app", {
 *   providers: Layer.mergeAll(AWS.providers(), Celld.providers(), Celld.EcsFleet()),
 *   state: AWS.state(),
 * });
 * ```
 *
 * ### Selecting a Fleet
 * **Example:** Scope persistent declarations to a fleet
 * ```typescript
 * const storage = Effect.gen(function* () {
 *   const cache = yield* Celld.KV.Namespace("Cache");
 *   const files = yield* Celld.R2.Bucket("Files");
 *   const work = yield* Celld.Queues.Queue("Work");
 *   return { cache, files, work };
 * }).pipe(Effect.provide(Celld.Fleet.layer(Cells)));
 * ```
 *
 * Nested layers may select different fleets when their declarations use
 * distinct Alchemy namespaces. No last-created or global default fleet exists.
 *
 * ### Sizing the Nodes
 * **Example:** Autoscaling range on larger tasks
 * ```typescript
 * export class Cells extends Celld.Fleet<Cells>()("Cells", {
 *   instances: { min: 2, max: 6, targetCpu: 60 },
 *   cpu: 1024,
 *   memory: 2048,
 *   cpuArchitecture: "X86_64",
 * }) {}
 * ```
 *
 * ### Bringing Your Own Network
 * **Example:** Nodes in an existing VPC
 * ```typescript
 * export class Cells extends Celld.Fleet<Cells>()("Cells", {
 *   vpc: {
 *     vpcId: network.vpcId,
 *     subnetIds: network.publicSubnetIds,
 *     securityGroupIds: [fleetSecurityGroup.groupId],
 *   },
 * }) {}
 * ```
 *
 * ### Publishing Workers
 * **Example:** An entrypoint and a background Worker
 * ```typescript
 * const app = Effect.gen(function* () {
 *   return yield* Celld.Application("App", { entrypoint: Api, workers: [Jobs] });
 * }).pipe(
 *   Effect.provide(
 *     Layer.mergeAll(ApiLive, JobsLive).pipe(
 *       Layer.provideMerge(Celld.Fleet.layer(Cells)),
 *     ),
 *   ),
 * );
 * ```
 * All members must belong to the selected fleet. Only the entrypoint may expose
 * public ingress. Service bindings and queue attachments select other members;
 * they do not give those Workers separate public URLs.
 *
 * @resource
 * @product Celld
 */
export const Fleet: FleetClass = Platform(
  FleetTypeId,
  {
    createRuntimeContext: makeFleetContext,
    transformProps: transformFleetProps,
  },
  {
    layer: <E, R>(
      ref: Effect.Effect<Fleet, E, R>,
    ): Layer.Layer<CurrentFleet, E, R> => Layer.effect(CurrentFleet, ref),
  },
) as FleetClass;

/** The fleet's connection material was never composed (no host ran). */
export class FleetNotComposed extends Data.TaggedError(
  "Celld.FleetNotComposed",
)<{
  readonly message: string;
}> {}

export const FleetProvider = () =>
  Provider.succeed(Fleet, {
    // The connection material never changes across an update (the Cloud
    // Map name, the bucket, the compute identifiers) — only a replacement
    // mints new ones — so consumers' diffs see resolved values.
    stables: ["bucket", "fleetUrl", "hostState"],

    read: ({ output }) => Effect.succeed(output),

    // The fleet's physical substance lives in the host-composed children —
    // this resource just persists the connection material they produced.
    reconcile: ({ id, news }) =>
      Effect.gen(function* () {
        if (news.bucket === undefined || news.fleetUrl === undefined) {
          return yield* Effect.fail(
            new FleetNotComposed({
              message: `Celld.Fleet '${id}' has no composed host state — is a Celld.Host Layer in the stack's providers?`,
            }),
          );
        }
        return {
          fleetUrl: news.fleetUrl,
          bucket: news.bucket,
          hostState: news.hostState,
        };
      }),

    delete: () => Effect.void,
  });
